// Concordia host page.
//
// Boots a BrowserPod inside this tab, runs the MC server in it, then wires
// the in-pod viewer + command WS to the UI. User input → Claude → tool-use
// loop → bot.
//
// `?local=1` skips the pod and connects to localhost:3007/3008 (dev mode).

import { runClaudeTurn } from "./claude.js";
import { bootPod } from "./bootPod.js";

const params = new URLSearchParams(location.search);
const LOCAL_MODE = params.get("local") === "1";
const BOT_NAME = params.get("bot") || "Alice"; // Alice or Bob

document.title = `Concordia — ${BOT_NAME}`;
document.body.setAttribute("data-bot", BOT_NAME);
if (LOCAL_MODE) document.body.setAttribute("data-mode", "local");

// ─── DOM refs ────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const goalEl = $("goal");
const nowEl = $("now-action");
const invEl = $("inventory");
const logEl = $("log");
const chatForm = $("chat-form");
const chatInput = $("chat-input");

const botTagName = $("bot-tag-name");
if (botTagName) botTagName.textContent = BOT_NAME;

let CMD_WS = null;
let VIEWER_URL = null;

// ─── log / state ─────────────────────────────────────────────────────────────
function logEntry(html, cls = "") {
  const div = document.createElement("div");
  div.className = "log-entry " + cls;
  div.innerHTML = html;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  // cap entries
  while (logEl.children.length > 60) logEl.removeChild(logEl.firstChild);
}

function setStatus(text, connected = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("connected", connected);
}
function setGoal(text) { goalEl.textContent = text; }
function setNow(text) { nowEl.textContent = text; }

function renderInventory(items) {
  invEl.innerHTML = "";
  if (!items || items.length === 0) {
    invEl.innerHTML = `<div class="inv-item"><span class="name">empty</span></div>`;
    return;
  }
  for (const it of items) {
    const div = document.createElement("div");
    div.className = "inv-item";
    const dur = it.damage ? ` <span class="dur">⚠</span>` : "";
    div.innerHTML = `<span class="name">${it.name}</span><span class="count">×${it.count}${dur}</span>`;
    invEl.appendChild(div);
  }
}

// ─── WS plumbing ─────────────────────────────────────────────────────────────
let ws = null;
let nextId = 1;
const pending = new Map();

function call(tool, args = {}) {
  if (!ws || ws.readyState !== ws.OPEN) {
    return Promise.reject(new Error("not connected"));
  }
  const id = String(nextId++);
  const msg = { id, bot: BOT_NAME, tool, args };
  console.log("[ws>>]", msg);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(msg));
  });
}

function connect() {
  setStatus("connecting…");
  ws = new WebSocket(CMD_WS);
  ws.onopen = () => {
    setStatus("connected", true);
    logEntry(`<span class="ok">★ connected to bot</span>`);
    refreshInventory();
  };
  ws.onclose = () => {
    setStatus("disconnected — retrying…");
    setTimeout(connect, 1500);
  };
  ws.onerror = () => { /* onclose handles retry */ };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    console.log("[ws<<]", msg);

    // Events FIRST. tool_start/tool_end carry `bot` field; only show ours.
    if (msg.event === "tool_start") {
      if (msg.bot !== BOT_NAME) return; // not for us
      setNow(`${msg.tool}(${formatArgs(msg.args)})`);
      logEntry(`<span class="tool">→ ${msg.tool}</span> <span class="args">${formatArgs(msg.args)}</span>`);
      return;
    }
    if (msg.event === "tool_end") {
      if (msg.bot !== BOT_NAME) return;
      if (msg.ok) {
        logEntry(`<span class="ok">  ✓ ${msg.tool}</span> <span class="args">${truncate(JSON.stringify(msg.result))}</span>`);
      } else {
        logEntry(`<span class="err">  ✗ ${msg.tool}</span> <span class="args">${msg.error}</span>`);
      }
      if (["mine", "equip", "craft"].includes(msg.tool)) refreshInventory();
      return;
    }
    if (msg.event === "hello") {
      const bots = msg.bots?.length ? msg.bots.join(", ") : "(none)";
      logEntry(`<span class="args">connected — bots in world: ${bots}, controlling: ${BOT_NAME}</span>`);
      if (!msg.bots?.includes(BOT_NAME)) {
        logEntry(`<span class="err">⚠ bot '${BOT_NAME}' not found in pod — try ?bot=Alice or ?bot=Bob</span>`);
      }
      return;
    }
    if (msg.event === "bot_event") return; // reserved

    // Tool response (id-keyed, no event field)
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(String(msg.error || "(no error message)")));
      }
      return;
    }
  };
}

function formatArgs(args) {
  if (!args || Object.keys(args).length === 0) return "";
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === "string" ? `"${v}"` : v}`)
    .join(", ");
}
function truncate(s, n = 80) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

async function refreshInventory() {
  try {
    const items = await call("inventory");
    renderInventory(items);
  } catch {}
}

// ─── user input → Claude tool-use loop → bot ─────────────────────────────────

// We carry forward the full conversation so Claude remembers prior turns
// (e.g. "now stop" should make sense in context).
let conversationHistory = [];

async function handleUserMessage(text) {
  logEntry(`<span class="speaker">you ▸</span> ${text}`, "user");
  setGoal(text);
  setNow("thinking…");
  chatForm.querySelector("button").disabled = true;

  try {
    conversationHistory = await runClaudeTurn(text, call, {
      botName: BOT_NAME,
      messages: conversationHistory,
      onStep: (e) => {
        if (e.kind === "thinking") {
          setNow(`claude thinking (turn ${e.turn + 1})…`);
        } else if (e.kind === "assistant_text") {
          logEntry(
            `<span class="label-inline">CLAUDE THINKING</span>${escapeHtml(e.text)}`,
            "claude-think"
          );
        } else if (e.kind === "tool_call") {
          // The server's tool_start broadcast will also fire — this just
          // gives us a claude-level trace of the reasoning. Skip to avoid dup.
        } else if (e.kind === "tool_result") {
          // Same — server broadcasts tool_end already.
        }
      },
    });
    setNow("idle");
  } catch (e) {
    const msg = e.message || JSON.stringify(e) || "unknown";
    logEntry(`<span class="err">claude error: ${msg}</span>`);
    setNow("error: " + msg);
    console.error("claude err:", e);
  } finally {
    chatForm.querySelector("button").disabled = false;
    refreshInventory();
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// ─── wire UI ─────────────────────────────────────────────────────────────────
chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = "";
  handleUserMessage(text);
});
for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => {
    chatInput.value = chip.textContent;
    chatInput.focus();
  });
}

// ─── boot ────────────────────────────────────────────────────────────────────

(async function bootEverything() {
  try {
    if (LOCAL_MODE) {
      setStatus("local mode — connecting to localhost…");
      logEntry(`<span class="args">[local] using ws://localhost:3008 + http://localhost:3007</span>`);
      VIEWER_URL = "http://localhost:3007";
      CMD_WS = "ws://localhost:3008";
    } else {
      setStatus("booting pod…");
      logEntry(`<span class="args">★ booting BrowserPod (this can take 1-3 min on first boot)…</span>`);
      const podTermEl = $("pod-terminal") || (() => {
        // create a hidden div if HTML doesn't have one — pod docs say don't unmount it
        const el = document.createElement("div");
        el.id = "pod-terminal";
        el.style.position = "absolute";
        el.style.opacity = "0";
        el.style.pointerEvents = "none";
        el.style.width = "1px";
        el.style.height = "1px";
        document.body.appendChild(el);
        return el;
      })();

      const { viewerUrl, cmdWsUrl } = await bootPod({
        terminalEl: podTermEl,
        log: (s) => logEntry(`<span class="args">${escapeHtml(s)}</span>`),
      });
      VIEWER_URL = viewerUrl;
      CMD_WS = cmdWsUrl;
    }

    $("viewer").src = VIEWER_URL;
    connect();
  } catch (e) {
    setStatus("boot failed");
    logEntry(`<span class="err">boot failed: ${escapeHtml(e.message || String(e))}</span>`);
    console.error("boot failed:", e);
  }
})();
