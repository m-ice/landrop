#!/bin/sh
# Start in the script's directory so index.html is beside server.js.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '未找到 Node.js。请安装 Node.js 22 或 24 LTS 后重试。'
  exit 1
fi
exec node server.js
