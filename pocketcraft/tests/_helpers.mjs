// Tiny test helpers — keep deps minimal (no jest/vitest, runs via `node`).

import WebSocket from "ws";

let passed = 0, failed = 0;
const failures = [];

export function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); return; }
  failed++;
  failures.push(msg);
  console.log(`  ✗ ${msg}`);
}

export function summary() {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.log(`  FAIL: ${f}`);
    process.exit(1);
  }
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await predicate();
    if (v) return v;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

export async function postJSON(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: resp.status, text, json };
}

export async function getJSON(url) {
  const resp = await fetch(url);
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: resp.status, text, json };
}

export function openWs(url) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { msg = data.toString(); }
    const w = waiters.shift();
    if (w) w(msg); else inbox.push(msg);
  });
  function next(timeoutMs = 3000) {
    if (inbox.length) return Promise.resolve(inbox.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("openWs.next timeout")), timeoutMs);
      waiters.push((m) => { clearTimeout(t); resolve(m); });
    });
  }
  function send(obj) { ws.send(JSON.stringify(obj)); }
  function ready() {
    if (ws.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
  }
  function close() {
    return new Promise((r) => { ws.once("close", r); ws.close(); });
  }
  return { ws, inbox, next, send, ready, close };
}
