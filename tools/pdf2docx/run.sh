#!/usr/bin/env bash
# PDF→DOCX 保版式转换（基于 pdf2docx，唯一自建能力）
# 用法: tools/pdf2docx/run.sh <in.pdf> <out.docx>
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -x "$HERE/.venv/bin/pdf2docx" ]; then
  echo "错误: 未找到 $HERE/.venv/bin/pdf2docx，请先运行: uv venv $HERE/.venv --python 3.12 && uv pip install --python $HERE/.venv -r $HERE/requirements.txt" >&2
  exit 1
fi
exec "$HERE/.venv/bin/pdf2docx" convert "$@"
