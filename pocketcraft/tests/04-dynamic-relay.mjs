// Tests dynamic relay-URL handshake (POST /relay-url → bridge spawns).
// Uses real CommandServer (with stubbed bot tools) + real relayBridge.
// Pod-host runs on laptop (not in pod) — pod-specific transport is
// covered separately by manual browser test.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  assert, summary, sleep, waitFor, getJSON, postJSON, openWs,
} from "./_helpers.mjs";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const POD_HOST_DIR = join(REPO_ROOT, "concordia", "pod-host");

const POD_PORT = 4002;
const LAPTOP_PORT = 4003; // stand-in for laptop's :3008
const POD_BASE = `http://127.0.0.1:${POD_PORT}`;
const POD_WS_BASE = `ws://127.0.0.1:${POD_PORT}`;
const LAPTOP_BASE = `http://127.0.0.1:${LAPTOP_PORT}`;

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

const env = { ...process.env, ...loadEnv(), PORT: String(POD_PORT) };
if (!env.ANTHROPIC_API_KEY) {
  console.error("FATAL: ANTHROPIC_API_KEY not set"); process.exit(1);
}

// ─── spawn pod-host (laptop-side) ────────────────────────────────────────────
console.log(`starting pod-host on :${POD_PORT}…`);
const podChild = spawn("node", ["server.js"], {
  cwd: POD_HOST_DIR, env, stdio: ["ignore", "pipe", "pipe"],
});
podChild.stdout.on("data", (d) => process.stdout.write("  [pod-host] " + d));
podChild.stderr.on("data", (d) => process.stderr.write("  [pod-host] " + d));
const cleanup = () => {
  try { podChild.kill("SIGKILL"); } catch {}
  try { laptop.activeBridge?.close?.(); } catch {}
  try { laptop.cmd?.wss?.close?.(); } catch {}
};
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(2); });

await waitFor(async () => {
  try { return (await getJSON(POD_BASE + "/api/health")).status === 200; } catch { return false; }
}, { timeoutMs: 8000 });

// ─── start a "laptop" CommandServer in-process ───────────────────────────────
// Real CommandServer wired with stub bot tools + real relayBridge handler.
const { CommandServer } = require("../server/commands");
const { startRelayBridge } = require("../server/relayBridge");

const stubTools = {
  state: async () => ({ pos: { x: 1, y: 64, z: 2 } }),
  chat: async ({ text }) => ({ said: text }),
};

const laptop = { cmd: null, activeBridge: null };
laptop.cmd = new CommandServer({
  port: LAPTOP_PORT,
  log: (tag, ...m) => console.log(`  [laptop:${tag}]`, ...m),
  onRelayUrl: (url) => {
    console.log(`  [laptop] onRelayUrl invoked: ${url}`);
    if (laptop.activeBridge) laptop.activeBridge.close();
    laptop.activeBridge = startRelayBridge({
      relayUrl: url,
      cmdServer: laptop.cmd,
      log: (tag, ...m) => console.log(`  [laptop:${tag}]`, ...m),
    });
  },
});
laptop.cmd.registerBot("Alice", stubTools, 3007);
laptop.cmd.registerBot("Bob",   stubTools, 3017);
laptop.cmd.start();

await waitFor(async () => {
  try {
    const r = await getJSON(LAPTOP_BASE + "/bots");
    return r.status === 200;
  } catch { return false; }
}, { timeoutMs: 5000 });

try {
  console.log("\n# Pre-handshake state");

  // /api/bots on pod should be 503 — bridge not connected yet
  let pre = await getJSON(POD_BASE + "/api/bots");
  assert(pre.status === 503, "pod /api/bots → 503 (no bridge yet)");

  // laptop /bots should work directly
  let lb = await getJSON(LAPTOP_BASE + "/bots");
  assert(lb.status === 200 && lb.json.bots.length === 2, "laptop /bots → 200, 2 bots");

  console.log("\n# POST /relay-url");

  // Bad payload → 400
  let bad = await postJSON(LAPTOP_BASE + "/relay-url", { nope: 1 });
  assert(bad.status === 400, "bad body → 400");
  let bad2 = await postJSON(LAPTOP_BASE + "/relay-url", { url: "http://not-ws" });
  assert(bad2.status === 400, "non-ws url → 400");

  // Real handshake
  const relayUrl = `${POD_WS_BASE}/ws/laptop`;
  let ok = await postJSON(LAPTOP_BASE + "/relay-url", { url: relayUrl });
  assert(ok.status === 200 && ok.json.ok === true, "POST /relay-url → 200 ok:true");

  // Bridge should connect within a couple seconds
  await waitFor(() => laptop.activeBridge?.isConnected?.() === true, { timeoutMs: 4000 });
  assert(laptop.activeBridge.isConnected(), "bridge connected after POST /relay-url");

  // Pod /api/bots should now be populated
  await sleep(300);
  let post = await getJSON(POD_BASE + "/api/bots");
  assert(post.status === 200, "pod /api/bots → 200 after handshake");
  assert(post.json.bots?.length === 2, "  2 bots cached in pod");

  console.log("\n# Round-trip via dynamic bridge");

  // Phone connects to pod, sends tool, expects reply through bridge → CommandServer → bridge → pod → phone
  const phone = openWs(POD_WS_BASE + "/ws/phone");
  await phone.ready();
  const hello = await phone.next();
  assert(hello?.type === "hello", "phone hello arrives");

  phone.send({ id: "rt1", bot: "Alice", tool: "state", args: {} });
  // Expect: tool_start broadcast, reply, tool_end broadcast
  const events = [await phone.next(), await phone.next(), await phone.next()];
  const reply = events.find((m) => m?.id === "rt1" && !m.event && "ok" in m);
  const start = events.find((m) => m?.event === "tool_start");
  const end = events.find((m) => m?.event === "tool_end");
  assert(reply?.ok === true, "phone gets reply via dynamic bridge");
  assert(reply?.result?.pos?.y === 64, "  reply payload intact");
  assert(start?.tool === "state", "phone gets tool_start");
  assert(end?.tool === "state" && end.ok === true, "phone gets tool_end");

  console.log("\n# Replace bridge mid-flight");

  // Simulate the user reloading main.html — a new pod URL is POSTed.
  // Bridge should be replaced cleanly.
  const oldBridge = laptop.activeBridge;
  ok = await postJSON(LAPTOP_BASE + "/relay-url", { url: relayUrl });
  assert(ok.status === 200, "second POST /relay-url → 200");
  await sleep(500);
  assert(laptop.activeBridge !== oldBridge, "bridge instance was replaced");
  assert(laptop.activeBridge.isConnected(), "  new bridge connected");

  await phone.close();
} catch (e) {
  console.error("\nTEST CRASHED:", e);
  cleanup();
  process.exit(3);
}

cleanup();
await sleep(200);
summary();
process.exit(0);
