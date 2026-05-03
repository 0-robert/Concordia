// Tests pod-host running standalone on laptop (port 4000).
// Spawns server as child, runs through HTTP + WS relay contracts, kills.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert, summary, sleep, waitFor, getJSON, postJSON, openWs,
} from "./_helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const POD_HOST_DIR = join(REPO_ROOT, "concordia", "pod-host");
const PORT = 4000;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}`;

// ─── load API key from repo .env ─────────────────────────────────────────────
function loadEnv() {
  const env = {};
  try {
    const txt = readFileSync(join(REPO_ROOT, ".env"), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^([A-Z_]+)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch (e) {
    console.error("could not read .env:", e.message);
  }
  return env;
}

const env = { ...process.env, ...loadEnv(), PORT: String(PORT) };
if (!env.ANTHROPIC_API_KEY) {
  console.error("FATAL: ANTHROPIC_API_KEY not set");
  process.exit(1);
}

// ─── spawn server ────────────────────────────────────────────────────────────
console.log("starting pod-host…");
const child = spawn("node", ["server.js"], {
  cwd: POD_HOST_DIR,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (d) => { serverLog += d.toString(); process.stdout.write("  [pod-host] " + d); });
child.stderr.on("data", (d) => { serverLog += d.toString(); process.stderr.write("  [pod-host] " + d); });

const cleanup = () => { try { child.kill("SIGKILL"); } catch {} };
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(2); });

try {
  // Wait for server up
  await waitFor(async () => {
    try {
      const r = await getJSON(BASE + "/api/health");
      return r.status === 200;
    } catch { return false; }
  }, { timeoutMs: 8000 });

  console.log("\n# HTTP contracts");

  // 1. health
  let h = await getJSON(BASE + "/api/health");
  assert(h.status === 200, "GET /api/health → 200");
  assert(h.json && h.json.ok === true, "  body { ok: true }");
  assert(h.json.laptopConnected === false, "  laptopConnected=false (no laptop yet)");
  assert(h.json.phones === 0, "  phones=0");

  // 2. static index
  const idx = await fetch(BASE + "/").then((r) => ({ status: r.status, text: r.text() }));
  const idxText = await idx.text;
  assert(idx.status === 200, "GET / → 200");
  assert(idxText.includes("placeholder") || idxText.includes("html"), "  serves index.html");

  // 3. /api/bots before laptop = 503
  let b = await getJSON(BASE + "/api/bots");
  assert(b.status === 503, "GET /api/bots without laptop → 503");

  // 4. /api/claude bad body → 400
  let c = await postJSON(BASE + "/api/claude", { foo: "bar" });
  assert(c.status === 400, "POST /api/claude bad body → 400");

  // 5. /api/claude real call (1-token reply, cheap)
  console.log("# Claude proxy (real Anthropic call)");
  let cl = await postJSON(BASE + "/api/claude", {
    messages: [{ role: "user", content: "Reply with the single word: pong" }],
    max_tokens: 16,
  });
  assert(cl.status === 200, "POST /api/claude → 200");
  assert(cl.json && Array.isArray(cl.json.content), "  body has content array");
  const replyText = (cl.json?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .toLowerCase();
  assert(replyText.includes("pong"), `  reply contains 'pong' (got: ${replyText.slice(0, 40)})`);
  assert(!cl.text.includes(env.ANTHROPIC_API_KEY), "  response does NOT leak API key");

  console.log("\n# WS relay");

  // 6. open laptop ws + push bots cache
  const laptop = openWs(WS_BASE + "/ws/laptop");
  await laptop.ready();
  laptop.send({ type: "bots", payload: { bots: [{ name: "Alice" }, { name: "Bob" }] } });
  await sleep(100);
  let b2 = await getJSON(BASE + "/api/bots");
  assert(b2.status === 200, "GET /api/bots after laptop pushes → 200");
  assert(b2.json?.bots?.length === 2, "  cached payload returned");

  // 7. open phone ws + assert handshake
  const phoneA = openWs(WS_BASE + "/ws/phone");
  await phoneA.ready();
  const helloA = await phoneA.next();
  assert(helloA?.type === "hello" && helloA.sid, `phone gets {hello, sid} (sid=${helloA?.sid})`);

  // Laptop should have received phone_connect with that sid
  const lapEvt = await laptop.next();
  assert(
    lapEvt?.type === "phone_connect" && lapEvt.sid === helloA.sid,
    `laptop sees phone_connect sid=${lapEvt?.sid}`
  );

  // 8. phone → laptop relay
  phoneA.send({ id: "1", bot: "Alice", tool: "state", args: {} });
  const fwd = await laptop.next();
  assert(
    fwd?.type === "phone_msg" && fwd.sid === helloA.sid && fwd.payload?.tool === "state",
    "laptop receives phone_msg with sid + payload"
  );

  // 9. laptop → phone reply (sid-targeted)
  laptop.send({
    type: "phone_reply",
    sid: helloA.sid,
    payload: { id: "1", ok: true, result: { x: 1, y: 64, z: 3 } },
  });
  const reply = await phoneA.next();
  assert(reply?.id === "1" && reply.ok === true, "phone receives id-keyed reply");

  // 10. laptop → broadcast goes to all phones
  const phoneB = openWs(WS_BASE + "/ws/phone");
  await phoneB.ready();
  await phoneB.next(); // hello
  await laptop.next(); // phone_connect for B

  laptop.send({
    type: "broadcast",
    payload: { event: "tool_start", bot: "Alice", id: "x", tool: "mine" },
  });
  const bA = await phoneA.next();
  const bB = await phoneB.next();
  assert(bA?.event === "tool_start" && bA.bot === "Alice", "broadcast reaches phoneA");
  assert(bB?.event === "tool_start" && bB.bot === "Alice", "broadcast reaches phoneB");

  // 11. wrong-sid reply is dropped silently
  laptop.send({
    type: "phone_reply",
    sid: "nonexistent",
    payload: { id: "9", ok: true, result: "lost" },
  });
  await sleep(100);
  // no assertion needed — would have crashed/leaked if buggy. Health check:
  let h2 = await getJSON(BASE + "/api/health");
  assert(h2.json.laptopConnected === true, "health: laptopConnected=true");
  assert(h2.json.phones === 2, "health: 2 phones");

  // 12. phone disconnect → laptop notified
  await phoneA.close();
  const dc = await laptop.next();
  assert(
    dc?.type === "phone_disconnect" && dc.sid === helloA.sid,
    "laptop sees phone_disconnect on close"
  );

  await phoneB.close();
  await laptop.close();
} catch (e) {
  console.error("\nTEST CRASHED:", e);
  failed_panic();
}

function failed_panic() { cleanup(); process.exit(3); }

cleanup();
await sleep(200);
summary();
