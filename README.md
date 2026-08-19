# slack-notifier-agent

> A2A v0.3.0-compliant Slack notification agent powered by Claude. Receives requests from other agents (or the A2A Inspector), uses Claude to craft a friendly message, and posts it to Slack.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/lbrenman/slack-notifier-agent-ai-agent-a2a-helloworld)

## How It Works

1. Exposes an A2A v0.3.0-compliant HTTP server on port 3100
2. Any agent (or the A2A Inspector) discovers its capabilities via `GET /.well-known/agent-card.json`
3. Any agent sends a task via a JSON-RPC 2.0 `message/send` call to `POST /a2a`
4. Claude crafts a concise Slack message from the task input
5. The message is posted to your Slack channel

## Quick Start

```bash
git clone https://github.com/lbrenman/slack-notifier-agent-ai-agent-a2a-helloworld
cd slack-notifier-agent
npm install
cp .env.example .env    # fill in ANTHROPIC_API_KEY and SLACK_WEBHOOK
npm start
```

## Codespaces Setup

After the Codespace starts:
1. Fill in `.env` with your keys
2. Go to the **Ports** tab in VS Code, find port `3100`, set visibility to **Public**
3. Copy the public forwarded URL and set it as `PUBLIC_URL` in `.env` (this is what the Agent Card advertises as its `url`)
4. Run `npm start`
5. Paste the forwarded URL + `/.well-known/agent-card.json` into A2A Inspector to validate

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Your Anthropic API key |
| `SLACK_WEBHOOK` | ✅ | Slack Incoming Webhook URL |
| `PORT` | — | Port to listen on (default: `3100`) |
| `MODEL` | — | Claude model (default: `claude-opus-4-5-20251101`) |
| `PUBLIC_URL` | — | Public URL for this agent, used in the Agent Card's `url` field |

## A2A Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/.well-known/agent-card.json` | Agent Card (A2A v0.3.0 primary path) |
| `GET` | `/.well-known/agent.json` | Agent Card (v0.2.x alias, same content) |
| `POST` | `/a2a` | JSON-RPC 2.0 endpoint — `message/send`, `tasks/get`, `tasks/cancel` |
| `POST` | `/tasks` | **Legacy** — old REST-style task submission, kept for backward compatibility |

## A2A Request Format (JSON-RPC 2.0)

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "messageId": "msg-1",
      "kind": "message",
      "parts": [
        { "kind": "text", "text": "Your event summary here" }
      ]
    }
  }
}
```

Response is a [`Task`](https://a2a-protocol.org) object with `status.state` of `submitted` → `working` → `completed`/`failed`, and the crafted Slack message in `artifacts[0].parts[0].text`.

## Legacy Task Format (`POST /tasks`)

Kept only for older callers (e.g. an earlier `github-monitor-ai-agent-a2a-helloworld` build) that haven't been upgraded to JSON-RPC yet. New integrations should use `POST /a2a` above.

```json
{
  "id": "unique-task-id",
  "message": {
    "parts": [
      { "type": "text", "text": "Your event summary here" }
    ]
  }
}
```

## Control API + Web UI

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Web UI with live enable/disable toggle and activity log |
| `GET` | `/status` | JSON status |
| `POST` | `/enable` | Enable task processing |
| `POST` | `/disable` | Disable task processing |
