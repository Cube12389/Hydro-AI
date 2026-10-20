'use strict';

/**
 * Hydro AI 自动答疑插件 v2
 *
 * 特性：
 *  - 多 AI 节点：按能力（普通 / Coder）与负载自动分配任务
 *  - 配置文件驱动，支持热重载（改 config.json 无需重启）
 *  - 可注入自定义提示词（全局 / 分模式 / 单节点）
 *  - 比赛进行中拦截解法类提问
 *  - 赛后题目板块自动附带题面，走 Coder 模型
 *  - 限流、静默时段、板块白/黑名单、关键词触发
 *  - 节点健康检查、失败自动摘除与降级
 *  - 管理员在讨论区用 /ai 指令热控制
 */

const fs = require('fs');
const path = require('path');

const PLUGIN_DIR = __dirname;
const CONFIG_PATH = process.env.AI_CONFIG || path.join(PLUGIN_DIR, 'config.json');
const LOG_DIR = path.join(PLUGIN_DIR, 'logs');

const TYPE_PROBLEM = 10;
const TYPE_DISCUSSION = 21;
const TYPE_DISCUSSION_REPLY = 22;
const TYPE_CONTEST = 30;
const TYPE_NAMES = { 10: 'problem', 20: 'node', 30: 'contest', 40: 'training' };

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

const DEFAULTS = {
    enabled: true,
    bot: { uname: 'ai-assistant', uid: 0 },
    domain: { id: 'system' },
    reply: { prefix: '> 🤖 AI 助手自动回复', showMode: true, maxChars: 4000 },
    trigger: {
        onNewDiscussion: true,
        skipIfHumanReplied: true,
        boards: { include: [], exclude: [] },
        keywords: [],
        ignoreOwners: [],
    },
    polling: { enabled: true, intervalMs: 15000, batch: 30, backfill: false },
    limits: {
        maxAttempts: 2,
        globalConcurrency: 2,
        perUserPerHour: 0,
        maxInputChars: 9000,
        timeoutMs: 300000,
        maxTokens: 1600,
        temperature: 0.3,
    },
    contest: {
        enabled: true,
        blockSolutions: true,
        denyMessage: '比赛期间不提供题解与代码，建议赛后到题目讨论区继续交流。',
    },
    routing: {
        strategy: 'least-inflight',
        fallbackToNormal: true,
        retryPerTask: 2,
        healthCooldownMs: 60000,
        healthProbeIntervalMs: 120000,
    },
    quietHours: { enabled: false, ranges: [] },
    admins: { uids: [], roleRoot: true },
    prompts: { extraSystem: '', general: '', contest: '', problemAfter: '' },
    nodes: [],
};

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
    const out = Array.isArray(base) ? base.slice() : { ...base };
    if (!isPlainObject(override)) return out;
    for (const key of Object.keys(override)) {
        const bv = out[key];
        const ov = override[key];
        if (isPlainObject(bv) && isPlainObject(ov)) out[key] = deepMerge(bv, ov);
        else if (ov !== undefined) out[key] = ov;
    }
    return out;
}

let cfgCache = { mtime: 0, cfg: null, path: '' };
let cfgRef = deepMerge(DEFAULTS, {});
let configWarned = false;

function loadConfig() {
    const p = process.env.AI_CONFIG || CONFIG_PATH;
    try {
        const st = fs.statSync(p);
        if (cfgCache.cfg && cfgCache.mtime === st.mtimeMs && cfgCache.path === p) return cfgCache.cfg;
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        const merged = deepMerge(DEFAULTS, raw);
        cfgCache = { mtime: st.mtimeMs, cfg: merged, path: p };
        return merged;
    } catch (e) {
        if (!configWarned) {
            configWarned = true;
            console.log(`[ai-answer] 配置文件未加载（${p}）：${e.message}，使用默认值`);
        }
        if (cfgCache.cfg) return cfgCache.cfg;
        cfgCache = { mtime: 0, cfg: deepMerge(DEFAULTS, {}), path: p };
        return cfgCache.cfg;
    }
}

function refreshConfig() {
    cfgRef = loadConfig();
    syncNodes(cfgRef);
    return cfgRef;
}

/* ------------------------------------------------------------------ */
/* 日志与审计                                                          */
/* ------------------------------------------------------------------ */

function ts() {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function log(...args) {
    console.log(`[ai-answer] ${ts()}`, ...args);
}

function audit(entry) {
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.appendFileSync(path.join(LOG_DIR, 'audit.log'), `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);
    } catch (e) { /* 审计失败不影响主流程 */ }
}

function models() {
    return global.Hydro.model;
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function parseI18n(raw) {
    if (raw === undefined || raw === null) return '';
    if (typeof raw === 'object') return raw.zh || raw['zh-CN'] || Object.values(raw)[0] || '';
    const text = String(raw).trim();
    if (text.startsWith('{') && text.endsWith('}')) {
        try {
            const obj = JSON.parse(text);
            if (obj && typeof obj === 'object') return obj.zh || obj['zh-CN'] || Object.values(obj)[0] || '';
        } catch (e) { /* 非 JSON */ }
    }
    return text;
}

function clip(text, limit) {
    const s = String(text || '');
    if (!limit || s.length <= limit) return s;
    return `${s.slice(0, limit)}\n\n...(内容过长，已截断)`;
}

/* ------------------------------------------------------------------ */
/* 并发闸门                                                            */
/* ------------------------------------------------------------------ */

const gate = { active: 0, queue: [] };

function makeRelease() {
    let done = false;
    return () => {
        if (done) return;
        done = true;
        gate.active = Math.max(0, gate.active - 1);
        while (gate.queue.length && gate.active < gate.queue[0].limit) {
            const item = gate.queue.shift();
            gate.active += 1;
            item.resolve(makeRelease());
        }
    };
}

function gateAcquire(limit) {
    const cap = Number(limit) > 0 ? Number(limit) : 1;
    if (gate.active < cap) {
        gate.active += 1;
        return Promise.resolve(makeRelease());
    }
    return new Promise((resolve) => gate.queue.push({ resolve, limit: cap }));
}

/* ------------------------------------------------------------------ */
/* 节点管理                                                            */
/* ------------------------------------------------------------------ */

const runtimeNodes = new Map();
let rrCursor = 0;

function normalizeNode(def, idx) {
    const baseURL = String(def.baseURL || def.baseUrl || '').replace(/\/+$/, '');
    const m = def.models || {};
    return {
        name: String(def.name || `node-${idx + 1}`),
        baseURL,
        apiKey: def.apiKey || '',
        enabled: def.enabled !== false,
        weight: Number(def.weight) > 0 ? Number(def.weight) : 1,
        maxConcurrency: Number(def.maxConcurrency) > 0 ? Number(def.maxConcurrency) : 1,
        models: {
            normal: m.normal || m.chat || '',
            coder: m.coder || '',
        },
        extraSystem: def.extraSystem || '',
        healthCheck: def.healthCheck !== false,
    };
}

function syncNodes(cfg) {
    const defs = Array.isArray(cfg.nodes) ? cfg.nodes : [];
    const seen = new Set();
    defs.forEach((raw, idx) => {
        const def = normalizeNode(raw, idx);
        seen.add(def.name);
        const old = runtimeNodes.get(def.name);
        runtimeNodes.set(def.name, {
            def,
            inflight: old ? old.inflight : 0,
            unhealthyUntil: old ? old.unhealthyUntil : 0,
            lastError: old ? old.lastError : '',
            lastUsedAt: old ? old.lastUsedAt : 0,
            ok: old ? old.ok : 0,
            fail: old ? old.fail : 0,
            latencyMs: old ? old.latencyMs : 0,
        });
    });
    for (const name of [...runtimeNodes.keys()]) {
        if (!seen.has(name)) runtimeNodes.delete(name);
    }
}

function selectNode(capability, tried) {
    const cfg = cfgRef;
    const now = Date.now();
    const cands = [];
    for (const rt of runtimeNodes.values()) {
        if (!rt.def.enabled || !rt.def.baseURL) continue;
        if (tried && tried.has(rt.def.name)) continue;
        if (rt.unhealthyUntil > now) continue;
        const model = rt.def.models[capability];
        if (!model) continue;
        if (rt.inflight >= rt.def.maxConcurrency) continue;
        cands.push({ rt, model, capability });
    }

    if (!cands.length) {
        if (capability === 'coder' && cfg.routing.fallbackToNormal) {
            const t = tried ? new Set(tried) : new Set();
            t.add('__fallback__');
            if (!t.has('__fallback-done__')) {
                t.add('__fallback-done__');
                return selectNode('normal', t);
            }
        }
        return null;
    }

    if (cfg.routing.strategy === 'round-robin') {
        cands.sort((a, b) => a.rt.lastUsedAt - b.rt.lastUsedAt);
        const pick = cands[rrCursor % cands.length];
        rrCursor += 1;
        return pick;
    }
    if (cfg.routing.strategy === 'random') {
        return cands[Math.floor(Math.random() * cands.length)];
    }

    // 默认：带权重的「最少在途」
    cands.sort((a, b) => {
        const sa = a.rt.inflight / a.rt.def.weight;
        const sb = b.rt.inflight / b.rt.def.weight;
        if (sa !== sb) return sa - sb;
        return a.rt.def.name.localeCompare(b.rt.def.name);
    });
    return cands[0];
}

async function chatOnce(nodeDef, model, messages, cfg) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.limits.timeoutMs);
    const started = Date.now();
    try {
        const res = await fetch(`${nodeDef.baseURL}/chat/completions`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                ...(nodeDef.apiKey ? { Authorization: `Bearer ${nodeDef.apiKey}` } : {}),
            },
            body: JSON.stringify({
                model,
                messages,
                temperature: cfg.limits.temperature,
                max_tokens: cfg.limits.maxTokens,
            }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = await res.json();
        const content = (data.choices?.[0]?.message?.content || '').trim();
        if (!content) throw new Error('empty completion');
        return { content, latency: Date.now() - started };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 按能力调用模型，失败自动换节点重试。
 * buildMessages(nodeDef) 允许按节点追加专属提示词。
 */
async function callModel(capability, buildMessages) {
    const cfg = cfgRef;
    const tried = new Set();
    const maxTries = Math.max(1, Number(cfg.routing.retryPerTask) || 1);
    let lastErr = null;

    for (let i = 0; i < maxTries; i += 1) {
        const pick = selectNode(capability, tried);
        if (!pick) break;
        tried.add(pick.rt.def.name);
        const release = await gateAcquire(cfg.limits.globalConcurrency);
        pick.rt.inflight += 1;
        pick.rt.lastUsedAt = Date.now();
        try {
            const messages = buildMessages(pick.rt.def);
            const { content, latency } = await chatOnce(pick.rt.def, pick.model, messages, cfg);
            pick.rt.ok += 1;
            pick.rt.latencyMs = latency;
            pick.rt.unhealthyUntil = 0;
            return { content, node: pick.rt.def.name, model: pick.model, latency, capability: pick.capability };
        } catch (e) {
            lastErr = e;
            pick.rt.fail += 1;
            pick.rt.lastError = e.message;
            pick.rt.unhealthyUntil = Date.now() + (Number(cfg.routing.healthCooldownMs) || 60000);
            log(`节点 ${pick.rt.def.name} 调用失败：${e.message}，冷却 ${cfg.routing.healthCooldownMs}ms`);
        } finally {
            pick.rt.inflight -= 1;
            release();
        }
    }
    throw lastErr || new Error('没有可用节点');
}

async function probeNode(rt) {
    const cfg = cfgRef;
    if (!rt.def.healthCheck || !rt.def.baseURL) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const res = await fetch(`${rt.def.baseURL}/models`, {
            signal: controller.signal,
            headers: rt.def.apiKey ? { Authorization: `Bearer ${rt.def.apiKey}` } : {},
        });
        if (res.ok) {
            if (rt.unhealthyUntil) log(`节点 ${rt.def.name} 已恢复`);
            rt.unhealthyUntil = 0;
            rt.lastError = '';
        } else {
            rt.unhealthyUntil = Date.now() + (Number(cfg.routing.healthCooldownMs) || 60000);
            rt.lastError = `probe HTTP ${res.status}`;
        }
    } catch (e) {
        rt.unhealthyUntil = Date.now() + (Number(cfg.routing.healthCooldownMs) || 60000);
        rt.lastError = e.message;
    } finally {
        clearTimeout(timer);
    }
}

async function probeAll() {
    await Promise.all([...runtimeNodes.values()].map((rt) => probeNode(rt).catch(() => {})));
}

/* ------------------------------------------------------------------ */
/* 上下文判定                                                          */
/* ------------------------------------------------------------------ */

async function findRunningContest(domainId, parentType, parentId) {
    if (parentType !== TYPE_PROBLEM) return null;
    const { document } = models();
    const now = new Date();
    const running = await document.getMulti(domainId, TYPE_CONTEST, {
        beginAt: { $lte: now },
        endAt: { $gte: now },
        rule: { $ne: 'homework' },
    }).toArray();
    if (!running.length) return null;
    const pid = Number(parentId);
    return running.find((t) => Array.isArray(t.pids) && t.pids.map(Number).includes(pid)) || null;
}

function boardAllowed(cfg, parentType) {
    const name = TYPE_NAMES[parentType] || String(parentType);
    const exc = cfg.trigger.boards.exclude || [];
    const inc = cfg.trigger.boards.include || [];
    if (exc.some((x) => x === name || Number(x) === parentType)) return false;
    if (inc.length && !inc.some((x) => x === name || Number(x) === parentType)) return false;
    return true;
}

function matchKeywords(cfg, text) {
    const kws = cfg.trigger.keywords || [];
    if (!kws.length) return true;
    return kws.some((k) => k && text.includes(String(k)));
}

function toMinutes(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
}

function inQuietHours(cfg) {
    if (!cfg.quietHours.enabled) return false;
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    for (const range of cfg.quietHours.ranges || []) {
        const [s, e] = String(range).split('-');
        const sm = toMinutes(s);
        const em = toMinutes(e);
        if (sm === null || em === null) continue;
        if (sm <= em ? (cur >= sm && cur < em) : (cur >= sm || cur < em)) return true;
    }
    return false;
}

/* ------------------------------------------------------------------ */
/* Prompt 构造                                                         */
/* ------------------------------------------------------------------ */

const BASE_RULES = [
    '你是 Hydro 在线评测系统的答疑助手，用简体中文回答。',
    '风格：先给结论，再给必要解释；条理清晰，必要时使用 Markdown 与代码块（标注语言）。',
    '不确定的内容要明确说明不确定，绝不编造 API、题号、评测结果或站内不存在的功能。',
    '不要输出与提问无关的寒暄，也不要在结尾反问用户是否还有其他问题。',
].join('\n');

const CONTEST_RULES = [
    '【当前处于比赛进行中，这是最高优先级规则】',
    '严禁给出任何解题思路、算法选择、复杂度分析、关键步骤提示、伪代码或可直接通过评测的代码；',
    '严禁推测测试点、隐藏数据、标程或任何与题目解法相关的内容。',
    '只允许回答：编程环境与语言版本、提交与评测机制、输入输出格式、比赛规则澄清、',
    '以及与具体题目解法无关的通用技术问题（不得结合本题场景）。',
    '若用户询问题目解法或索要代码，礼貌而简短地说明比赛期间不提供题解，建议赛后继续交流。',
    '回答务必简短，避免任何暗示性表述。',
].join('\n');

const CODER_RULES = [
    '【赛后题目答疑模式】',
    '用户的问题与某道题目相关，题面已完整提供在下方。',
    '请基于题面回答：解题思路、算法选择、正确性论证、复杂度分析、常见错误定位。',
    '如果用户提供了代码，请指出其中的具体问题（边界、溢出、复杂度、逻辑错误），并给出修改建议。',
    '给出参考实现时要解释清楚为什么这样写，而不是只贴代码。',
    '如果题面信息不足以回答，明确指出缺少什么信息。',
].join('\n');

const GENERAL_RULES = [
    '【常规答疑模式】',
    '覆盖一般性问题与 Hydro 平台使用 / 技术问题。',
    '涉及平台功能时基于 Hydro 的通用能力作答，不确定的站内配置不要臆断。',
].join('\n');

function buildSystemContent(cfg, mode, nodeDef) {
    const parts = [BASE_RULES];
    if (mode === 'contest') parts.push(CONTEST_RULES, cfg.prompts.contest);
    else if (mode === 'problem-after') parts.push(CODER_RULES, cfg.prompts.problemAfter);
    else parts.push(GENERAL_RULES, cfg.prompts.general);
    if (cfg.prompts.extraSystem) parts.push(cfg.prompts.extraSystem);
    if (nodeDef && nodeDef.extraSystem) parts.push(nodeDef.extraSystem);
    if (mode === 'contest' && cfg.contest.blockSolutions) {
        parts.push(`若用户坚持索要解法，只回复以下内容：${cfg.contest.denyMessage}`);
    }
    return parts.filter(Boolean).join('\n\n');
}

async function loadProblemStatement(domainId, parentId, cfg) {
    const { problem } = models();
    const pdoc = await problem.get(domainId, Number(parentId));
    if (!pdoc) return null;
    const statement = parseI18n(pdoc.content);
    const block = [`题号：${pdoc.docId}`, `标题：${pdoc.title || ''}`, '题面：', statement || '（题面为空）'].join('\n');
    return clip(block, cfg.limits.maxInputChars);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const answered = new Set();
const attempts = new Map();
const inflight = new Set();
const userHits = new Map();
let botCache = null;
const runtime = { paused: false, startedAt: Date.now(), lastReplyId: null, handled: 0, failed: 0 };

async function getBotUser(domainId) {
    if (botCache) return botCache;
    const { user } = models();
    const cfg = cfgRef;
    let udoc = null;
    if (cfg.bot.uid) udoc = await user.getById(domainId, Number(cfg.bot.uid)).catch(() => null);
    if (!udoc) udoc = await user.getByUname(domainId, cfg.bot.uname).catch(() => null);
    if (!udoc) return null;
    botCache = udoc;
    return udoc;
}

function rateLimited(uid, limit) {
    const cap = Number(limit) || 0;
    if (cap <= 0) return false;
    const now = Date.now();
    const arr = (userHits.get(uid) || []).filter((t) => now - t < 3600_000);
    if (arr.length >= cap) {
        userHits.set(uid, arr);
        return true;
    }
    arr.push(now);
    userHits.set(uid, arr);
    return false;
}

async function handleDiscussion(payload) {
    const cfg = refreshConfig();
    if (!cfg.enabled) return;
    if (runtime.paused) return log('已暂停，跳过');

    const domainId = payload.domainId || cfg.domain.id;
    const did = payload.docId;
    if (!did) return;
    const key = String(did);

    // 同步占位必须在任何 await 之前，避免多通道并发重复回复
    if (inflight.has(key) || answered.has(key)) return;
    if ((attempts.get(key) || 0) >= (Number(cfg.limits.maxAttempts) || 1)) return;
    inflight.add(key);
    attempts.set(key, (attempts.get(key) || 0) + 1);

    const release = () => inflight.delete(key);

    try {
        if (!boardAllowed(cfg, payload.parentType)) return release();

        const text = `${payload.title || ''}\n${parseI18n(payload.content)}`;
        if (!matchKeywords(cfg, text)) return release();

        const bot = await getBotUser(domainId);
        if (!bot) return release();
        if (Number(payload.owner) === Number(bot._id)) return release();

        const ignore = (cfg.trigger.ignoreOwners || []).map(Number);
        if (ignore.includes(Number(payload.owner))) return release();

        if (inQuietHours(cfg)) return release();

        if (rateLimited(payload.owner, cfg.limits.perUserPerHour)) {
            log(`用户 ${payload.owner} 触发频率限制`);
            audit({ event: 'rate-limited', uid: payload.owner, did: key });
            return release();
        }

        let mode = 'general';
        let capability = 'normal';

        if (cfg.contest.enabled) {
            const running = await findRunningContest(domainId, payload.parentType, payload.parentId);
            if (running) mode = 'contest';
        }
        if (mode === 'general' && payload.parentType === TYPE_PROBLEM) {
            mode = 'problem-after';
            capability = 'coder';
        }

        log(`did=${key} board=${TYPE_NAMES[payload.parentType] || payload.parentType} mode=${mode} capability=${capability}`);

        const statement = mode === 'problem-after'
            ? await loadProblemStatement(domainId, payload.parentId, cfg).catch((e) => {
                log(`读取题面失败：${e.message}`);
                return null;
            })
            : null;

        const result = await callModel(capability, (nodeDef) => {
            const messages = [{ role: 'system', content: buildSystemContent(cfg, mode, nodeDef) }];
            if (statement) messages.push({ role: 'system', content: `【本题完整题面】\n${statement}` });
            messages.push({
                role: 'user',
                content: `讨论标题：${payload.title || '(无标题)'}\n\n${clip(parseI18n(payload.content), cfg.limits.maxInputChars)}`,
            });
            return messages;
        });

        const modeLabel = mode === 'problem-after' ? '题解模式' : (mode === 'contest' ? '赛时模式' : '通用模式');
        const head = cfg.reply.showMode ? `${cfg.reply.prefix}（${modeLabel}）` : cfg.reply.prefix;
        const body = `${head}\n\n${clip(result.content, cfg.reply.maxChars)}`;

        await models().discussion.addReply(domainId, did, bot._id, body, '127.0.0.1');
        answered.add(key);
        runtime.handled += 1;
        log(`did=${key} 已回复 via ${result.node}/${result.model} ${result.latency}ms`);
        audit({
            event: 'replied', did: key, mode, node: result.node, model: result.model,
            latency: result.latency, uid: payload.owner,
        });
    } catch (e) {
        runtime.failed += 1;
        log(`did=${key} 处理失败：${e.message}`);
        audit({ event: 'failed', did: key, error: e.message });
    } finally {
        release();
    }
}

/* ------------------------------------------------------------------ */
/* 事件通道                                                            */
/* ------------------------------------------------------------------ */

function registerEventListeners(ctx) {
    const handler = (payload) => {
        if (!payload || !payload.docId) return;
        handleDiscussion(payload).catch((e) => log('handler error:', e.message));
    };

    const targets = [];
    const push = (t, name) => {
        if (t && typeof t.on === 'function' && !targets.some((x) => x.t === t)) targets.push({ t, name });
    };
    push(ctx, 'ctx');
    try { push(ctx.root, 'ctx.root'); } catch (e) { /* ignore */ }
    push(global.bus, 'global.bus');

    for (const item of targets) {
        try {
            item.t.on('discussion/add', handler);
            log(`事件监听已注册：${item.name}`);
        } catch (e) {
            log(`事件注册失败 ${item.name}：${e.message}`);
        }
    }
}

/* ------------------------------------------------------------------ */
/* 管理员指令                                                          */
/* ------------------------------------------------------------------ */

async function isAdmin(domainId, uid) {
    const cfg = cfgRef;
    if ((cfg.admins.uids || []).map(Number).includes(Number(uid))) return true;
    if (!cfg.admins.roleRoot) return false;
    try {
        const { user } = models();
        const udoc = await user.getById(domainId, Number(uid));
        if (!udoc) return false;
        if (udoc.role === 'root') return true;
        const PERM = models().builtin && models().builtin.PERM;
        if (PERM && typeof udoc.hasPerm === 'function') return udoc.hasPerm(PERM.PERM_ALL);
    } catch (e) { /* ignore */ }
    return false;
}

function statusText() {
    const cfg = cfgRef;
    const lines = [
        `状态：${cfg.enabled ? (runtime.paused ? '已暂停' : '运行中') : '已禁用'}`,
        `启动时间：${new Date(runtime.startedAt).toLocaleString('zh-CN')}`,
        `已回复：${runtime.handled} 次，失败：${runtime.failed} 次`,
        `并发：${gate.active}/${cfg.limits.globalConcurrency}，排队：${gate.queue.length}`,
        '节点：',
    ];
    for (const rt of runtimeNodes.values()) {
        const down = rt.unhealthyUntil > Date.now() ? `不可用(${rt.lastError})` : '正常';
        const caps = [rt.def.models.normal ? 'normal' : '', rt.def.models.coder ? 'coder' : ''].filter(Boolean).join('+') || '无模型';
        lines.push(`- ${rt.def.name} [${caps}] ${down}，在途 ${rt.inflight}，成功 ${rt.ok}，失败 ${rt.fail}，延迟 ${rt.latencyMs}ms`);
    }
    return lines.join('\n');
}

async function handleAdminCommand(domainId, drdoc) {
    const text = String(drdoc.content || '').trim();
    const m = /^\/ai\s+([a-z]+)/i.exec(text);
    if (!m) return false;
    if (!(await isAdmin(domainId, drdoc.owner))) return false;

    const cmd = m[1].toLowerCase();
    const bot = await getBotUser(domainId);
    if (!bot) return true;
    let replyText = '';

    if (cmd === 'pause') {
        runtime.paused = true;
        replyText = 'AI 答疑已暂停。';
    } else if (cmd === 'resume') {
        runtime.paused = false;
        replyText = 'AI 答疑已恢复。';
    } else if (cmd === 'status') {
        replyText = statusText();
    } else if (cmd === 'reload') {
        cfgCache = { mtime: 0, cfg: null, path: '' };
        refreshConfig();
        replyText = `配置已重载，共 ${runtimeNodes.size} 个节点。`;
    } else if (cmd === 'probe') {
        await probeAll();
        replyText = statusText();
    } else {
        replyText = '可用指令：/ai pause、/ai resume、/ai status、/ai reload、/ai probe';
    }

    await models().discussion.addReply(domainId, drdoc.parentId, bot._id, `${cfgRef.reply.prefix}\n\n${replyText}`, '127.0.0.1');
    log(`管理员指令 ${cmd} by uid=${drdoc.owner}`);
    audit({ event: 'command', cmd, uid: drdoc.owner });
    return true;
}

/* ------------------------------------------------------------------ */
/* 轮询通道                                                            */
/* ------------------------------------------------------------------ */

async function scanReplies(cfg, domainId) {
    const { document } = models();
    const query = runtime.lastReplyId ? { _id: { $gt: runtime.lastReplyId } } : {};
    const docs = await document.getMulti(domainId, TYPE_DISCUSSION_REPLY, query)
        .sort({ _id: 1 }).limit(100).toArray();
    if (!docs.length) return;

    for (const drdoc of docs) {
        runtime.lastReplyId = drdoc._id;
        const bot = await getBotUser(domainId);
        if (bot && Number(drdoc.owner) === Number(bot._id)) continue;
        if (await handleAdminCommand(domainId, drdoc).catch(() => false)) continue;
        if (cfg.trigger.skipIfHumanReplied && drdoc.parentId) answered.add(String(drdoc.parentId));
    }
}

async function pollOnce() {
    const cfg = refreshConfig();
    if (!cfg.enabled) return;
    const domainId = cfg.domain.id;
    try {
        await scanReplies(cfg, domainId);
        if (runtime.paused) return;

        const { document } = models();
        const bot = await getBotUser(domainId);
        if (!bot) return;

        const list = await document.getMulti(domainId, TYPE_DISCUSSION, {})
            .sort({ _id: -1 }).limit(Number(cfg.polling.batch) || 30).toArray();

        for (const ddoc of list) {
            const key = String(ddoc.docId);
            if (answered.has(key) || inflight.has(key)) continue;
            if (Number(ddoc.owner) === Number(bot._id)) continue;
            if (!cfg.polling.backfill) {
                const createdAt = ddoc._id && ddoc._id.getTimestamp ? ddoc._id.getTimestamp().getTime() : 0;
                if (createdAt && createdAt < runtime.startedAt - 5000) {
                    answered.add(key);
                    continue;
                }
            }
            const replies = await document.getMulti(domainId, TYPE_DISCUSSION_REPLY, {
                parentType: TYPE_DISCUSSION, parentId: ddoc._id,
            }).project({ owner: 1 }).toArray();
            if (replies.length) {
                answered.add(key);
                continue;
            }
            await handleDiscussion({
                domainId,
                docId: ddoc.docId,
                parentType: ddoc.parentType,
                parentId: ddoc.parentId,
                owner: ddoc.owner,
                title: ddoc.title,
                content: ddoc.content,
            });
        }
    } catch (e) {
        log(`轮询出错：${e.message}`);
    }
}

let pollTimer = null;
let probeTimer = null;

function startPolling() {
    if (pollTimer) return;
    const cfg = refreshConfig();
    if (!cfg.polling.enabled) return log('轮询已禁用，仅依赖事件通道');
    pollTimer = setInterval(() => { pollOnce().catch(() => {}); }, Number(cfg.polling.intervalMs) || 15000);
    if (pollTimer.unref) pollTimer.unref();
    const kick = setTimeout(() => { pollOnce().catch(() => {}); }, 6000);
    if (kick.unref) kick.unref();
    log(`轮询已启动，间隔 ${cfg.polling.intervalMs}ms`);
}

function startHealthProbe() {
    if (probeTimer) return;
    const cfg = refreshConfig();
    const every = Number(cfg.routing.healthProbeIntervalMs) || 0;
    if (every <= 0) return;
    probeTimer = setInterval(() => { probeAll().catch(() => {}); }, every);
    if (probeTimer.unref) probeTimer.unref();
    setTimeout(() => { probeAll().catch(() => {}); }, 8000).unref?.();
    log(`健康检查已启动，间隔 ${every}ms`);
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

function apply(ctx) {
    refreshConfig();
    registerEventListeners(ctx);
    startPolling();
    startHealthProbe();
    const cfg = cfgRef;
    const nodes = [...runtimeNodes.values()].map((r) => `${r.def.name}(${[r.def.models.normal && 'normal', r.def.models.coder && 'coder'].filter(Boolean).join('+') || '无'})`).join(', ');
    log(`已加载：${runtimeNodes.size} 个节点 [${nodes}]，bot=${cfg.bot.uname}，暂停=${runtime.paused}`);
    if (!runtimeNodes.size) log('警告：未配置任何 AI 节点，请检查 config.json');
}

module.exports = { apply };
module.exports.apply = apply;
