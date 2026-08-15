#!/usr/bin/env bash
# install-git-hook.sh — pre-commit 自动回归安装脚本（P5 补齐：改动后忘记回归的风险防护）
# 能力: 安装/卸载 git pre-commit hook，提交前自动运行 validate + attack 双回归
# 设计:
#   1. 非侵入: 不覆盖用户已有 pre-commit（有则合并调用，无则创建）
#   2. 快速失败: 回归失败 → 阻止提交（红门禁，防"忘记回归"）
#   3. 可跳过: 紧急提交可用 --no-verify（git 原生机制，hook 内不强制绕过）
# 用法:
#   bash scripts/install-git-hook.sh install     # 安装（默认）
#   bash scripts/install-git-hook.sh uninstall   # 卸载
#   bash scripts/install-git-hook.sh status      # 查看状态
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"  # skill 目录（回归目标）
# 定位 skill 所在的 git 仓库根：skill 自身是仓库，或 skill 是项目子目录
REPO_ROOT="$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || true)"
HOOK_DIR="${REPO_ROOT:-$ROOT}/.git/hooks"
HOOK_FILE="$HOOK_DIR/pre-commit"
HOOK_MARK="# UNIVERSAL-PROMPT-REGRESSION-HOOK"

gen_hook() {
  cat <<EOF
#!/usr/bin/env bash
$HOOK_MARK
# 自动回归：validate + attack（P5 补齐，防改动后忘记回归）
# 跳过: git commit --no-verify（紧急提交）
set -uo pipefail
cd "$ROOT"
# node 缺失时跳过回归（不阻塞提交；skill 需要 Node ≥14.18）
if ! command -v node >/dev/null 2>&1; then
  echo "⚠️ [pre-commit] 未检测到 node，跳过 universal-prompt 回归（需 Node ≥14.18）"
  exit 0
fi
echo "== [pre-commit] 运行 P0-P5 全门禁 =="
if ! node scripts/validate.mjs; then
  echo "❌ [pre-commit] validate 回归失败，提交已阻止。修复后重试，或紧急提交用 --no-verify。"
  exit 1
fi
echo "== [pre-commit] 运行攻击套件（34 用例） =="
if ! node scripts/attack.mjs >/dev/null 2>&1; then
  echo "❌ [pre-commit] attack 回归失败，提交已阻止。修复后重试，或紧急提交用 --no-verify。"
  exit 1
fi
echo "✅ [pre-commit] validate + attack 回归通过"
EOF
}

install_hook() {
  if [ -z "$REPO_ROOT" ]; then
    echo "❌ 当前目录不在任何 git 仓库中（git -C $ROOT rev-parse 失败）。请先 git init 或 clone。"
    exit 1
  fi
  echo "  [仓库] skill 位于 $ROOT；git 仓库根: $REPO_ROOT"
  [ -d "$HOOK_DIR" ] || mkdir -p "$HOOK_DIR"
  if [ -f "$HOOK_FILE" ]; then
    if grep -q "$HOOK_MARK" "$HOOK_FILE"; then
      echo "  [跳过] pre-commit hook 已安装（含回归标记）"
      return 0
    fi
    # 已有用户 hook：备份并在其后追加回归调用
    cp "$HOOK_FILE" "$HOOK_FILE.bak.$(date +%Y%m%d%H%M%S)"
    echo "  [备份] 已有 pre-commit → .bak.*"
    # 在用户 hook 末尾追加回归（不破坏用户逻辑）；若无执行位则加
    {
      echo ""
      echo "$HOOK_MARK"
      echo 'echo "== [pre-commit] 追加: universal-prompt 回归 =="'
      echo "cd \"$ROOT\""
      echo 'node scripts/validate.mjs && node scripts/attack.mjs >/dev/null 2>&1 || { echo "❌ universal-prompt 回归失败，用 --no-verify 跳过"; exit 1; }'
    } >> "$HOOK_FILE"
    chmod +x "$HOOK_FILE"
    echo "  [OK] 已合并进已有 pre-commit（原逻辑保留）"
  else
    gen_hook > "$HOOK_FILE"
    chmod +x "$HOOK_FILE"
    echo "  [OK] 已创建 pre-commit（validate + attack 回归）"
  fi
}

uninstall_hook() {
  if [ -f "$HOOK_FILE" ] && grep -q "$HOOK_MARK" "$HOOK_FILE"; then
    # 仅移除我们追加的块；若整个文件是我们生成的则删除文件
    if grep -q "原逻辑保留\|追加: universal-prompt" "$HOOK_FILE" 2>/dev/null; then
      cp "$HOOK_FILE" "$HOOK_FILE.bak.$(date +%Y%m%d%H%M%S)"
      sed -i "/$HOOK_MARK/,\$d" "$HOOK_FILE"
      echo "  [OK] 已移除追加的回归块（原 hook 保留，备份 .bak.*）"
    else
      cp "$HOOK_FILE" "$HOOK_FILE.bak.$(date +%Y%m%d%H%M%S)"
      rm "$HOOK_FILE"
      echo "  [OK] 已移除整个 pre-commit（备份 .bak.*）"
    fi
  else
    echo "  [提示] 未找到 universal-prompt 回归 hook（或未安装）"
  fi
}

status_hook() {
  if [ -f "$HOOK_FILE" ] && grep -q "$HOOK_MARK" "$HOOK_FILE"; then
    echo "  ✓ pre-commit 回归 hook 已安装"
    grep -c "validate.mjs" "$HOOK_FILE" | xargs -I{} echo "  包含 validate 回归: {} 处"
  else
    echo "  ✗ 未安装（bash scripts/install-git-hook.sh install）"
  fi
}

case "${1:-install}" in
  install)   install_hook ;;
  uninstall) uninstall_hook ;;
  status)    status_hook ;;
  *) echo "用法: bash scripts/install-git-hook.sh [install|uninstall|status]"; exit 1 ;;
esac
