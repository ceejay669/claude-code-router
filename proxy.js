#!/usr/bin/env node
/**
 * anthropic-intercept proxy v2
 * Listens on 443 (run via LaunchDaemon as root).
 * POST /v1/messages  → CCR:3456 → DeepSeek (free)
 * Everything else    → real api.anthropic.com (auth/model checks, no token cost)
 *
 * Features:
 *   1. System prompt injection (DEEPSEEK_ADDENDUM)
 *   2. Pre-filter — strip complex orchestrator logic from CLAUDE.md before injection
 *   3. Format tune — adjust system prompt format per model
 *   4. Cost gate — read-only requests → DeepSeek; heavy code gen → block with message
 *   5. Timeout/retry — retry on DeepSeek timeout
 *   6. Tool call validation — validate DeepSeek tool call JSON before forwarding
 */
const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const SESSION_LOG_DIR  = path.join(os.homedir(), 'claude-workspace/AI-OS/logs/deepseek-sessions');
const HANDOFF_FILE     = path.join(os.homedir(), 'claude-workspace/AI-OS/deepseek-handoff.json');

// ── Session logger ─────────────────────────────────────────────────────
// Writes each DeepSeek exchange to a daily JSONL + updates handoff.json
function logExchange(entry) {
  try {
    const date  = new Date().toISOString().slice(0, 10);
    const file  = path.join(SESSION_LOG_DIR, `${date}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');

    // Handoff: keep last 5 exchanges + summary for Claude to read on switch
    let handoff = { updated: new Date().toISOString(), last_exchanges: [] };
    try { handoff = JSON.parse(fs.readFileSync(HANDOFF_FILE, 'utf8')); } catch (_) {}
    handoff.updated = new Date().toISOString();
    handoff.last_exchanges = [entry, ...(handoff.last_exchanges || [])].slice(0, 5);
    handoff.last_task      = entry.user_message ? entry.user_message.slice(0, 200) : handoff.last_task;
    handoff.last_error     = entry.error || handoff.last_error;
    handoff.in_progress    = entry.stop_reason !== 'end_turn';
    handoff.tool_calls_made = (entry.tool_calls || []).map(t => t.name);
    fs.writeFileSync(HANDOFF_FILE, JSON.stringify(handoff, null, 2));
  } catch (err) {
    log(`session-log error: ${err.message}`);
  }
}

// Reconstruct assistant message + tool calls from SSE event stream
function buildSseLogger(model, requestBody, onDone) {
  const blocks  = {};   // index → { type, text, name, input }
  let inputTokens = 0, outputTokens = 0;
  let stopReason  = '';
  let userMessage = '';
  let toolCalls   = [];

  try {
    const p = JSON.parse(requestBody.toString());
    const msgs = p.messages || [];
    const last = msgs.filter(m => m.role === 'user').pop();
    if (last) {
      userMessage = Array.isArray(last.content)
        ? last.content.filter(c => c.type === 'text').map(c => c.text).join(' ')
        : (last.content || '');
    }
  } catch (_) {}

  function onChunk(chunkStr) {
    const lines = chunkStr.split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const ev = JSON.parse(line.slice(6));
        if (ev.type === 'message_start' && ev.message?.usage) {
          inputTokens  = ev.message.usage.input_tokens  || 0;
          outputTokens = ev.message.usage.output_tokens || 0;
        }
        if (ev.type === 'message_delta') {
          stopReason   = ev.delta?.stop_reason || stopReason;
          outputTokens = (ev.usage?.output_tokens) || outputTokens;
        }
        if (ev.type === 'content_block_start') {
          blocks[ev.index] = { type: ev.content_block?.type, text: '', name: ev.content_block?.name, input: '' };
        }
        if (ev.type === 'content_block_delta') {
          const b = blocks[ev.index];
          if (!b) return;
          if (ev.delta?.type === 'text_delta')        b.text  += ev.delta.text  || '';
          if (ev.delta?.type === 'input_json_delta')  b.input += ev.delta.partial_json || '';
        }
      } catch (_) {}
    }
  }

  function finish() {
    let assistantText = '';
    toolCalls = [];
    for (const b of Object.values(blocks)) {
      if (b.type === 'text')     assistantText += b.text;
      if (b.type === 'tool_use') {
        let input = {};
        try { input = JSON.parse(b.input); } catch (_) {}
        toolCalls.push({ name: b.name, input });
      }
    }
    onDone({
      timestamp:      new Date().toISOString(),
      model,
      user_message:   userMessage.slice(0, 500),
      assistant_text: assistantText.slice(0, 1000),
      tool_calls:     toolCalls,
      stop_reason:    stopReason,
      tokens:         { input: inputTokens, output: outputTokens },
      error:          null,
    });
  }

  return { onChunk, finish };
}

// ── DeepSeek addendum ──────────────────────────────────────────────────
// Injected on DeepSeek routes only. Claude sessions never see this.
const DEEPSEEK_ADDENDUM = `

---
DEEPSEEK OPERATING RULES — follow exactly every session:

IDENTITY: Assisting Mohamed Ibrahim (Velenne Studio, Istanbul). He builds software, AI agents, websites, automation tools.

RESPONSE FORMAT — mandatory:
- Respond as Claude would. Do NOT prefix "I am DeepSeek" or "As an AI". Behave identically to Claude.
- Use tool calls in function_calling format, not markdown.
- When user asks for code, write code. When user asks for analysis, write analysis. Do not explain you are a different model.

VAULT SAVES — mandatory after every task (write file directly, no need to ask):
- Research notes → ~/claude-workspace/mohamed-vault/Research/[topic].md
- Build summaries → ~/claude-workspace/mohamed-vault/Claude Knowledge/[project].md
- Client/brand work → ~/claude-workspace/mohamed-vault/Clients/[brand].md
- Decisions → ~/claude-workspace/mohamed-vault/Decisions/All Decisions.md (append only, never overwrite)
- Web searches → ~/claude-workspace/mohamed-vault/Web Searches/searches-YYYY-MM-DD.md
- Session notes → ~/claude-workspace/mohamed-vault/Sessions/session-YYYY-MM-DD.md
- Add [[wikilinks]] at bottom of every note (e.g. [[Claude Knowledge]] [[Research]]).

SKILL LOADING — before any task:
- Check ~/.claude/skills/ for relevant skill files and read them before starting.
- For ANY design/UI/frontend/website task: invoke design-preflight skill FIRST — no exceptions.
- For research: use autoresearch-agent, firecrawl skills.
- Never start a task without loading the relevant skill.

COMMUNICATION STYLE:
- Direct and terse. No "Sure!", no "Certainly!", no "Happy to help!".
- Show reasoning before acting. Flag risks immediately.
- Fragments OK. Drop filler words.

HARD BANS — never do these in any design/UI:
- Never dark theme by default
- Never generic card grid + hover shadow layout
- Never purple-blue gradient background
- Never custom cursor dot+ring animation
- Never accordion services / work cards grid / manifesto section

STOPPING RULES — never violate:
- Stop immediately on any error — do not auto-fix
- Never install npm/pip packages without explicit approval
- Never delete files without confirmation
- Research tasks = find and report only — never build during research
- If unsure, stop and ask

VAULT PATHS:
- Vault root: ~/claude-workspace/mohamed-vault
- Projects: ~/claude-workspace/projects
- Skills: ~/.claude/skills
---`;

// Complex CLAUDE.md sections to strip before sending to DeepSeek.
// DeepSeek chokes on nested logic — keep only essentials.
const CLAUDE_PATTERNS_TO_STRIP = [
  { pattern: /ORCHESTRATOR[\s\S]*?RULE ZERO[\s\S]*?No exceptions\./g, replace: '' },
  { pattern: /### ORCHESTRATOR[\s\S]*?final authority[\s\S]*?### /g, replace: '### ' },
  { pattern: /## THE 10 TASK PRIMITIVES[\s\S]*?(?=## )/g, replace: '' },
  { pattern: /## AGENT[\s\S]*?MAPPING[\s\S]*?(?=## )/g, replace: '' },
  { pattern: /## CRITIC SYSTEM[\s\S]*?(?=## )/g, replace: '' },
  { pattern: /## STATE SYSTEM[\s\S]*?(?=## )/g, replace: '' },
  { pattern: /## MEMORY ARCHITECTURE[\s\S]*?(?=## )/g, replace: '' },
  { pattern: /## AGENT HANDOFF PROTOCOL[\s\S]*?(?=## )/g, replace: '' },
  { pattern: /## RETRY ENGINE[\s\S]*?(?=## )/g, replace: '' },
  { pattern: /## EVENT LOG[\s\S]*?(?=## )/g, replace: '' },
  { pattern: /## LEARNING ENGINE[\s\S]*?(?=## )/g, replace: '' },
  { pattern: /## AGENT SANDBOX[\s\S]*?(?=## )/g, replace: '' },
];

const CERT_DIR      = path.join(__dirname, 'certs');
const LISTEN_PORT   = parseInt(process.env.PROXY_PORT || '443', 10);
const CCR_PORT      = 3456;
const ANTHROPIC_IP  = '160.79.104.10';

// Cost gate — request sizes are rough heuristic.
// Heavy: >1MB body OR model contains "opus"
// Light: <=1MB body with non-opus models
const HEAVY_REQUEST_BYTES  = 1024 * 1024;
const DEEPSEEK_TIMEOUT_MS  = 60_000;
const DEEPSEEK_RETRIES     = 2;

const tlsOptions = {
  cert: fs.readFileSync(path.join(CERT_DIR, 'api.anthropic.com.pem')),
  key:  fs.readFileSync(path.join(CERT_DIR, 'api.anthropic.com-key.pem')),
};

const server = https.createServer(tlsOptions, (req, res) => {
  log(`RECV ${req.method} ${req.url}`);
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      log(`→ DeepSeek POST ${req.url} (${body.length}b)`);
      routeToCCR(req, res, body);
    } else {
      log(`→ Anthropic ${req.method} ${req.url}`);
      passthrough(req, res, body);
    }
  });
});

// ── Feature 2: Pre-filter CLAUDE.md content ───────────────────────────
// Strip complex orchestrator sections DeepSeek can't handle.
function preFilterSystemPrompt(systemText) {
  let cleaned = systemText;
  for (const { pattern, replace } of CLAUDE_PATTERNS_TO_STRIP) {
    cleaned = cleaned.replace(pattern, replace);
  }
  return cleaned;
}

// ── Feature 3: Format tune ────────────────────────────────────────────
// DeepSeek responds better to system as a messages[0] role.
// Claude Code sends deepseek-chat as model. Detect and adjust.
function isDeepSeekModel(model) {
  return model && (model.startsWith('deepseek') || model.includes('deepseek'));
}

// ── Feature 4: Cost gate ──────────────────────────────────────────────
// Read-only / small requests → DeepSeek. Heavy code gen → warn.
function costGateShouldRouteToDeepSeek(body, model) {
  // Heavy by body size
  if (body.length > HEAVY_REQUEST_BYTES) {
    log(`cost-gate: body ${body.length}b > ${HEAVY_REQUEST_BYTES}b — heavy request blocked from DeepSeek`);
    return false;
  }
  // Heavy by model
  if (model && model.includes('opus')) {
    log(`cost-gate: model "${model}" is opus class — heavy request blocked from DeepSeek`);
    return false;
  }
  return true;
}

// ── Feature 6: Tool call validation ───────────────────────────────────
// Quick sanity check on DeepSeek's response tool calls.
function validateToolCalls(content) {
  if (!content || !Array.isArray(content)) return [];
  const issues = [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (block.type === 'tool_use') {
      if (!block.name || typeof block.name !== 'string') {
        issues.push({ index: i, issue: `tool_use[${i}]: missing or invalid name` });
      }
      if (!block.id || typeof block.id !== 'string') {
        issues.push({ index: i, issue: `tool_use[${i}]: missing or invalid id` });
      }
      if (!block.input || typeof block.input !== 'object') {
        issues.push({ index: i, issue: `tool_use[${i}]: missing or invalid input` });
      }
    }
  }
  return issues;
}

// ── Message pruning — strip old tool_result content to reduce payload ──
// When conversation grows large (skill loads, long sessions), old tool_result
// blocks bloat the payload. Strip content from tool_results older than the
// last 3 assistant turns, keeping enough context to continue working.
function pruneMessages(body) {
  try {
    const payload = JSON.parse(body.toString());
    if (!payload.messages || !Array.isArray(payload.messages)) return body;

    const msgs = payload.messages;
    const totalSize = body.length;

    // Only prune if body is large (>450KB)
    if (totalSize < 450 * 1024) return body;

    // Find last 3 assistant message indices
    const assistantIndices = [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') assistantIndices.push(i);
      if (assistantIndices.length >= 3) break;
    }
    const keepAfter = assistantIndices.length > 0
      ? assistantIndices[assistantIndices.length - 1]
      : msgs.length;

    // Strip tool_result content from messages before the keepAfter index
    let pruned = 0;
    for (let i = 0; i < keepAfter; i++) {
      const msg = msgs[i];
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_result' && block.content) {
            const originalLen = JSON.stringify(block.content).length;
            if (originalLen > 500) {
              block.content = '[pruned — context too large]';
              pruned += originalLen;
            }
          }
        }
      }
    }

    if (pruned > 0) {
      log(`pruned ${pruned}b of old tool_result content to reduce payload`);
    }

    return Buffer.from(JSON.stringify(payload));
  } catch (_) {
    return body;
  }
}

// ── Inject DEEPSEEK_ADDENDUM ──────────────────────────────────────────
function injectDeepSeekRules(body) {
  try {
    const payload = JSON.parse(body.toString());
    const addendum = DEEPSEEK_ADDENDUM.replace('YYYY-MM-DD', new Date().toISOString().slice(0, 10));
    if (typeof payload.system === 'string') {
      payload.system = preFilterSystemPrompt(payload.system) + addendum;
    } else if (Array.isArray(payload.system)) {
      payload.system.push({ type: 'text', text: addendum });
    } else {
      payload.system = addendum.trim();
    }
    return Buffer.from(JSON.stringify(payload));
  } catch (_) {
    return body;
  }
}

// ── Route to CCR with timeout/retry ───────────────────────────────────
function routeToCCR(req, res, body) {
  let model = 'claude-sonnet-4-6';
  try { const p = JSON.parse(body); if (p.model) model = p.model; } catch (_) {}

  // Prune old tool_result content if payload is large
  body = pruneMessages(body);

  // Cost gate: block heavy requests from DeepSeek
  if (!costGateShouldRouteToDeepSeek(body, model)) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'overloaded_error',
        message: `Request too heavy for DeepSeek (${body.length}b). Switch to real Claude with ! claude-real`
      }
    }));
    return;
  }

  // Inject rules
  body = injectDeepSeekRules(body);

  // Track if model is DeepSeek for format adjustments
  const isDS = isDeepSeekModel(model);

  // ── Feature 5: Timeout/retry logic ──────────────────────────────────
  // Max 2 retries for DeepSeek, 0 for Claude
  const maxRetries = (body.length > 50000) ? 1 : 2;

  function doRequest(attempt) {
    const opts = {
      hostname: '127.0.0.1', port: CCR_PORT,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type':      'application/json',
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
        'x-api-key':         'proxy',
        'content-length':    Buffer.byteLength(body),
      },
      timeout: DEEPSEEK_TIMEOUT_MS,
    };

    const ccrReq = http.request(opts, up => {
      const sse = (up.headers['content-type'] || '').includes('text/event-stream');
      res.writeHead(up.statusCode, up.headers);

      if (!sse) {
        const parts = [];
        up.on('data', c => parts.push(c));
        up.on('end', () => {
          const responseText = Buffer.concat(parts).toString();
          // Validate tool calls in response
          try {
            const parsed = JSON.parse(responseText);
            if (parsed.content) {
              const issues = validateToolCalls(parsed.content);
              if (issues.length > 0) {
                log(`tool-validation: ${issues.length} issue(s): ${issues.map(i => i.issue).join(', ')}`);
              }
            }
          } catch (_) {}
          res.end(patchModel(responseText, model));
        });
      } else {
        let patched = false, buf = '';
        const sseLogger = buildSseLogger(model, body, logExchange);
        up.on('data', chunk => {
          sseLogger.onChunk(chunk.toString());
          if (patched) { res.write(chunk); return; }
          buf += chunk.toString();
          const lines = buf.split('\n'); buf = lines.pop();
          let out = '';
          for (const line of lines) {
            if (!patched && line.startsWith('data: ')) {
              try {
                const ev = JSON.parse(line.slice(6));
                if (ev.message?.model) { ev.message.model = model; patched = true; }
                out += 'data: ' + JSON.stringify(ev) + '\n'; continue;
              } catch (_) {}
            }
            out += line + '\n';
          }
          if (out) res.write(out);
        });
        up.on('end', () => {
          sseLogger.finish();
          if (buf) res.write(buf);
          res.end();
        });
      }
    });

    ccrReq.on('timeout', () => {
      ccrReq.destroy();
      if (attempt < maxRetries) {
        log(`timeout-retry: attempt ${attempt + 1} timed out, retrying (${attempt + 2}/${maxRetries + 1})`);
        doRequest(attempt + 1);
      } else {
        log(`timeout-retry: all ${maxRetries + 1} attempts failed`);
        logExchange({ timestamp: new Date().toISOString(), model, error: `timeout after ${maxRetries + 1} attempts`, stop_reason: 'timeout', tokens: {}, tool_calls: [] });
        if (!res.headersSent) res.writeHead(504);
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'timeout_error', message: `DeepSeek timeout after ${maxRetries + 1} attempts` }
        }));
      }
    });

    ccrReq.on('error', err => {
      // Don't log timeout-destroy errors (they're handled above)
      if (err.message === 'socket hang up' && attempt <= maxRetries) return;
      log(`CCR error: ${err.message}`);
      if (!res.headersSent) res.writeHead(503);
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: `CCR error: ${err.message}` }
      }));
    });

    if (body.length) ccrReq.write(body);
    ccrReq.end();
  }

  doRequest(0);
}

function passthrough(req, res, body) {
  const opts = {
    hostname: ANTHROPIC_IP, port: 443,
    path: req.url, method: req.method,
    headers: { ...req.headers, host: 'api.anthropic.com', 'content-length': body.length },
    servername: 'api.anthropic.com',
  };
  const p = https.request(opts, up => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
  p.on('error', err => { if (!res.headersSent) res.writeHead(502); res.end(err.message); });
  if (body.length) p.write(body);
  p.end();
}

function patchModel(text, model) {
  try { const d = JSON.parse(text); if (d.model) d.model = model; return JSON.stringify(d); }
  catch (_) { return text; }
}

function log(msg) {
  process.stdout.write(`[proxy] ${new Date().toISOString().slice(11,19)} ${msg}\n`);
}

server.listen(LISTEN_PORT, '127.0.0.1', () => log(`listening :${LISTEN_PORT}`));
server.on('error', err => {
  if (err.code === 'EADDRINUSE') { log(`port ${LISTEN_PORT} busy — already running`); process.exit(0); }
  console.error(err); process.exit(1);
});
