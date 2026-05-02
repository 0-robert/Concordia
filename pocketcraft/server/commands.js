// Command WebSocket server with multi-bot routing.
//
// Message shape:
//   { id, bot, tool, args }      ← bot is the bot's username
// Response:
//   { id, ok, result }            on success
//   { id, ok: false, error }      on failure
//
// Events broadcast (no id-keyed response, identified by event field):
//   { event: "hello", bots: [...], tools: [...] }
//   { event: "tool_start", bot, id, tool, args }
//   { event: "tool_end", bot, id, tool, ok, result|error }
//   { event: "bot_event", bot, type, ... }
//
// Backward compat: if msg.bot is missing AND there's only one bot, route
// to that one (so single-agent demos / older test clients still work).

const { WebSocketServer } = require("ws");

class CommandServer {
  constructor({ port, log, onRelayUrl }) {
    this.port = port;
    this.log = log || (() => {});
    this.bots = new Map(); // name → { tools }
    this.clients = new Set();
    // Sinks fired alongside client broadcasts — used by relayBridge to
    // forward broadcasts up to the pod, so phones connected through the
    // relay see the same events.
    this.broadcastSinks = new Set();
    // Called when POST /relay-url arrives. Lets server/index.js (re)spawn
    // the relayBridge against a freshly-booted pod portal.
    this.onRelayUrl = onRelayUrl || (() => {});
  }

  /** Snapshot of current bots, suitable for /api/bots payload. */
  listBots() {
    return Array.from(this.bots.entries()).map(([name, info]) => ({
      name,
      viewerPort: info.viewerPort,
      tools: Object.keys(info.tools),
    }));
  }

  addBroadcastSink(fn) { this.broadcastSinks.add(fn); }
  removeBroadcastSink(fn) { this.broadcastSinks.delete(fn); }

  /** Register a bot + its tool set + its viewer port (for /bots endpoint). */
  registerBot(name, tools, viewerPort = null) {
    this.bots.set(name, { tools, viewerPort });
    this.log("cmd", `registered bot '${name}' (${Object.keys(tools).length} tools)`);
  }

  start() {
    // We attach the WS server to an http.Server so the same port also
    // serves a tiny REST endpoint (/bots) that the host page polls to
    // discover bot names + their viewer ports. Saves a separate port.
    const http = require("node:http");
    const httpServer = http.createServer((req, res) => {
      const cors = (origin) => {
        res.setHeader("Access-Control-Allow-Origin", origin || "*");
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      };
      cors(req.headers.origin);
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        return res.end();
      }

      if (req.method === "GET" && req.url === "/bots") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          bots: this.listBots(),
          overviewPort: global.__overviewPort || null,
        }));
        return;
      }

      // POST /relay-url  body: {url}  — TV screen tells us where the
      // pod-host's WS relay lives, so we can dial out.
      if (req.method === "POST" && req.url === "/relay-url") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const { url } = JSON.parse(body || "{}");
            if (typeof url !== "string" || !url.startsWith("ws")) {
              throw new Error("expected { url: 'ws(s)://...' }");
            }
            this.onRelayUrl(url);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: e.message || String(e) }));
          }
        });
        return;
      }

      res.statusCode = 404;
      res.end("not found");
    });
    this.wss = new WebSocketServer({ server: httpServer });
    httpServer.listen(this.port, "0.0.0.0", () => {
      this.log("cmd", `WS command server on 0.0.0.0:${this.port}`);
    });
    this.wss.on("error", (e) => this.log("cmd-err", e.message));

    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      this.log("cmd", `client connected (${this.clients.size} total)`);
      ws.on("close", () => {
        this.clients.delete(ws);
        this.log("cmd", `client disconnected (${this.clients.size} total)`);
      });
      ws.on("message", (data) => this.handleMessage(ws, data));

      // Greet — list bots and their tools
      const bots = Array.from(this.bots.keys());
      const sampleTools =
        this.bots.size > 0
          ? Object.keys([...this.bots.values()][0].tools)
          : [];
      ws.send(JSON.stringify({ event: "hello", bots, tools: sampleTools }));
    });
  }

  resolveBot(maybeName) {
    if (maybeName && this.bots.has(maybeName)) return maybeName;
    if (!maybeName && this.bots.size === 1) return [...this.bots.keys()][0];
    return null;
  }

  async handleMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ ok: false, error: "invalid_json" }));
      return;
    }
    return this.handleParsedMessage(msg, (obj) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    });
  }

  /**
   * Process an already-parsed message. `sendBack(obj)` is called for any
   * id-keyed reply (success or error). Used by both the local WS server
   * (handleMessage) and the relay bridge (which translates sendBack into
   * a pod-host phone_reply envelope).
   */
  async handleParsedMessage(msg, sendBack) {
    // "thought" messages from a phone client are broadcast to all clients
    // (including the main screen) so judges see Claude's reasoning live.
    if (msg.type === "thought") {
      this.broadcast({ event: "thought", bot: msg.bot, text: msg.text });
      return;
    }
    // "user_input" messages — broadcast so main screen shows what each
    // judge typed at their bot.
    if (msg.type === "user_input") {
      this.broadcast({ event: "user_input", bot: msg.bot, text: msg.text });
      return;
    }

    const { id, bot: botName, tool, args } = msg;

    const resolved = this.resolveBot(botName);
    if (!resolved) {
      sendBack({
        id,
        ok: false,
        error: `unknown_bot: '${botName || "(none)"}', available: ${[...this.bots.keys()].join(",") || "none"}`,
      });
      return;
    }
    const fn = this.bots.get(resolved).tools[tool];
    if (!fn) {
      sendBack({ id, ok: false, error: `unknown_tool: '${tool}' for bot '${resolved}'` });
      return;
    }

    this.broadcast({ event: "tool_start", bot: resolved, id, tool, args });
    try {
      const result = await fn(args || {});
      sendBack({ id, ok: true, result });
      this.broadcast({ event: "tool_end", bot: resolved, id, tool, ok: true, result });
    } catch (e) {
      const error =
        (e && e.message) ||
        (e && e.name) ||
        (e && e.stack && e.stack.split("\n")[0]) ||
        (typeof e === "string" ? e : JSON.stringify(e)) ||
        "unknown_error";
      this.log("cmd-err", `bot=${resolved} tool=${tool} err=${error}`);
      if (e && e.stack) this.log("cmd-stack", e.stack);
      sendBack({ id, ok: false, error });
      this.broadcast({ event: "tool_end", bot: resolved, id, tool, ok: false, error });
    }
  }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(s);
    }
    for (const fn of this.broadcastSinks) {
      try { fn(obj); } catch (e) { this.log("sink-err", e?.message); }
    }
  }
}

module.exports = { CommandServer };
