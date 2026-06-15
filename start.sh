#!/bin/bash
# start.sh — ensures CCR + proxy are running
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 1. Start CCR if not running
if ! curl -s --max-time 1 http://127.0.0.1:3456/health &>/dev/null; then
  echo "[start] Starting CCR..."
  ccr start &>/dev/null &
  for i in {1..15}; do
    curl -s --max-time 0.3 http://127.0.0.1:3456/health &>/dev/null && break
    sleep 0.2
  done
fi

# 2. Start HTTPS proxy if not running
if ! curl -sk --max-time 1 https://127.0.0.1:8443/v1/models &>/dev/null; then
  echo "[start] Starting HTTPS proxy on :8443..."
  node "$SCRIPT_DIR/proxy.js" &
  sleep 0.5
fi

echo "[start] Ready — Claude Code routes to DeepSeek via CCR"
