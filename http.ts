#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const PORT = Number(process.env.CLAUDE_HTTP_PORT) || 3284;

// ── Types ──

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

// ── State ──

const messages: Message[] = [];
const sseClients = new Set<ReadableStreamDirectController>();
let status: "stable" | "running" = "stable";
let nextChatId = 1;

// ── SSE helpers ──

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function broadcast(event: string, data: unknown) {
  const payload = sseEvent(event, data);
  for (const client of sseClients) {
    try {
      client.write(payload);
      client.flush();
    } catch {
      sseClients.delete(client);
    }
  }
}

function setStatus(s: "stable" | "running") {
  if (status === s) return;
  status = s;
  broadcast("status", { status: s });
}

// ── MCP channel server ──

const mcp = new Server(
  { name: "http-router", version: "1.0.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      'Messages arrive as <channel source="http-router" chat_id="...">.',
      "These are messages from a user via HTTP. Read and respond helpfully.",
      "Reply using the reply tool, passing back the chat_id from the tag.",
      "You may call reply multiple times for the same chat_id (e.g. for long responses).",
      "When you are done responding, call the done tool with the chat_id.",
    ].join(" "),
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Send a response message back to the user. Can be called multiple times per chat_id.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: {
            type: "string",
            description: "The chat_id from the inbound channel tag",
          },
          text: {
            type: "string",
            description: "The response text to send",
          },
        },
        required: ["chat_id", "text"],
      },
    },
    {
      name: "done",
      description:
        "Signal that you are done responding to a chat_id. Call after your final reply.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: {
            type: "string",
            description: "The chat_id you are done responding to",
          },
        },
        required: ["chat_id"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "reply") {
    const { chat_id, text } = req.params.arguments as {
      chat_id: string;
      text: string;
    };
    const msg: Message = {
      role: "assistant",
      content: text,
      timestamp: new Date().toISOString(),
    };
    messages.push(msg);
    broadcast("message", msg);
    return { content: [{ type: "text", text: "sent" }] };
  }

  if (req.params.name === "done") {
    setStatus("stable");
    return { content: [{ type: "text", text: "done" }] };
  }

  throw new Error(`unknown tool: ${req.params.name}`);
});

await mcp.connect(new StdioServerTransport());

// ── HTTP server ──

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // ── POST /message ──
    // Accepts { content: string, type?: "user" } or plain text.
    // Returns 200 once the message is delivered to Claude.
    if (req.method === "POST" && path === "/message") {
      const contentType = req.headers.get("content-type") || "";
      let content: string;

      if (contentType.includes("application/json")) {
        const json = (await req.json()) as { content?: string };
        content = json.content || "";
      } else {
        content = await req.text();
      }

      if (!content.trim()) {
        return Response.json({ error: "empty message" }, { status: 400 });
      }

      const chat_id = String(nextChatId++);
      const msg: Message = {
        role: "user",
        content,
        timestamp: new Date().toISOString(),
      };
      messages.push(msg);
      broadcast("message", msg);
      setStatus("running");

      // Push to Claude via channel notification
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content,
          meta: { chat_id },
        },
      });

      return Response.json({ ok: true, chat_id });
    }

    // ── GET /messages ──
    if (req.method === "GET" && path === "/messages") {
      return Response.json(messages);
    }

    // ── GET /status ──
    if (req.method === "GET" && path === "/status") {
      return Response.json({ status });
    }

    // ── GET /events — SSE stream of message and status updates ──
    if (req.method === "GET" && path === "/events") {
      const stream = new ReadableStream({
        type: "direct",
        pull(controller) {
          sseClients.add(controller);
          // Send current state on connect
          controller.write(sseEvent("status", { status }));
          controller.flush();
          return new Promise<void>(() => {});
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // ── GET /chat — web UI ──
    if (req.method === "GET" && path === "/chat") {
      return new Response(Bun.file("./chat.html"));
    }

    // ── GET /health ──
    if (req.method === "GET" && path === "/health") {
      return Response.json({ status: "ok", port: PORT });
    }

    // ── Fallback — list endpoints ──
    return Response.json({
      endpoints: {
        "POST /message":
          'Send a message to Claude. Body: { "content": "...", "type": "user" } or plain text.',
        "GET /messages": "Get conversation history.",
        "GET /status": "Get agent status: stable | running.",
        "GET /events": "SSE stream of message and status events.",
        "GET /health": "Health check.",
      },
    });
  },
});

console.error(`http-router listening on http://127.0.0.1:${PORT}`);
console.error(`Chat UI: http://127.0.0.1:${PORT}/chat`);
