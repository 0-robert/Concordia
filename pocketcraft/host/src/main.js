// Pocketcraft host page.
//
// Connects to the in-pod (or local) command WS server, renders agent state
// live: goal, current action, inventory, scrolling log.
//
// For Phase 4 we use a hardcoded "router" between user input and tool calls
// (no Claude yet). Phase 5 swaps that for a real Claude tool-use loop.

const CMD_WS = "ws://localhost:3008";
const VIEWER_URL = "http://localhost:3007";

// ─── DOM refs ────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const goalEl = $("goal");
const nowEl = $("now-action");
const invEl = $("inventory");
const logEl = $("log");
const chatForm = $("chat-form");
const chatInput = $("chat-input");

$("viewer").src = VIEWER_URL;

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
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, tool, args }));
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

    // Tool response (id-keyed)
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error));
      }
      return;
    }

    // Event broadcast
    if (msg.event === "tool_start") {
      setNow(`${msg.tool}(${formatArgs(msg.args)})`);
      logEntry(`<span class="tool">→ ${msg.tool}</span> <span class="args">${formatArgs(msg.args)}</span>`);
    } else if (msg.event === "tool_end") {
      if (msg.ok) {
        logEntry(`<span class="ok">  ✓ ${msg.tool}</span> <span class="args">${truncate(JSON.stringify(msg.result))}</span>`);
      } else {
        logEntry(`<span class="err">  ✗ ${msg.tool}</span> <span class="args">${msg.error}</span>`);
      }
      // After mutating tools, refresh inventory cheaply
      if (["mine", "equip", "craft"].includes(msg.tool)) refreshInventory();
    } else if (msg.event === "bot_event" && msg.type === "chat") {
      // Don't echo our own bot's chats — they're already self-narrated.
      // But other-player chat would surface here.
    } else if (msg.event === "hello") {
      logEntry(`<span class="args">tools: ${msg.tools.join(", ")}</span>`);
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

// ─── chat → tool router (Phase 4 stub; replaced by Claude in Phase 5) ────────
async function handleUserMessage(text) {
  logEntry(`<span class="speaker">you ▸</span> ${text}`, "user");
  setGoal(text);

  // Crude keyword router until we wire Claude. Just enough for live demos.
  const t = text.toLowerCase();
  try {
    if (/(diamond|chestplate|chest plate)/.test(t)) {
      // Mini chestplate scenario (no actual chestplate yet — needs 8 diamonds + path)
      setNow("planning: collect diamonds → craft");
      const dia = await call("findBlock", { name: "diamond_ore" });
      if (!dia.found) return chatBack("no diamond ore in sight");
      await call("equip", { name: "iron_pickaxe" });
      await call("goTo", { ...dia.position, range: 2, why: "diamond ore" });
      await call("mine", { ...dia.position, why: "for chestplate" });
    } else if (/(go to|walk to).*diamond/.test(t)) {
      const dia = await call("findBlock", { name: "diamond_ore" });
      if (!dia.found) return chatBack("no diamond ore in sight");
      await call("goTo", { ...dia.position, range: 2, why: "diamond ore" });
    } else if (/inventory|carrying|holding/.test(t)) {
      const items = await call("inventory");
      const summary = items.map(i => `${i.name} ×${i.count}`).join(", ");
      await call("chat", { text: `i'm carrying: ${summary}` });
    } else {
      await call("chat", { text: "got it: " + text });
    }
    setNow("idle");
  } catch (e) {
    logEntry(`<span class="err">router error: ${e.message}</span>`);
    setNow("error: " + e.message);
  }
}
function chatBack(s) {
  logEntry(`<span class="args">  bot: ${s}</span>`);
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

connect();
