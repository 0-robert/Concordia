// Pocketcraft phone control.
//
// One judge per phone. Each phone is bound to one bot via ?bot=<name>.
// If no bot is given, show a picker.
//
// User types in chat → Claude tool-use loop → bot acts → updates broadcast
// to the main screen.

import { runClaudeTurn } from "./claude.js";
import { makeClient } from "./wsClient.js";

const params = new URLSearchParams(location.search);
let BOT_NAME = params.get("bot");

// Two paths:
//   default: served from pod-host (HTTPS portal). All endpoints are
//            relative to the current origin: /api/bots, /api/claude,
//            wss://.../ws/phone.
//   ?legacy=1 (or ?host=...): direct-LAN demo path — pod is unused, phone
//            talks to laptop on :3008 (REST + ws://) and laptop's :3009 proxy.
const LEGACY = params.get("legacy") === "1" || params.has("host");
const SERVER_HOST = params.get("host") || `${location.hostname}:3008`;
const WS_URL = LEGACY
  ? `ws://${SERVER_HOST}`
  : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/phone`;
const HTTP_BASE = LEGACY ? `http://${SERVER_HOST}` : "";
const BOTS_URL = LEGACY ? `${HTTP_BASE}/bots` : "/api/bots";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const goalEl = $("goal");
const logEl = $("log");
const chatForm = $("chat-form");
const chatInput = $("chat-input");
const botPill = $("bot-pill");

document.body.setAttribute("data-bot", BOT_NAME || "");

function logEntry(html, cls = "") {
  const div = document.createElement("div");
  div.className = "log-entry " + cls;
  div.innerHTML = html;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  while (logEl.children.length > 80) logEl.removeChild(logEl.firstChild);
}
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function setStatus(s, ok = false) {
  statusEl.textContent = s;
  statusEl.classList.toggle("connected", ok);
}
function setGoal(t) { goalEl.textContent = t; }

// ─── pick a bot if none given ────────────────────────────────────────────────
async function ensureBot() {
  if (BOT_NAME) {
    botPill.textContent = `controlling: ${BOT_NAME}`;
    return;
  }
  setStatus("loading bots…");
  const resp = await fetch(BOTS_URL);
  const { bots } = await resp.json();
  // Render quick picker
  document.body.innerHTML = `
    <div class="picker">
      <h2>Pick a bot to control</h2>
      <div class="picker-grid">
        ${bots.map(b => `<a class="picker-card" href="?bot=${encodeURIComponent(b.name)}">${b.name}</a>`).join("")}
      </div>
    </div>`;
  throw new Error("waiting for bot pick");
}

// ─── ws + claude pipeline ───────────────────────────────────────────────────
let client = null;
let conversationHistory = [];

function call(tool, args) {
  return client.call(BOT_NAME, tool, args);
}

function broadcast(type, text) {
  if (!client?.ws || client.ws.readyState !== client.ws.OPEN) return;
  client.ws.send(JSON.stringify({ type, bot: BOT_NAME, text }));
}

async function handleUserMessage(text) {
  logEntry(`<span class="speaker">you ▸</span> ${escapeHtml(text)}`, "user");
  setGoal(text);
  broadcast("user_input", text); // main screen shows it
  chatForm.querySelector("button").disabled = true;

  try {
    conversationHistory = await runClaudeTurn(text, call, {
      botName: BOT_NAME,
      messages: conversationHistory,
      onStep: (e) => {
        if (e.kind === "thinking") {
          // status shows turn; we keep the goal text
        } else if (e.kind === "assistant_text") {
          logEntry(`<span class="label-inline">CLAUDE</span>${escapeHtml(e.text)}`, "claude-think");
          broadcast("thought", e.text); // main screen shows Claude's thinking
        }
      },
    });
  } catch (e) {
    logEntry(`<span class="err">error: ${escapeHtml(e.message || String(e))}</span>`);
    console.error(e);
  } finally {
    chatForm.querySelector("button").disabled = false;
  }
}

// ─── boot ────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await ensureBot();
  } catch { return; /* picker shown */ }

  // Tool calls from OTHER phones controlling THIS bot also surface here so
  // judges see if their bot is busy with someone else's command.
  client = makeClient({
    url: WS_URL,
    onConnect: () => setStatus("connected", true),
    onDisconnect: () => setStatus("disconnected — retrying"),
    onEvent: (msg) => {
      if (msg.bot && msg.bot !== BOT_NAME) return; // not our bot
      if (msg.event === "tool_start") {
        logEntry(`<span class="tool">→ ${msg.tool}</span>`);
      } else if (msg.event === "tool_end") {
        if (!msg.ok) logEntry(`<span class="err">  ✗ ${msg.tool}: ${escapeHtml(msg.error || "")}</span>`);
      }
    },
  });

  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = "";
    handleUserMessage(text);
  });
})();
