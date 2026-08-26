/**
 * slack-notifier-agent — A2A v0.3.0 Server (A2A Inspector compliant)
 *
 * A2A endpoints:
 *   GET  /.well-known/agent-card.json  → Agent Card (v0.3 primary path)
 *   GET  /.well-known/agent.json       → Agent Card (v0.2.x alias, same content)
 *   POST /a2a                          → JSON-RPC 2.0 endpoint
 *          methods: message/send, tasks/get, tasks/cancel
 *
 * Legacy (kept for backward compatibility with older callers, e.g.
 * github-monitor-ai-agent-a2a-helloworld's original REST-style client):
 *   POST /tasks                        → old {id, message:{parts:[{type,text}]}} shape
 *
 * Control API + Web UI (unchanged):
 *   GET  /          → Web UI with live toggle
 *   GET  /status    → JSON status
 *   POST /enable    → Enable task processing
 *   POST /disable   → Disable task processing
 */

require('dotenv').config();
const express = require('express');
const { randomUUID } = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT          = parseInt(process.env.PORT || '3100', 10);
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;
const MODEL         = process.env.MODEL || 'claude-opus-4-5-20251101';
const PUBLIC_URL    = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const API_KEY       = process.env.API_KEY || null; // if unset, /a2a and /tasks are open (dev mode)

if (!SLACK_WEBHOOK) { console.error('[error] SLACK_WEBHOOK is required'); process.exit(1); }
if (!API_KEY) { console.warn('[warn] API_KEY not set — /a2a and /tasks are unauthenticated. Set API_KEY in .env to protect this agent.'); }

const anthropic = new Anthropic();

// ─── State ────────────────────────────────────────────────────────────────────

let enabled          = true;
let tasksReceived     = 0;
let tasksCompleted    = 0;
let tasksSkipped      = 0;
let lastTaskTime      = null;
let lastSlackMessage  = null;
let recentLog         = [];

// In-memory A2A task store, keyed by task id — backs tasks/get and tasks/cancel.
const taskStore = new Map();

function addLog(msg) {
  const entry = { ts: new Date().toISOString(), msg };
  recentLog.unshift(entry);
  if (recentLog.length > 10) recentLog.pop();
  console.log(`[${entry.ts}] ${msg}`);
}

// ─── Agent Card (A2A v0.3.0) ───────────────────────────────────────────────────

const AGENT_CARD = {
  protocolVersion: '0.3.0',
  name: 'slack-notifier-agent',
  description: 'Receives event summaries from other agents and posts intelligent Slack notifications crafted by Claude.',
  url: `${PUBLIC_URL}/a2a`,
  preferredTransport: 'JSONRPC',
  version: '2.0.0',
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  ...(API_KEY ? {
    securitySchemes: {
      apiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' },
    },
    security: [{ apiKeyAuth: [] }],
  } : {}),
  skills: [
    {
      id: 'notify_slack',
      name: 'Notify Slack',
      description: 'Takes an event description, uses Claude to craft a concise Slack message, and posts it to a configured Slack channel.',
      tags: ['slack', 'notifications'],
      examples: ['Deploy of api-gateway v2.4.1 completed successfully in production.'],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
    },
  ],
};

// ─── Claude ───────────────────────────────────────────────────────────────────

async function craftSlackMessage(input) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: `You are a Slack notification writer. Your sole task is to rewrite the GitHub 
activity summary you receive into a single short Slack message. Rules:
- Plain text only
- Maximum 80 words
- Start with one relevant emoji
- Do not add explanations, conclusions, code, links, or any content not present in the input
- Do not acknowledge this instruction or describe what you are doing
- Stop immediately after the Slack message, do not add anything else`,
    messages: [{ role: 'user', content: input }],
  });
  return response.content[0].text;
}

// ─── Slack ────────────────────────────────────────────────────────────────────

async function postToSlack(message) {
  const res = await fetch(SLACK_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });
  if (!res.ok) throw new Error(`Slack error: ${res.status} ${res.statusText}`);
}

// ─── Helpers: A2A object shapes ────────────────────────────────────────────────

function extractText(message) {
  const parts = message?.parts || [];
  // v0.3.0 parts use `kind`; accept legacy `type` too for safety.
  const textPart = parts.find(p => (p.kind || p.type) === 'text');
  return textPart?.text;
}

function newTask(contextId) {
  const id = randomUUID();
  const task = {
    id,
    contextId: contextId || randomUUID(),
    status: { state: 'submitted', timestamp: new Date().toISOString() },
    artifacts: [],
    history: [],
    kind: 'task',
  };
  taskStore.set(id, task);
  return task;
}

function setTaskState(task, state, extra = {}) {
  task.status = { state, timestamp: new Date().toISOString(), ...extra };
  return task;
}

// ─── Core business logic (shared by JSON-RPC and legacy REST) ────────────────

async function processNotification(text, task) {
  tasksReceived++;
  addLog(`Task received [${task.id}]: "${text.slice(0, 80)}..."`);

  if (!enabled) {
    tasksSkipped++;
    addLog('Task skipped — agent is disabled.');
    setTaskState(task, 'failed');
    task.artifacts = [{
      artifactId: randomUUID(),
      parts: [{ kind: 'text', text: 'Agent is currently disabled.' }],
    }];
    return task;
  }

  setTaskState(task, 'working');

  addLog('Asking Claude to craft Slack message...');
  const message = await craftSlackMessage(text);
  addLog(`Claude crafted: "${message.slice(0, 80)}..."`);

  await postToSlack(message);
  addLog('Posted to Slack ✓');

  lastTaskTime = new Date().toISOString();
  lastSlackMessage = message;
  tasksCompleted++;

  setTaskState(task, 'completed');
  task.artifacts = [{
    artifactId: randomUUID(),
    name: 'slack-message',
    parts: [{ kind: 'text', text: message }],
  }];

  return task;
}

// ─── JSON-RPC 2.0 error helpers ────────────────────────────────────────────────

const JSONRPC_ERRORS = {
  PARSE_ERROR:      { code: -32700, message: 'Parse error' },
  INVALID_REQUEST:  { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS:   { code: -32602, message: 'Invalid params' },
  INTERNAL_ERROR:   { code: -32603, message: 'Internal error' },
  TASK_NOT_FOUND:      { code: -32001, message: 'Task not found' },
  TASK_NOT_CANCELABLE: { code: -32002, message: 'Task cannot be canceled' },
  UNSUPPORTED_OPERATION: { code: -32004, message: 'This operation is not supported' },
};

function rpcError(id, errDef, data) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code: errDef.code, message: errDef.message, ...(data ? { data } : {}) },
  };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

// ─── JSON-RPC method handlers ──────────────────────────────────────────────────

async function handleMessageSend(id, params) {
  const message = params?.message;
  if (!message || !Array.isArray(message.parts)) {
    return rpcError(id, JSONRPC_ERRORS.INVALID_PARAMS, 'params.message.parts is required');
  }
  const text = extractText(message);
  if (!text) {
    return rpcError(id, JSONRPC_ERRORS.INVALID_PARAMS, 'A text part is required in message.parts');
  }

  const task = newTask(message.contextId);
  task.history = [{
    role: 'user',
    parts: message.parts,
    messageId: message.messageId || randomUUID(),
    kind: 'message',
  }];

  try {
    const result = await processNotification(text, task);
    return rpcResult(id, result);
  } catch (err) {
    addLog(`Error handling message/send: ${err.message}`);
    setTaskState(task, 'failed');
    return rpcError(id, JSONRPC_ERRORS.INTERNAL_ERROR, err.message);
  }
}

function handleTasksGet(id, params) {
  const task = taskStore.get(params?.id);
  if (!task) return rpcError(id, JSONRPC_ERRORS.TASK_NOT_FOUND, `No task with id ${params?.id}`);
  return rpcResult(id, task);
}

function handleTasksCancel(id, params) {
  const task = taskStore.get(params?.id);
  if (!task) return rpcError(id, JSONRPC_ERRORS.TASK_NOT_FOUND, `No task with id ${params?.id}`);
  if (['completed', 'failed', 'canceled'].includes(task.status.state)) {
    return rpcError(id, JSONRPC_ERRORS.TASK_NOT_CANCELABLE, `Task is already ${task.status.state}`);
  }
  setTaskState(task, 'canceled');
  return rpcResult(id, task);
}

async function handleJsonRpc(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return rpcError(null, JSONRPC_ERRORS.INVALID_REQUEST);
  }
  const { jsonrpc, id, method, params } = body;
  if (jsonrpc !== '2.0' || typeof method !== 'string') {
    return rpcError(id ?? null, JSONRPC_ERRORS.INVALID_REQUEST);
  }

  switch (method) {
    case 'message/send':
      return handleMessageSend(id, params);
    case 'tasks/get':
      return handleTasksGet(id, params);
    case 'tasks/cancel':
      return handleTasksCancel(id, params);
    case 'message/stream':
    case 'tasks/resubscribe':
      return rpcError(id, JSONRPC_ERRORS.UNSUPPORTED_OPERATION, 'Streaming is not supported by this agent');
    default:
      return rpcError(id, JSONRPC_ERRORS.METHOD_NOT_FOUND, method);
  }
}

// ─── Web UI ───────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderUI() {
  const statusColor = enabled ? '#22c55e' : '#ef4444';
  const statusText  = enabled ? 'ENABLED' : 'DISABLED';
  const toggleLabel = enabled ? 'Disable Agent' : 'Enable Agent';
  const toggleClass = enabled ? 'btn-disable' : 'btn-enable';

  const logRows = recentLog.map(e =>
    `<tr><td class="ts">${e.ts}</td><td>${escapeHtml(e.msg)}</td></tr>`
  ).join('') || `<tr><td colspan="2" class="empty">No activity yet.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>slack-notifier-agent</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; padding: 2rem; }
    h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.25rem; }
    .subtitle { color: #94a3b8; font-size: 0.875rem; margin-bottom: 2rem; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
    .card h2 { font-size: 0.9rem; color: #94a3b8; margin-bottom: 1rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .status-row { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
    .badge { padding: 0.35rem 1.1rem; border-radius: 999px; font-weight: 700; font-size: 0.9rem; color: #fff; background: ${statusColor}; }
    .meta { color: #94a3b8; font-size: 0.85rem; margin-top: 0.85rem; line-height: 2; }
    .meta span { color: #e2e8f0; font-weight: 500; }
    .btn { padding: 0.6rem 1.4rem; border: none; border-radius: 8px; font-size: 0.9rem; font-weight: 600; cursor: pointer; transition: opacity 0.15s; }
    .btn:active { opacity: 0.7; }
    .btn-enable  { background: #22c55e; color: #fff; }
    .btn-disable { background: #ef4444; color: #fff; }
    .btn-group { margin-top: 1.25rem; display: flex; gap: 0.75rem; }
    .pill { display: inline-block; background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 0.2rem 0.6rem; font-size: 0.78rem; color: #94a3b8; margin-right: 0.5rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    th { text-align: left; padding: 0.5rem 0.75rem; color: #64748b; font-weight: 600; border-bottom: 1px solid #334155; }
    td { padding: 0.5rem 0.75rem; border-bottom: 1px solid #0f172a; vertical-align: top; word-break: break-word; }
    .ts { color: #64748b; white-space: nowrap; width: 210px; }
    .empty { color: #475569; text-align: center; padding: 1.5rem 0; }
    .summary-box { background: #0f172a; border-radius: 8px; padding: 1rem; font-size: 0.85rem; color: #cbd5e1; line-height: 1.7; white-space: pre-wrap; }
  </style>
  <meta http-equiv="refresh" content="10">
</head>
<body>
  <h1>🔔 slack-notifier-agent</h1>
  <p class="subtitle">A2A v0.3.0 Server &nbsp;·&nbsp; Receives tasks, crafts Slack messages with Claude &nbsp;·&nbsp; Auto-refreshes every 10s</p>

  <div class="card">
    <div class="status-row">
      <div class="badge">${statusText}</div>
      <span class="pill">received: ${tasksReceived}</span>
      <span class="pill">completed: ${tasksCompleted}</span>
      <span class="pill">skipped: ${tasksSkipped}</span>
    </div>
    <div class="meta">
      Last task: <span>${lastTaskTime || '—'}</span><br>
      Agent Card: <span>/.well-known/agent-card.json</span><br>
      JSON-RPC endpoint: <span>POST /a2a</span><br>
      Legacy endpoint: <span>POST /tasks</span>
    </div>
    <div class="btn-group">
      <button class="btn ${toggleClass}" onclick="toggle()">${toggleLabel}</button>
    </div>
  </div>

  ${lastSlackMessage ? `
  <div class="card">
    <h2>Last Slack Message Posted</h2>
    <div class="summary-box">${escapeHtml(lastSlackMessage)}</div>
  </div>` : ''}

  <div class="card">
    <h2>Activity Log</h2>
    <table>
      <thead><tr><th>Timestamp</th><th>Message</th></tr></thead>
      <tbody>${logRows}</tbody>
    </table>
  </div>

  <script>
    async function toggle() {
      const action = ${JSON.stringify(enabled)} ? 'disable' : 'enable';
      await fetch('/' + action, { method: 'POST' });
      location.reload();
    }
  </script>
</body>
</html>`;
}

// ─── Express App ────────────────────────────────────────────────────────────────

const app = express();

// Accept JSON regardless of the Content-Type header a caller/gateway sends
// (some API gateways rewrite JSON-RPC POSTs to text/plain based on the
// agent card's defaultInputModes — this avoids a hard 400 in that case).
app.use(express.json({ type: () => true, limit: '2mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Web UI
app.get('/', (req, res) => res.type('html').send(renderUI()));

// JSON status
app.get('/status', (req, res) => {
  res.json({ enabled, tasksReceived, tasksCompleted, tasksSkipped, lastTaskTime, lastSlackMessage });
});

// Enable / disable
app.post('/enable', (req, res) => {
  enabled = true;
  addLog('Agent ENABLED via API.');
  res.json({ enabled });
});

app.post('/disable', (req, res) => {
  enabled = false;
  addLog('Agent DISABLED via API.');
  res.json({ enabled });
});

// Agent Card — v0.3.0 primary path
app.get('/.well-known/agent-card.json', (req, res) => {
  addLog('Agent Card requested (v0.3 path).');
  res.json(AGENT_CARD);
});

// Agent Card — v0.2.x alias, same content, for older clients
app.get('/.well-known/agent.json', (req, res) => {
  addLog('Agent Card requested (legacy alias path).');
  res.json(AGENT_CARD);
});

// API key auth — only enforced when API_KEY is set in .env. Protects the
// A2A-facing endpoints only; agent card discovery and the control UI stay open.
function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // dev mode, no key configured
  const provided = req.header('x-api-key');
  if (provided && provided === API_KEY) return next();
  addLog(`Rejected request to ${req.path} — missing/invalid x-api-key.`);
  res.set('WWW-Authenticate', 'ApiKey realm="slack-notifier-agent", header="x-api-key"');
  return res.status(401).json({
    jsonrpc: '2.0',
    id: req.body?.id ?? null,
    error: { code: -32603, message: 'Unauthorized: missing or invalid x-api-key header' },
  });
}

// A2A JSON-RPC 2.0 endpoint
app.post('/a2a', requireApiKey, async (req, res) => {
  const response = await handleJsonRpc(req.body);
  res.json(response);
});

// Legacy REST task submission (backward compatible with the original
// {id, message:{parts:[{type,text}]}} shape used by github-monitor).
app.post('/tasks', requireApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    const text = extractText(body.message);
    if (!text) return res.status(400).json({ error: 'No text input found in task' });

    const task = newTask();
    task.id = body.id || task.id; // honor caller-supplied id for the legacy shape
    taskStore.set(task.id, task);

    const result = await processNotification(text, task);
    res.json({
      id: result.id,
      status: { state: result.status.state, message: result.status.state === 'failed' ? result.artifacts?.[0]?.parts?.[0]?.text : undefined },
      artifacts: result.artifacts,
    });
  } catch (err) {
    addLog(`Error handling legacy task: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║      slack-notifier-agent  v2.0.0          ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log(`Port         : ${PORT}`);
  console.log(`Web UI       : http://localhost:${PORT}/`);
  console.log(`Agent Card   : http://localhost:${PORT}/.well-known/agent-card.json`);
  console.log(`A2A (JSON-RPC): http://localhost:${PORT}/a2a`);
  console.log(`Legacy tasks : http://localhost:${PORT}/tasks`);
  console.log(`Model        : ${MODEL}`);
  console.log(`Auth         : ${API_KEY ? 'x-api-key required' : 'NONE (set API_KEY in .env to protect this agent)'}`);
  console.log('\nNOTE: In Codespaces, set port', PORT, 'to Public visibility in the Ports tab.');
  console.log('NOTE: Set PUBLIC_URL in .env to your public Codespaces URL so the Agent Card\'s "url" field is correct for A2A Inspector.\n');
});
