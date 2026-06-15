#!/bin/bash
PLIST="/Library/LaunchDaemons/com.velenne.anthropic-proxy.plist"
launchctl unload "$PLIST" 2>/dev/null
sleep 1
launchctl load "$PLIST"
sleep 2
echo "proxy restarted"
tail -3 /Users/claude/claude-workspace/scripts/anthropic-intercept/proxy.log
