# Hydro AI 自动答疑插件（ai-answer）v2

把本地/多节点 AI 服务接入 Hydro，按板块与比赛状态自动选模型回复答疑讨论。

- 单节点快速上手：改 `config.json` 里 `nodes[0].baseURL` 即可
- 多节点：填多个 `nodes`，插件自动分配任务，故障自动降级
- 配置**热重载**：改完 `config.json` 不用重启，下一轮轮询即生效

---

## 一、目录结构

```
hydro-ai-answer/
├── index.js               # 插件主体
├── config.example.json    # 配置模板（部署时复制为 config.json）
├── package.json
├── README.md
└── deploy/
    ├── deploy.cmd         # ← Windows 一键部署（双击或命令行运行）
    ├── deploy-wsl.sh      # ← WSL 侧实际执行逻辑（被 deploy.cmd 调用）
    ├── install-user.js    # ← 创建/修复 AI 机器人账号
    └── pack.cmd           # ← 打包成 zip
```

## 二、快速部署

### Windows 一键部署

```bat
deploy\deploy.cmd                     :: 默认发行版 Ubuntu-22.04-new
deploy\deploy.cmd Ubuntu-22.04        :: 指定 WSL 发行版
```

脚本自动完成：语法检查 → 复制插件到 `/root/.hydro/addons/ai-answer` → 注册到 `addon.json` → 创建/修复机器人账号 → 重启 Hydro → 健康校验。

> 已存在的 `config.json` 会被**备份并保留**，不会覆盖你的配置。

### WSL 内手动部署

```bash
wsl -d Ubuntu-22.04-new -u root -e bash deploy/deploy-wsl.sh /mnt/e/NOIP/RPA/hydro-ai-answer
```

### 打包分发

```bat
deploy\pack.cmd
:: 产物：dist\hydro-ai-answer-<版本>-<时间戳>.zip
```

## 三、配置文件（核心）

部署后位于 `/root/.hydro/addons/ai-answer/config.json`，也可用环境变量 `AI_CONFIG` 指定路径。

### 3.1 节点定义（多节点 + 按能力选模型）

```jsonc
"nodes": [
  {
    "name": "gpu-1",                         // 唯一名称
    "baseURL": "http://192.168.71.3:8080/v1",
    "apiKey": "",                           // 需要鉴权时填
    "enabled": true,
    "weight": 2,                            // 权重，越大分到越多任务
    "maxConcurrency": 1,                    // 该节点并发上限
    "healthCheck": true,                    // 是否参与 /models 健康探测
    "models": {
      "normal": "Qwen2.5-7B-Instruct-Q4_K_M",       // 普通答疑用
      "coder":  "Qwen2.5-Coder-7B-Instruct-Q4_K_M"  // 赛后题解用（留空表示不承担）
    },
    "extraSystem": ""                       // 该节点专属追加提示词
  },
  {
    "name": "coder-only",
    "baseURL": "http://192.168.71.4:8080/v1",
    "models": { "normal": "", "coder": "Qwen2.5-Coder-32B-Instruct" }
  }
]
```

**模型路由**：普通答疑只挑 `normal` 非空的节点；赛后题解只挑 `coder` 非空的节点。这样可以让大模型节点专职跑 Coder，小模型节点跑日常答疑。

### 3.2 分配策略

```jsonc
"routing": {
  "strategy": "least-inflight",   // least-inflight | round-robin | random
  "fallbackToNormal": true,       // 没有 coder 节点时降级用 normal
  "retryPerTask": 2,              // 失败换节点重试次数
  "healthCooldownMs": 60000,      // 失败节点冷却时长
  "healthProbeIntervalMs": 120000 // 健康探测间隔（0 关闭）
}
```

- `least-inflight`：按 `在途数 / weight` 最小者优先（默认，推荐）
- 节点失败后自动冷却，冷却期内不再分配；探测恢复后自动重新启用

### 3.3 提示词注入（三层叠加）

```jsonc
"prompts": {
  "extraSystem": "",       // 全局，所有模式所有节点都追加
  "general": "",           // 仅通用模式
  "contest": "",           // 仅赛时模式
  "problemAfter": ""       // 仅赛后题解模式
}
```

最终 system prompt 拼接顺序：

```
基础规则 → 模式规则 → prompts.<模式> → prompts.extraSystem → node.extraSystem → [赛时] 拒答话术
```

`node.extraSystem` 用于让某台机器有独立人格/格式，例如给 Coder 节点加「输出前先给算法标签」。

### 3.4 触发控制

```jsonc
"trigger": {
  "boards": { "include": [], "exclude": [] },  // 空 include = 全部；可用 problem/node/contest/training
  "keywords": [],                               // 非空时，标题+正文须命中其一才回复
  "ignoreOwners": [],                           // 这些 uid 发的帖子不回复
  "skipIfHumanReplied": true                   // 有人工回复后不再插话
}
```

### 3.5 限流与保护

```jsonc
"limits": {
  "maxAttempts": 2,          // 同一帖最多尝试次数
  "globalConcurrency": 2,    // 全局并发上限
  "perUserPerHour": 0,       // 单用户每小时上限，0 = 不限
  "maxInputChars": 9000,     // 输入截断
  "timeoutMs": 300000,       // 单次调用超时
  "maxTokens": 1600,
  "temperature": 0.3
}
```

### 3.6 免打扰时段

```jsonc
"quietHours": { "enabled": true, "ranges": ["23:30-07:00", "12:00-13:00"] }
```

跨零点区间（如 `23:30-07:00`）已正确处理。

### 3.7 管理员指令

在任意讨论下回复以下指令即可（需 root 或 `admins.uids` 中的人）：

| 指令 | 作用 |
|---|---|
| `/ai status` | 查看节点状态、并发、成功/失败计数、延迟 |
| `/ai pause` | 暂停自动回复（不重启） |
| `/ai resume` | 恢复 |
| `/ai reload` | 立即重载 `config.json` |
| `/ai probe` | 立即探测所有节点健康 |

## 四、决策矩阵

| 讨论板块 | 比赛状态 | 能力 | 模式 | 附加动作 |
|---|---|---|---|---|
| problem | 该题所属比赛进行中 | `normal` | 赛时模式 | 禁止解法/代码 |
| problem | 无进行中比赛（赛后） | `coder` | 题解模式 | **自动注入完整题面** |
| node / training 等 | 任意 | `normal` | 通用模式 | — |

「比赛进行中」只判断讨论所属题目是否在该场 `pids` 内，不会牵连其他比赛；通用板块永远不受赛时纪律约束。

## 五、运维

```bash
# 实时日志
wsl -d Ubuntu-22.04-new -u root -e /root/.nix-profile/bin/pm2 logs hydrooj

# 只看插件日志
wsl -d Ubuntu-22.04-new -u root -e bash -lc \
  "pm2 logs hydrooj --nostream --lines 200 | grep ai-answer"

# 改完配置无需重启；如需强制重启
wsl -d Ubuntu-22.04-new -u root -e /root/.nix-profile/bin/pm2 restart hydrooj
```

**审计日志**：`/root/.hydro/addons/ai-answer/logs/audit.log`，每行一个 JSON，记录 `replied / failed / rate-limited / command` 事件，含节点名、模型名、延迟、模式。

## 六、已验证（实测）

| 能力 | 结果 |
|---|---|
| 一键部署脚本 | ✅ 语法检查 → 安装 → 建号 → 重启 → 校验，全流程通过 |
| 配置热重载 | ✅ 改 `config.json` 后无需重启即读到新节点 |
| 多节点分配 | ✅ 死节点自动跳过并冷却，任务落到可用节点 |
| 失败降级 | ✅ 死节点 `fetch failed` → 冷却 60s → 换节点成功 |
| 提示词注入 | ✅ 自定义 `prompts.general` 生效（回复开头出现注入标记） |
| 关键词触发 | ✅ 命中「怎么」触发回复；不含关键词的帖子 0 回复 |
| 审计日志 | ✅ 写入 JSON 行，含 node/model/latency |
| 赛时纪律 | ✅ 赛题索要解法被拒，平台问题正常回答 |
| 赛后题解 | ✅ 走 Coder 模型 + 自动注入题面 |
| 重复回复 | ✅ 已修复，每帖恰好 1 条 |

## 七、已知限制

1. **llama.cpp 换模型慢**：同一实例同时只加载一个模型，普通 ↔ Coder 切换需重载权重（实测 1.5–3 分钟）。多节点部署时建议让不同机器各固定一个模型，避免切换。
2. **上下文 4096**：题面 + 提问过长会被截断（插件限 9000 字符），长题建议精简提问或换长上下文模型。
3. **只回复新讨论**：默认不跟进已有讨论的后续追问（`polling.backfill` 可回填历史帖）。
4. **进程内去重**：`answered` 集合在内存中，Hydro 重启后清空；已回复的帖子靠「有回复则跳过」避免重复。
