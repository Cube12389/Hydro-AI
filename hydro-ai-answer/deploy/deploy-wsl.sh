#!/bin/bash
# Hydro AI 答疑插件 - WSL 侧安装脚本（需 root 运行）
set -uo pipefail

SRC="${1:-}"
if [[ -z "$SRC" ]]; then
    SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

HYDRO_HOME="${HYDRO_HOME:-/root/.hydro}"
ADDON_DIR="$HYDRO_HOME/addons/ai-answer"
ADDON_JSON="$HYDRO_HOME/addon.json"
HYDRO_BASE="${HYDRO_BASE:-/usr/local/share/.config/yarn/global/node_modules/hydrooj}"

log()  { printf '\033[36m[deploy]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[ ok ]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

[[ -f "$SRC/index.js" ]] || die "找不到插件源码：$SRC/index.js"
[[ -f "$HYDRO_HOME/config.json" ]] || die "找不到 Hydro 配置：$HYDRO_HOME/config.json（Hydro 是否已安装？）"

# ---------- 定位 node / pm2 ----------
NODE="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE" ]]; then
    for c in /root/.nix-profile/bin/node /usr/local/bin/node /usr/bin/node; do
        [[ -x "$c" ]] && NODE="$c" && break
    done
fi
if [[ -z "$NODE" ]]; then
    NODE="$(find /nix/store -maxdepth 3 -name node -type f -perm -u+x 2>/dev/null | head -1)"
fi
[[ -n "$NODE" ]] || die "未找到 node，可执行文件，无法继续"
ok "node: $NODE ($($NODE -v))"

PM2="$(command -v pm2 2>/dev/null || true)"
if [[ -z "$PM2" ]]; then
    for c in /root/.nix-profile/bin/pm2 /usr/local/bin/pm2 /usr/bin/pm2; do
        [[ -x "$c" ]] && PM2="$c" && break
    done
fi

# ---------- 复制插件 ----------
log "安装插件到 $ADDON_DIR"
mkdir -p "$ADDON_DIR"
BACKUP=""
if [[ -f "$ADDON_DIR/config.json" ]]; then
    BACKUP="$(mktemp)"
    cp -f "$ADDON_DIR/config.json" "$BACKUP"
    log "已备份现有 config.json"
fi

cp -f "$SRC/index.js" "$ADDON_DIR/index.js"
cp -f "$SRC/package.json" "$ADDON_DIR/package.json"
[[ -f "$SRC/config.example.json" ]] && cp -f "$SRC/config.example.json" "$ADDON_DIR/config.example.json"
if [[ -d "$SRC/deploy" ]]; then
    cp -rf "$SRC/deploy" "$ADDON_DIR/"
fi

if [[ -n "$BACKUP" ]]; then
    cp -f "$BACKUP" "$ADDON_DIR/config.json"
    rm -f "$BACKUP"
    ok "保留原有 config.json"
else
    cp -f "$SRC/config.example.json" "$ADDON_DIR/config.json"
    ok "已生成 config.json（来自 config.example.json）"
fi

chown -R root:root "$ADDON_DIR" 2>/dev/null || true

# ---------- 注册到 addon.json ----------
log "注册到 $ADDON_JSON"
"$NODE" -e "
const fs = require('fs');
const p = process.argv[1];
const entry = process.argv[2];
let list = [];
try { list = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { list = []; }
if (!Array.isArray(list)) list = [];
if (!list.includes(entry)) list.push(entry);
fs.writeFileSync(p, JSON.stringify(list, null, 2));
console.log('addons = ' + JSON.stringify(list));
" "$ADDON_JSON" "$ADDON_DIR" || die "addon.json 写入失败"

# ---------- 创建 bot 账号 ----------
log "检查 / 创建 AI 机器人账号"
HYDRO_HOME="$HYDRO_HOME" HYDRO_BASE="$HYDRO_BASE" "$NODE" "$ADDON_DIR/deploy/install-user.js" || die "机器人账号创建失败"

# ---------- 重启 Hydro ----------
if [[ -n "$PM2" ]]; then
    log "重启 Hydro（pm2）"
    "$PM2" restart hydrooj >/dev/null 2>&1 || die "pm2 重启失败"
    sleep 10
    "$PM2" list 2>/dev/null | grep -E 'hydrooj' || true
else
    warn "未找到 pm2，请手动重启 Hydro 服务"
fi

# ---------- 校验 ----------
log "校验插件加载情况"
if [[ -n "$PM2" ]]; then
    "$PM2" logs hydrooj --lines 120 --nostream 2>/dev/null | grep 'ai-answer' | tail -8 || true
fi

CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:8888/ 2>/dev/null || echo 000)"
if [[ "$CODE" == "200" ]]; then
    ok "Hydro 运行正常（HTTP 200）"
else
    warn "Hydro 首页返回 $CODE，请检查日志"
fi

ok "部署完成。配置文件：$ADDON_DIR/config.json（修改后无需重启，插件会自动重载）"
