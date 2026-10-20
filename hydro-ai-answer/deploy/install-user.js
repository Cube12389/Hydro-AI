'use strict';

/**
 * 创建 / 修复 Hydro 的 AI 机器人账号。
 * 依赖 Hydro 自带 node_modules 中的 mongodb 驱动，无需额外安装。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HYDRO_HOME = process.env.HYDRO_HOME || '/root/.hydro';
const HYDRO_BASE = process.env.HYDRO_BASE || '/usr/local/share/.config/yarn/global/node_modules/hydrooj';
const CONFIG_PATH = process.env.AI_CONFIG || path.join(path.dirname(__dirname), 'config.json');

function resolveMongo() {
    const candidates = [
        path.join(path.dirname(HYDRO_BASE), 'mongodb'),
        '/usr/local/share/.config/yarn/global/node_modules/mongodb',
        path.join(HYDRO_BASE, 'node_modules/mongodb'),
    ];
    try { return require('mongodb'); } catch (e) { /* fallthrough */ }
    for (const c of candidates) {
        try { return require(c); } catch (e) { /* continue */ }
    }
    throw new Error('无法定位 mongodb 驱动，请确认 Hydro 已正确安装');
}

function readJson(p, fallback) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

function hash(password, salt) {
    return new Promise((resolve, reject) => {
        crypto.pbkdf2(password, salt, 100000, 64, 'sha256', (err, key) => {
            if (err) reject(err);
            else resolve(key.toString('hex').substring(0, 64));
        });
    });
}

async function main() {
    const cfg = readJson(CONFIG_PATH, {});
    const bot = cfg.bot || {};
    const uname = bot.uname || 'ai-assistant';
    const password = bot.password || 'Hydro-AI-Assistant-2026!';
    const mail = bot.mail || `${uname}@local.local`;
    const domainId = (cfg.domain && cfg.domain.id) || 'system';

    const hydroCfg = readJson(path.join(HYDRO_HOME, 'config.json'), {});
    const uri = process.env.MONGO_URI || hydroCfg.uri;
    if (!uri) throw new Error('无法读取 MongoDB 连接串（/root/.hydro/config.json）');

    const { MongoClient } = resolveMongo();
    const client = await MongoClient.connect(uri);
    const db = client.db(new URL(uri).pathname.slice(1) || 'hydro');

    const existing = await db.collection('user').findOne({ unameLower: uname.toLowerCase() });
    if (existing) {
        await db.collection('domain.user').updateOne(
            { domainId, uid: existing._id },
            { $set: { join: true, role: 'root' } },
            { upsert: true },
        );
        console.log(`BOT_EXISTS uid=${existing._id} uname=${uname}`);
        await client.close();
        return;
    }

    // 权限位：优先用配置，其次沿用站内 root 用户，最后用默认值
    let priv = Number(bot.priv) || 0;
    if (!priv) {
        const rootUser = await db.collection('user').findOne({ priv: { $type: 'number' } }, { sort: { priv: -1 } });
        priv = rootUser && rootUser.priv ? rootUser.priv : 16842756;
    }

    const [last] = await db.collection('user').find({}).sort({ _id: -1 }).limit(1).toArray();
    const uid = bot.uid && Number(bot.uid) > 0 ? Number(bot.uid) : Math.max((last ? last._id : 0) + 1, 2);
    const salt = crypto.randomBytes(16).toString('hex');

    await db.collection('user').insertOne({
        _id: uid,
        mail,
        mailLower: mail.toLowerCase(),
        uname,
        unameLower: uname.toLowerCase(),
        hash: await hash(password, salt),
        salt,
        hashType: 'hydro',
        regat: new Date(),
        ip: ['127.0.0.1'],
        loginat: new Date(),
        loginip: '127.0.0.1',
        priv,
        avatar: `gravatar:${mail}`,
    });
    await db.collection('domain.user').updateOne(
        { domainId, uid },
        { $set: { join: true, role: 'root' } },
        { upsert: true },
    );

    console.log(`BOT_CREATED uid=${uid} uname=${uname} priv=${priv}`);
    await client.close();
}

main().catch((e) => {
    console.error(`BOT_ERROR ${e.message}`);
    process.exit(1);
});
