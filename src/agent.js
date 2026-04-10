/**
 * slack-notifier-agent — A2A Server
 *
 * Exposes an A2A-compliant HTTP server:
 *   GET  /.well-known/agent.json  → Agent Card
 *   POST /tasks                   → Accept task, use Claude, post to Slack
 *
 * Control API + Web UI (same server):
 *   GET  /          → Web UI with live toggle
 *   GET  /status    → JSON status
 *   POST /enable    → Enable task processing
 *   POST /disable   → Disable task processing
 */

require('dotenv').config();
const http = require('http');
const Anthropic = require('@anthropic-ai/sdk');

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT          = parseInt(process.env.PORT || '3100', 10);
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;
const MODEL         = process.env.MODEL || 'claude-opus-4-5-20251101';

if (!SLACK_WEBHOOK) { console.error('[error] SLACK_WEBHOOK is required'); process.exit(1); }

const anthropic = new Anthropic();

// ─── State ────────────────────────────────────────────────────────────────────

let enabled          = true;
let tasksReceived    = 0;
let tasksCompleted   = 0;
let tasksSkipped     = 0;
let lastTaskTime     = null;
let lastSlackMessage = null;
let recentLog        = [];

function addLog(msg) {
  const entry = { ts: new Date().toISOString(), msg };
  recentLog.unshift(entry);
  if (recentLog.length > 10) recentLog.pop();
  console.log(`[${entry.ts}] ${msg}`);
}

// ─── Agent Card ───────────────────────────────────────────────────────────────

const AGENT_CARD = {
  name: 'slack-notifier-agent',
  description: 'Receives event summaries from other agents and posts intelligent Slack notifications crafted by Claude.',
  version: '1.0.0',
  capabilities: { streaming: false, pushNotifications: false },
  skills: [
    {
      id: 'notify_slack',
      name: 'Notify Slack',
      description: 'Takes an event description, uses Claude to craft a concise Slack message, and posts it to a configured channel.',
      inputModes: ['text'],
      outputModes: ['text'],
    },
  ],
};

// ─── Claude ───────────────────────────────────────────────────────────────────

async function craftSlackMessage(input) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: `You are a Slack notification writer. Given a GitHub activity summary sent by another AI agent, 
write a concise, friendly Slack message. Use plain text only — no markdown headers or bullet points. 
You may use a single relevant emoji at the start. Keep it under 100 words.`,
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

// ─── A2A Task Handler ─────────────────────────────────────────────────────────

async function handleTask(task) {
  tasksReceived++;
  const parts = task?.message?.parts || [];
  const textPart = parts.find(p => p.type === 'text');
  if (!textPart?.text) throw new Error('No text input found in task');

  addLog(`Task received [${task.id}]: "${textPart.text.slice(0, 80)}..."`);

  if (!enabled) {
    tasksSkipped++;
    addLog(`Task skipped — agent is disabled.`);
    return {
      id: task.id,
      status: { state: 'failed', message: 'Agent is currently disabled.' },
      artifacts: [],
    };
  }

  addLog('Asking Claude to craft Slack message...');
  const message = await craftSlackMessage(textPart.text);
  addLog(`Claude crafted: "${message.slice(0, 80)}..."`);

  await postToSlack(message);
  addLog('Posted to Slack ✓');

  lastTaskTime = new Date().toISOString();
  lastSlackMessage = message;
  tasksCompleted++;

  return {
    id: task.id,
    status: { state: 'completed' },
    artifacts: [{ parts: [{ type: 'text', text: message }] }],
  };
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
  <p class="subtitle">A2A Server &nbsp;·&nbsp; Receives tasks, crafts Slack messages with Claude &nbsp;·&nbsp; Auto-refreshes every 10s</p>

  <div class="card">
    <div class="status-row">
      <div class="badge">${statusText}</div>
      <span class="pill">received: ${tasksReceived}</span>
      <span class="pill">completed: ${tasksCompleted}</span>
      <span class="pill">skipped: ${tasksSkipped}</span>
    </div>
    <div class="meta">
      Last task: <span>${lastTaskTime || '—'}</span><br>
      Agent Card: <span>/.well-known/agent.json</span><br>
      Tasks endpoint: <span>POST /tasks</span>
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

// ─── HTTP Server ──────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data, type = 'application/json') {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  if (method === 'OPTIONS') return send(res, 204, '');

  // Web UI
  if (method === 'GET' && url === '/') {
    return send(res, 200, renderUI(), 'text/html');
  }

  // JSON status
  if (method === 'GET' && url === '/status') {
    return send(res, 200, {
      enabled,
      tasksReceived,
      tasksCompleted,
      tasksSkipped,
      lastTaskTime,
      lastSlackMessage,
    });
  }

  // Enable / disable
  if (method === 'POST' && url === '/enable') {
    enabled = true;
    addLog('Agent ENABLED via API.');
    return send(res, 200, { enabled });
  }

  if (method === 'POST' && url === '/disable') {
    enabled = false;
    addLog('Agent DISABLED via API.');
    return send(res, 200, { enabled });
  }

  // Agent Card
  if (method === 'GET' && url === '/.well-known/agent.json') {
    addLog('Agent Card requested.');
    return send(res, 200, AGENT_CARD);
  }

  // A2A task submission
  if (method === 'POST' && url === '/tasks') {
    try {
      const task = await readBody(req);
      const result = await handleTask(task);
      return send(res, 200, result);
    } catch (err) {
      addLog(`Error handling task: ${err.message}`);
      return send(res, 500, { error: err.message });
    }
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║      slack-notifier-agent  v2.0.0          ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log(`Port       : ${PORT}`);
  console.log(`Web UI     : http://localhost:${PORT}/`);
  console.log(`Agent Card : http://localhost:${PORT}/.well-known/agent.json`);
  console.log(`Tasks      : http://localhost:${PORT}/tasks`);
  console.log(`Model      : ${MODEL}`);
  console.log('\nNOTE: In Codespaces, set port', PORT, 'to Public visibility in the Ports tab.\n');
});
