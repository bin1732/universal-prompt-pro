#!/usr/bin/env bash
# install-local.sh — Universal Prompt Pro 一键安装（多宿主 + 防覆盖备份）
# 用法:
#   bash scripts/install-local.sh claude          # 装到 Claude Code
#   bash scripts/install-local.sh codex           # 装到 Codex
#   bash scripts/install-local.sh openclaw        # 装到 OpenClaw
#   bash scripts/install-local.sh all             # 装到全部已知宿主
#   bash scripts/install-local.sh uninstall <host># 卸载指定宿主
set -euo pipefail

SKILL_NAME="universal-prompt-pro"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---- 各宿主 skills 目录 ----
declare -A HOST_PATHS=(
  [claude]="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"
  [codex]="${CODEX_HOME:-$HOME/.codex}/skills"
  [openclaw]="${OPENCLAW_HOME:-$HOME/.openclaw}/skills"
  [cursor]="${HOME}/.cursor/skills"
  [gemini]="${HOME}/.gemini/skills"
)

backup_existing() {
  local dest="$1"
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    local ts
    ts="$(date +%Y%m%d%H%M%S)"
    cp -r "$dest" "${dest}.bak.${ts}"
    echo "  [备份] 已存在目录 → ${dest}.bak.${ts}"
  fi
}

install_to() {
  local host="$1"
  local base="${HOST_PATHS[$host]:-}"
  if [ -z "$base" ]; then
    echo "  [跳过] 未知宿主: $host"
    return 1
  fi
  mkdir -p "$base"
  local dest="$base/$SKILL_NAME"
  backup_existing "$dest"
  # 用 rsync 优先，退化为 cp（保留完整结构，排除 data 私有运行时子目录；assets/data/lexicon 词库必须保留——安全底线）
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude 'assets/data/versions/' \
      --exclude 'assets/data/habit-profile/' \
      --exclude 'assets/data/failures/' \
      --exclude 'assets/data/experience/' \
      --exclude 'assets/data/memory/' \
      --exclude 'assets/data/golden/' \
      --exclude 'assets/data/search-cache/' \
      --exclude '.git/' \
      "$SRC_DIR/" "$dest/"
  else
    rm -rf "$dest"
    cp -r "$SRC_DIR" "$dest"
    # 仅清理运行时子目录，保留 assets/data/lexicon 分发词库
    for d in versions habit-profile failures experience memory golden search-cache; do
      rm -rf "$dest/assets/data/$d"
    done
  fi
  echo "  [OK] $host → $dest"
}

uninstall_from() {
  local host="$1"
  local base="${HOST_PATHS[$host]:-}"
  [ -z "$base" ] && { echo "  [跳过] 未知宿主: $host"; return 1; }
  local dest="$base/$SKILL_NAME"
  if [ -e "$dest" ]; then
    backup_existing "$dest"   # 卸载也先备份，防误删
    rm -rf "$dest"
    echo "  [OK] 已卸载 $host（原目录已备份为 .bak.*）"
  else
    echo "  [提示] $dest 不存在"
  fi
}

main() {
  local cmd="${1:-all}"
  if [ "$cmd" = "uninstall" ]; then
    local host="${2:-}"
    [ -z "$host" ] && { echo "用法: bash scripts/install-local.sh uninstall <host>"; exit 1; }
    uninstall_from "$host"
    exit 0
  fi

  if [ "$cmd" = "all" ]; then
    for h in "${!HOST_PATHS[@]}"; do
      echo "== $h =="
      install_to "$h" || true
    done
  else
    install_to "$cmd" || { echo "用法: bash scripts/install-local.sh [claude|codex|openclaw|cursor|gemini|all|uninstall]"; exit 1; }
  fi
  echo ""
  echo "安装完成。若宿主未热更新 skills，请新开会话后重试。"
}

main "$@"
