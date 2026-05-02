// Command WebSocket server.
//
// Accepts JSON messages of shape:
//   { id?: string, tool: string, args: object }
// and responds with:
//   { id, ok: true, result }   on success
//   { id, ok: false, error }   on failure
//
// Also broadcasts unsolicited events so the host page can render an
// "agent loop" panel:
//   { event: "tool_start" | "tool_end" | "bot_event", ... }
//
// Tools are registered via registerTool(name, async fn).

const { WebSocketServer } = require("ws");

class CommandServer {
  constructor({ port, log }) {
    this.port = port;
    this.log = log || (() => {});
    this.tools = new Map();
    this.clients = new Set();
  }

  registerTool(name, fn) {
    this.tools.set(name, fn);
  }

  start() {
    this.wss = new WebSocketServer({ port: this.port, host: "0.0.0.0" });
    this.wss.on("listening", () =>
      this.log("cmd", `WS command server on :${this.port}`)
    );
    this.wss.on("error", (e) => this.log("cmd-err", e.message));

    this.wss.on("connection", (ws, req) => {
      this.clients.add(ws);
      this.log("cmd", `client connected (${this.clients.size} total)`);
      ws.on("close", () => {
        this.clients.delete(ws);
        this.log("cmd", `client disconnected (${this.clients.size} total)`);
      });
      ws.on("message", (data) => this.handleMessage(ws, data));
      // Greet
      ws.send(
        JSON.stringify({
          event: "hello",
          tools: Array.from(this.tools.keys()),
        })
      );
    });
  }

  async handleMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      ws.send(JSON.stringify({ ok: false, error: "invalid_json" }));
      return;
    }
    const { id, tool, args } = msg;
    const fn = this.tools.get(tool);
    if (!fn) {
      ws.send(
        JSON.stringify({ id, ok: false, error: `unknown_tool: ${tool}` })
      );
      return;
    }

    this.broadcast({ event: "tool_start", id, tool, args });
    try {
      const result = await fn(args || {});
      ws.send(JSON.stringify({ id, ok: true, result }));
      this.broadcast({ event: "tool_end", id, tool, ok: true, result });
    } catch (e) {
      const error = e?.message || String(e);
      ws.send(JSON.stringify({ id, ok: false, error }));
      this.broadcast({ event: "tool_end", id, tool, ok: false, error });
    }
  }

  /** Send an event to all connected clients. */
  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(s);
    }
  }
}

module.exports = { CommandServer };
