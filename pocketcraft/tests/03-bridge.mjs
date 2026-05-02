// Tests laptop relayBridge wired to pod-host via outbound WS.
// Uses a stub CommandServer (in-process) instead of real flying-squid.
//
// Phone-side simulation:
//   1. GET /api/bots   ← bridge pushed bots cache
//   2. WS /ws/phone    ← send tool, expect reply via bridge
//   3. WS broadcast    ← stub triggers cmdServer.broadcast(...)
//
// Run: node 03-bridge.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  assert, summary, sleep, waitFor, getJSON, openWs,
} from "./_helpers.mjs";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const POD_HOST_DIR = join(REPO_ROOT, "pocketcraft", "pod-host");
const PORT = 4001;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}`;

function loadEnv() {
  const env = {};
  try {
    const txt = readFileSync(join(REPO_ROOT, ".env"), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^([A-Z_]+)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
  return env;
}

const env = { ...process.env, ...loadEnv(), PORT: String(PORT) };
if (!env.ANTHROPIC_API_KEY) {
  console.error("FATAL: ANTHROPIC_API_KEY not set"); process.exit(1);
}

// ─── spawn pod-host ──────────────────────────────────────────────────────────
console.log("starting pod-host on :" + PORT + "…");
const child = spawn("node", ["server.js"], {
  cwd: POD_HOST_DIR,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => process.stdout.write("  [pod-host] " + d));
child.stderr.on("data", (d) => process.stderr.write("  [pod-host] " + d));
const cleanup = () => { try { child.kill("SIGKILL"); } catch {} };
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(2); });

await waitFor(async () => {
  try { return (await getJSON(BASE + "/api/health")).status === 200; } catch { return false; }
}, { timeoutMs: 8000 });

// ─── stub CommandServer ──────────────────────────────────────────────────────
// Implements: listBots(), addBroadcastSink, removeBroadcastSink,
// handleParsedMessage(msg, sendBack), broadcast(obj).
const stub = {
  bots: [
    { name: "Alice", viewerPort: 3007, tools: ["state", "chat"] },
    { name: "Bob",   viewerPort: 3017, tools: ["state", "chat"] },
  ],
  broadcastSinks: new Set(),
  listBots() { return this.bots; },
  addBroadcastSink(fn) { this.broadcastSinks.add(fn); },
  removeBroadcastSink(fn) { this.broadcastSinks.delete(fn); },
  broadcast(obj) {
    for (const fn of this.broadcastSinks) fn(obj);
  },
  async handleParsedMessage(msg, sendBack) {
    if (msg.type === "thought" || msg.type === "user_input") {
      this.broadcast({ event: msg.type, bot: msg.bot, text: msg.text });
      return;
    }
    if (msg.tool === "state") {
      this.broadcast({ event: "tool_start", bot: msg.bot, id: msg.id, tool: "state", args: msg.args });
      sendBack({ id: msg.id, ok: true, result: { pos: { x: 0, y: 64, z: 0 } } });
      this.broadcast({ event: "tool_end", bot: msg.bot, id: msg.id, tool: "state", ok: true, result: {} });
      return;
    }
    if (msg.tool === "boom") {
      sendBack({ id: msg.id, ok: false, error: "intentional" });
      return;
    }
    sendBack({ id: msg.id, ok: false, error: `unknown_tool: ${msg.tool}` });
  },
};

// ─── start the bridge ────────────────────────────────────────────────────────
const { startRelayBridge } = require("../server/relayBridge");
const bridge = startRelayBridge({
  relayUrl: WS_BASE + "/ws/laptop",
  cmdServer: stub,
  log: (tag, ...m) => console.log(`  [${tag}]`, ...m),
});

try {
  // Wait for bridge to connect
  await waitFor(() => bridge.isConnected(), { timeoutMs: 3000 });
  console.log("\n# Bridge wired");

  // 0. Static bundle served from /
  console.log("\n# Static phone bundle");
  const idxResp = await fetch(BASE + "/");
  const idxHtml = await idxResp.text();
  assert(idxResp.status === 200, "GET / → 200");
  assert(idxHtml.includes("Pocketcraft"), "  index has 'Pocketcraft' title");
  assert(idxHtml.match(/\/assets\/phone-[\w]+\.js/), "  references /assets/phone-*.js");
  // Spot-check the JS bundle contains the relative-URL strings
  const jsMatch = idxHtml.match(/\/assets\/phone-[\w]+\.js/);
  if (jsMatch) {
    const jsResp = await fetch(BASE + jsMatch[0]);
    assert(jsResp.status === 200, `  GET ${jsMatch[0]} → 200`);
  }
  const claudeBundle = idxHtml.match(/\/assets\/claude-[\w]+\.js/)?.[0];
  if (claudeBundle) {
    const cb = await fetch(BASE + claudeBundle).then(r => r.text());
    assert(cb.includes("/api/claude"), "  claude bundle references /api/claude");
    assert(cb.includes("legacy"), "  claude bundle has legacy toggle");
  }
  const phoneBundle = idxHtml.match(/\/assets\/phone-[\w]+\.js/)?.[0];
  if (phoneBundle) {
    const pb = await fetch(BASE + phoneBundle).then(r => r.text());
    assert(pb.includes("/api/bots"), "  phone bundle references /api/bots");
    assert(pb.includes("/ws/phone"), "  phone bundle references /ws/phone");
  }

  // 1. /api/bots reflects the bridge push
  await sleep(200); // give the "bots" message time to land
  const r = await getJSON(BASE + "/api/bots");
  assert(r.status === 200, "GET /api/bots → 200 (bridge pushed)");
  assert(r.json?.bots?.length === 2, "  2 bots cached");
  assert(r.json.bots[0].name === "Alice", "  Alice present");

  // 2. Phone sends tool → bridge → stub → bridge → phone
  const phone = openWs(WS_BASE + "/ws/phone");
  await phone.ready();
  const hello = await phone.next();
  assert(hello?.type === "hello", "phone gets hello");

  phone.send({ id: "p1", bot: "Alice", tool: "state", args: {} });
  // We expect three msgs to phone: tool_start broadcast, reply, tool_end broadcast.
  // Order: stub broadcasts tool_start first (sync), then sends reply, then tool_end.
  const m1 = await phone.next();
  const m2 = await phone.next();
  const m3 = await phone.next();
  const events = [m1, m2, m3];
  // A reply has no `event` field (broadcasts do); has `id` and `ok`.
  const reply = events.find((m) => m?.id === "p1" && !m.event && "ok" in m);
  const start = events.find((m) => m?.event === "tool_start");
  const end   = events.find((m) => m?.event === "tool_end");
  assert(reply?.ok === true, "phone gets id-keyed reply via bridge");
  assert(reply?.result?.pos?.y === 64, "  reply payload intact");
  assert(start?.tool === "state", "phone gets tool_start broadcast");
  assert(end?.tool === "state" && end.ok === true, "phone gets tool_end broadcast");

  // 3. Tool error path
  phone.send({ id: "p2", bot: "Alice", tool: "boom", args: {} });
  const errReply = await phone.next();
  assert(errReply?.id === "p2" && errReply.ok === false, "error reply returned");
  assert(errReply.error === "intentional", "  error message preserved");

  // 4. Stub-initiated broadcast (e.g. bot chat) reaches phone
  stub.broadcast({ event: "bot_event", bot: "Alice", type: "chat", message: "hi" });
  const evt = await phone.next();
  assert(evt?.event === "bot_event" && evt.message === "hi", "stub broadcast reaches phone via bridge");

  // 5. Bridge reconnect: kill pod-host, verify bridge backs off, restart, verify reconnect
  console.log("\n# Bridge reconnect");
  child.kill("SIGTERM");
  await waitFor(() => !bridge.isConnected(), { timeoutMs: 3000 });
  assert(!bridge.isConnected(), "bridge detects disconnect");

  // Restart pod-host
  const child2 = spawn("node", ["server.js"], {
    cwd: POD_HOST_DIR, env, stdio: ["ignore", "pipe", "pipe"],
  });
  child2.stdout.on("data", (d) => process.stdout.write("  [pod-host*] " + d));
  child2.stderr.on("data", (d) => process.stderr.write("  [pod-host*] " + d));
  process.once("exit", () => { try { child2.kill("SIGKILL"); } catch {} });

  await waitFor(async () => {
    try { return (await getJSON(BASE + "/api/health")).status === 200; } catch { return false; }
  }, { timeoutMs: 8000 });
  await waitFor(() => bridge.isConnected(), { timeoutMs: 8000 });
  assert(bridge.isConnected(), "bridge reconnects to restarted pod-host");

  // After reconnect, /api/bots should be re-pushed automatically
  await sleep(300);
  const r2 = await getJSON(BASE + "/api/bots");
  assert(r2.status === 200, "  /api/bots refilled after reconnect");
  assert(r2.json?.bots?.length === 2, "  bot list re-pushed");

  child2.kill("SIGTERM");
  await sleep(200);
} catch (e) {
  console.error("\nTEST CRASHED:", e);
  bridge.close(); cleanup(); process.exit(3);
}

bridge.close();
cleanup();
await sleep(200);
summary();
