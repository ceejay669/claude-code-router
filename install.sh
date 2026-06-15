#!/bin/bash
set -e
PLIST="/Users/claude/claude-workspace/scripts/anthropic-intercept/com.velenne.anthropic-proxy.plist"
DEST="/Library/LaunchDaemons/com.velenne.anthropic-proxy.plist"

echo "[1] Copying plist..."
cp "$PLIST" "$DEST"

echo "[2] Loading LaunchDaemon..."
launchctl load "$DEST"

echo "[3] Adding /etc/hosts entry..."
grep -q "api.anthropic.com" /etc/hosts || echo "127.0.0.1 api.anthropic.com" >> /etc/hosts

echo "[4] Waiting for proxy to start..."
sleep 2

echo "[5] Testing..."
curl -sk https://api.anthropic.com/v1/models | python3 -c "
import json,sys
d=json.load(sys.stdin)
models=[m['id'] for m in d.get('data',[])]
if models:
    print('OK — proxy working')
    print('Models:', models)
else:
    print('ERROR:', d)
"
