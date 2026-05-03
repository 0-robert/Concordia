// Concordia pod-host.
//
// Runs inside the BrowserPod sandbox (or on laptop for testing). Three jobs:
//
//   1. HTTP: serve phone.html + bundle (static), proxy Claude API
//   2. WS relay: laptop dials in (/ws/laptop), phones dial in (/ws/phone),
//      we route messages between them using per-phone session ids.
//   3. /api/bots cache: laptop pushes bot list once, phones GET it.
//
// Why this shape: BrowserPod portal URLs are HTTPS-only, so phones served
// from here can't open ws:// to the laptop directly (mixed content). And
// the venue blocks tunneling services, so we can't tunnel laptop ports
// either. Solution: invert direction — laptop opens an OUTBOUND ws to the
// pod, pod relays to phones. One public URL (the portal) is enough.

const path = require("path");
const http = require("http");

// BrowserPod's WASM node 22 has a broken Buffer.isUtf8 that throws "this
// should be unreachable" on any text frame. The ws library detects this
// method at module load and uses it unconditionally. Delete it BEFORE
// requiring ws so its pure-JS fallback is selected.
if (typeof Buffer !== "undefined" && Buffer.isUtf8) {
  try { delete Buffer.isUtf8; } catch {}
  if (Buffer.isUtf8) Buffer.isUtf8 = undefined;
}

const express = require("express");
const { WebSocketServer } = require("ws");

process.on("uncaughtException", (e) => {
  console.error("[uncaught]", e?.stack || e?.message || String(e), JSON.stringify(e));
});
process.on("unhandledRejection", (e) => {
  console.error("[unhandled-rej]", e?.stack || e?.message || String(e), JSON.stringify(e));
});

const PORT = Number(process.env.PORT || 4000);
const API_KEY = process.env.ANTHROPIC_API_KEY;
const DEFAULT_MODEL =
  process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

if (!API_KEY) {
  console.error("[pod-host] FATAL: ANTHROPIC_API_KEY missing in env");
  process.exit(1);
}

const log = (tag, ...m) => console.log(`[${tag}]`, ...m);

// ─── HTTP ────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "2mb" }));

// CORS — phones are same-origin once served from here, but during local dev
// the bundle may load from a different port. Wide open is fine; no secrets
// are returned in any response body.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    laptopConnected: laptopWs?.readyState === 1,
    phones: phones.size,
    bots: botsCache?.bots?.length ?? null,
    ts: Date.now(),
  });
});

// Bot list cache. Laptop pushes via WS; phones GET here.
let botsCache = null;
app.get("/api/bots", (_req, res) => {
  if (!botsCache) return res.status(503).json({ error: "laptop_not_connected" });
  res.json(botsCache);
});

// Claude proxy — pure passthrough. Holds the API key.
app.post("/api/claude", async (req, res) => {
  try {
    const { messages, tools, system, model, max_tokens } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "messages must be an array" });
    }
    const params = {
      model: model || DEFAULT_MODEL,
      max_tokens: max_tokens ?? 1024,
      messages,
    };
    if (system) params.system = system;
    if (tools) params.tools = tools;

    log("claude", `POST  msgs=${messages.length}  tools=${tools?.length || 0}`);
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(params),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", "application/json");
    res.end(text);
  } catch (e) {
    log("claude-err", e?.message || e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ─── WS relay ────────────────────────────────────────────────────────────────
const httpServer = http.createServer(app);
// skipUTF8Validation: BrowserPod's WASM node 22 has a broken Buffer.isUtf8
// (throws "this should be unreachable"); ws calls it on every text frame.
// All our frames are JSON, which is UTF-8 by construction — skipping the
// check is safe and necessary to run in-pod.
const wsOpts = { noServer: true, skipUTF8Validation: true };
const laptopWss = new WebSocketServer(wsOpts);
const phoneWss = new WebSocketServer(wsOpts);

httpServer.on("upgrade", (req, sock, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, "http://x").pathname;
  } catch {
    return sock.destroy();
  }
  if (pathname === "/ws/laptop") {
    laptopWss.handleUpgrade(req, sock, head, (ws) =>
      laptopWss.emit("connection", ws, req)
    );
  } else if (pathname === "/ws/phone") {
    phoneWss.handleUpgrade(req, sock, head, (ws) =>
      phoneWss.emit("connection", ws, req)
    );
  } else {
    sock.destroy();
  }
});

// State: at most one laptop, many phones (sid → ws).
let laptopWs = null;
const phones = new Map();

function genSid() {
  return (
    Math.random().toString(36).slice(2, 10) +
    Date.now().toString(36).slice(-4)
  );
}

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify(obj));
}

laptopWss.on("connection", (ws) => {
  if (laptopWs && laptopWs.readyState === 1) {
    log("relay", "laptop reconnect — closing previous");
    try { laptopWs.close(); } catch {}
  }
  laptopWs = ws;
  log("relay", `laptop connected (${phones.size} phones already here)`);

  // Inform laptop of any existing phones so it can resync state if needed.
  for (const sid of phones.keys()) {
    safeSend(ws, { type: "phone_connect", sid });
  }

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.type) {
      case "bots":
        botsCache = msg.payload;
        log("relay", `laptop pushed bot list (${msg.payload?.bots?.length ?? "?"} bots)`);
        return;

      case "phone_reply": {
        const target = phones.get(msg.sid);
        safeSend(target, msg.payload);
        return;
      }

      case "broadcast": {
        const s = JSON.stringify(msg.payload);
        for (const phone of phones.values()) {
          if (phone.readyState === 1) phone.send(s);
        }
        return;
      }

      default:
        log("relay-warn", `unknown msg.type from laptop: ${msg.type}`);
    }
  });

  ws.on("close", () => {
    if (laptopWs === ws) laptopWs = null;
    log("relay", "laptop disconnected");
  });
  ws.on("error", (e) => log("relay-err", "laptop ws:", e?.message));
});

phoneWss.on("connection", (ws) => {
  const sid = genSid();
  phones.set(sid, ws);
  log("relay", `phone ${sid} connected (${phones.size} total)`);

  // Tell phone its sid so it can include it in messages if useful (and so
  // tests can correlate).
  safeSend(ws, { type: "hello", sid });
  safeSend(laptopWs, { type: "phone_connect", sid });

  ws.on("message", (data) => {
    let payload;
    try { payload = JSON.parse(data.toString()); } catch { return; }
    safeSend(laptopWs, { type: "phone_msg", sid, payload });
  });

  ws.on("close", () => {
    phones.delete(sid);
    safeSend(laptopWs, { type: "phone_disconnect", sid });
    log("relay", `phone ${sid} disconnected (${phones.size} total)`);
  });
  ws.on("error", (e) => log("relay-err", `phone ${sid} ws:`, e?.message));
});

httpServer.listen(PORT, () => {
  log("pod-host", `listening on :${PORT}  model=${DEFAULT_MODEL}`);
});
