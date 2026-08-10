#!/usr/bin/env bash
# DOCX→PDF（轻量路径）：OfficeCLI 高保真 HTML 渲染 + Chrome headless 打印
# 用法: bash tools/docx2pdf/run.sh <in.docx> <out.pdf>
# 依赖: officecli（npm i -g @officecli/officecli）、Google Chrome（可用 CHROME_BIN 覆盖路径）
set -euo pipefail

IN="$1"
OUT="$2"

command -v officecli >/dev/null 2>&1 || { echo "错误: 未找到 officecli，请先 npm i -g @officecli/officecli" >&2; exit 1; }
CHROME_BIN="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$CHROME_BIN" ] || { echo "错误: 未找到 Chrome: $CHROME_BIN（可用 CHROME_BIN 环境变量指定）" >&2; exit 1; }
[ -f "$IN" ] || { echo "错误: 输入文件不存在: $IN" >&2; exit 1; }

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
HTML="$TMPDIR/$(basename "${IN%.docx}").html"

# 1) OfficeCLI 渲染 docx → HTML（复用其高保真渲染引擎）
# 注意: 若 officecli 正以 resident 模式持有该文件，先 close 落盘
officecli view "$IN" html -o "$HTML" >/dev/null

# 2) Chrome headless 打印 HTML → PDF
#    --no-pdf-header-footer 单独使用（勿与 --print-to-pdf-no-header 混用，会失效）
"$CHROME_BIN" --headless --disable-gpu --no-first-run --no-pdf-header-footer \
  --virtual-time-budget=5000 --print-to-pdf="$OUT" "file://$HTML" >/dev/null 2>&1

[ -s "$OUT" ] || { echo "错误: PDF 生成失败: $OUT" >&2; exit 1; }
echo "OK: $OUT"
