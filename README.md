# slack-notifier-agent

> A2A-compliant Slack notification agent powered by Claude. Receives task requests from other agents, uses Claude to craft a friendly message, and posts it to Slack.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/lbrenman/slack-notifier-agent)

## How It Works

1. Exposes an A2A-compliant HTTP server on port 3100
2. Any agent can discover its capabilities via `GET /.well-known/agent.json`
3. Any agent can send a task via `POST /tasks`
4. Claude crafts a concise Slack message from the task input
5. The message is posted to your Slack channel

## Quick Start

```bash
git clone https://github.com/lbrenman/slack-notifier-agent
cd slack-notifier-agent
npm install
cp .env.example .env    # fill in ANTHROPIC_API_KEY and SLACK_WEBHOOK
npm start
```

## Codespaces Setup

After the Codespace starts:
1. Fill in `.env` with your keys
2. Run `npm start`
3. Go to the **Ports** tab in VS Code
4. Find port `3100` — make sure visibility is set to **Public**
5. Copy the public forwarded URL — you'll paste it into `github-monitor`'s `.env` as `NOTIFIER_URL`

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Your Anthropic API key |
| `SLACK_WEBHOOK` | ✅ | Slack Incoming Webhook URL |
| `PORT` | — | Port to listen on (default: `3100`) |
| `MODEL` | — | Claude model (default: `claude-opus-4-5-20251101`) |

## A2A Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/.well-known/agent.json` | Agent Card — capability advertisement |
| `POST` | `/tasks` | Submit a task for the agent to handle |

## A2A Task Format

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
