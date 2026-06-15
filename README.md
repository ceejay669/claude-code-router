# Claude Code Router

An HTTPS interception proxy for macOS that routes Claude Code traffic between DeepSeek (free) and the real Anthropic API — cutting API costs to near zero for everyday tasks while keeping the full Claude experience for complex work.

## Problem It Solves

Claude Code's API costs add up fast. Most tasks (file reads, simple edits, quick lookups) don't need the full Anthropic model — DeepSeek handles them at ~$0.14/M tokens vs Claude's ~$15/M. This proxy intercepts Claude Code's HTTPS traffic and routes `POST /v1/messages` to DeepSeek via a local router, while sending everything else (auth, model validation) to the real Anthropic API.

## How It Works

```
Claude Code → /etc/hosts hijack → localhost:443 (proxy.js)
                                        ↓
                          POST /v1/messages → CCR:3456 → DeepSeek
                          Everything else  → api.anthropic.com (real)
```

1. `/etc/hosts` redirects `api.anthropic.com` to `127.0.0.1`
2. A self-signed TLS cert makes the proxy accept HTTPS on port 443
3. `proxy.js` intercepts and forwards message requests to [Claude Code Router](https://github.com/musistudio/claude-code-router) on port 3456
4. CCR routes to DeepSeek (`deepseek-chat` model)
5. A macOS LaunchDaemon runs the proxy as root on boot

## Tech Stack

- **Node.js** — HTTPS proxy with `https` + `http` core modules
- **macOS LaunchDaemon** — runs as root, auto-starts on boot
- **Self-signed TLS** — `certs/` directory, generated at install time
- **DeepSeek API** — `deepseek-chat` model via CCR on port 3456
- **System prompt injection** — strips heavy orchestrator context before forwarding

## Features

- Automatic `/etc/hosts` management — one command to switch FREE ↔ REAL mode
- Session logging — every DeepSeek exchange logged to daily JSONL
- Tool call validation — fixes malformed JSON from DeepSeek before forwarding
- System prompt pre-filter — removes complex Claude.md sections that confuse DeepSeek
- Handoff file — writes `deepseek-handoff.json` for context continuity

## Install

```bash
# Requires Node.js and Claude Code Router (CCR) running on port 3456
sudo bash install.sh
```

## Switch Modes

```bash
# Enable free routing (DeepSeek)
claude-free

# Switch back to real Anthropic API
claude-real

# Check current mode
claude-status
```

> Add these aliases to your `.zshrc` — see `setup.sh` for the full alias definitions.

## Cost

DeepSeek `deepseek-chat`: ~$0.14/M tokens average (input + output blended).
Real Anthropic Claude Sonnet: ~$15/M tokens.
