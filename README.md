# Agent HTTP

An HTTP API for Claude Code, built as a native [MCP channel](https://code.claude.com/docs/en/channels-reference). Send messages to Claude Code over HTTP and get responses back — no terminal screen-scraping, no TUI parsing. Messages flow through Claude's native channel protocol.

The API is compatible with [agentapi](https://github.com/coder/agentapi) (`POST /message`, `GET /messages`, `GET /status`, `GET /events`), so it can serve as a drop-in replacement for agentapi in projects that only need Claude Code support.

## How it works

agent-http is an MCP channel server that Claude Code spawns as a subprocess. It bridges HTTP and Claude Code's internal messaging system:

1. You send an HTTP request to the server
2. The server pushes it to Claude Code via the MCP channel protocol
3. Claude processes the message and calls the `reply` tool to send responses back
4. Responses are stored in conversation history and broadcast to SSE listeners

Unlike agentapi, which wraps any CLI agent by running it in a virtual terminal and parsing screen output, agent-http uses Claude Code's native channel system. Messages are exact — no terminal diffing, no TUI artifact stripping, no heuristics that break when the CLI updates.

| | agentapi | agent-http |
|---|---|---|
| Integration | Screen-scrapes a terminal emulator | Native MCP channel protocol |
| Message fidelity | Approximated from terminal diffs | Exact |
| Multi-agent support | Claude, Aider, Goose, Codex, etc. | Claude Code only |
| Fragility | Can break on TUI changes | Stable — uses documented MCP contract |

## Setup

Requires [Bun](https://bun.sh) and [Claude Code](https://code.claude.com) v2.1.80+.

```bash
bun install
```

## Usage

Start Claude Code with the channel loaded:

```bash
claude --dangerously-load-development-channels server:http-router
```

Claude Code reads `.mcp.json`, spawns the server, and the HTTP API starts on port 3284.

To use a custom port, update `.mcp.json`:

```json
{
  "mcpServers": {
    "http-router": {
      "command": "bun",
      "args": ["./http.ts", "--port", "8080"]
    }
  }
}
```

## API

### Send a message

```bash
curl -X POST localhost:3284/message \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello, Claude!", "type": "user"}'
```

Returns immediately with `{ "ok": true, "chat_id": "1" }` once Claude starts processing. Also accepts plain text:

```bash
curl -X POST localhost:3284/message -d "What files are in this directory?"
```

### Get conversation history

```bash
curl localhost:3284/messages
```

Returns an array of all messages:

```json
[
  { "role": "user", "content": "Hello!", "timestamp": "2025-03-19T..." },
  { "role": "assistant", "content": "Hi there!", "timestamp": "2025-03-19T..." }
]
```

### Check agent status

```bash
curl localhost:3284/status
```

Returns `{ "status": "stable" }` when idle or `{ "status": "running" }` when processing a message.

### Stream events (SSE)

```bash
curl -N localhost:3284/events
```

Server-Sent Events stream that broadcasts `message` and `status` events in real-time:

```
event: status
data: {"status":"running"}

event: message
data: {"role":"assistant","content":"Hello!","timestamp":"2025-03-19T..."}

event: status
data: {"status":"stable"}
```

### Chat UI

A simple web chat interface is available at:

```
http://localhost:3284/chat
```

### Chat UI

A web chat interface is included for testing and demos:

```
http://localhost:3284/chat
```

It connects to the same API endpoints — messages sent from the chat UI show up in `/messages` and vice versa.

### Health check

```bash
curl localhost:3284/health
```

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `--port` flag | `3284` | Set via `.mcp.json` args: `["./http.ts", "--port", "8080"]` |
| `CLAUDE_HTTP_PORT` env | `3284` | Set via `.mcp.json` env or shell environment |

Priority: `--port` flag > `CLAUDE_HTTP_PORT` env > `3284` default.

## Programmatic usage

### Node.js / Bun

```ts
// Send a message
const res = await fetch("http://localhost:3284/message", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content: "Explain this codebase" }),
});
const { chat_id } = await res.json();

// Poll for completion
const poll = async () => {
  while (true) {
    const status = await fetch("http://localhost:3284/status").then(r => r.json());
    if (status.status === "stable") break;
    await new Promise(r => setTimeout(r, 1000));
  }
  return fetch("http://localhost:3284/messages").then(r => r.json());
};

const messages = await poll();
console.log(messages.at(-1).content);
```

### Python

```python
import requests
import time

# Send a message
requests.post("http://localhost:3284/message", json={
    "content": "What does this project do?",
    "type": "user"
})

# Wait for response
while True:
    status = requests.get("http://localhost:3284/status").json()
    if status["status"] == "stable":
        break
    time.sleep(1)

# Get the response
messages = requests.get("http://localhost:3284/messages").json()
print(messages[-1]["content"])
```

### SSE listener

```ts
const events = new EventSource("http://localhost:3284/events");

events.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  console.log(`[${msg.role}] ${msg.content}`);
});

events.addEventListener("status", (e) => {
  const { status } = JSON.parse(e.data);
  console.log(`Agent is ${status}`);
});
```
