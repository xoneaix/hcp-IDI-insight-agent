#!/bin/zsh
set -e

cd "$(dirname "$0")/.."

NODE_BIN="/Users/nielun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node)"
fi

if [ -z "$NODE_BIN" ]; then
  echo "未找到 Node.js。请在 Codex 桌面应用内运行，或先安装 Node.js。"
  exit 1
fi

echo "Starting MedVoice Insight local preview..."
echo "Preview URL: http://127.0.0.1:4174/"
echo "Press Ctrl+C to stop."
"$NODE_BIN" scripts/start.mjs
