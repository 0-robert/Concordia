// Pocketcraft main screen.
//
// Shows a tiled grid of first-person bot views, plus a QR code that
// audience members scan to open /phone.html?bot=<name> on their device.
//
// Only observes events; doesn't send tool calls. The phone clients
// drive the bots.

import { makeClient } from "./wsClient.js";
import { bootPod } from "./bootPod.js";

const params = new URLSearchParams(location.search);
// Where the MC server lives. ?host=192.168.1.5:3008 lets you point at a
// different machine (useful when phones connect over LAN).
const SERVER_HOST = params.get("host") || `${location.hostname}:3008`;
const HTTP_BASE = `http://${SERVER_HOST}`;
const WS_URL = `ws://${SERVER_HOST}`;

// ?nopod=1 → skip pod boot, QR points at laptop's phone.html (legacy).
// ?phone=https://x/phone.html → explicit override.
const NO_POD = params.get("nopod") === "1";
const PHONE_URL_OVERRIDE = params.get("phone");
const LEGACY_PHONE_URL = `${location.origin}/phone.html?legacy=1`;

const $ = (id) => document.getElementById(id);
const grid = $("main-grid");
const statusEl = $("status");
const joinUrlEl = $("join-url");
const qrCanvas = $("qr");

// ─── render ──────────────────────────────────────────────────────────────────
function setStatus(s) { statusEl.textContent = s; }

async function loadBotList() {
  setStatus("loading bot list…");
  const resp = await fetch(`${HTTP_BASE}/bots`);
  if (!resp.ok) throw new Error(`/bots HTTP ${resp.status}`);
  const data = await resp.json();
  return data;
}

// One color per bot for visual distinction in tiles + logs
const BOT_COLORS = ["#4ade80", "#60a5fa", "#fbbf24", "#f472b6"]; // Alice green, Bob blue, Carl amber, Dana pink

function renderTiles(bots) {
  // Auto-grid: 1 bot full, 2 side-by-side, 3-4 in 2x2
  const cols = bots.length <= 1 ? 1 : 2;
  grid.style.setProperty("--cols", cols);
  grid.innerHTML = "";
  bots.forEach((b, i) => {
    const tile = document.createElement("div");
    tile.className = "bot-tile";
    tile.dataset.bot = b.name;
    tile.style.setProperty("--bot-color", BOT_COLORS[i % BOT_COLORS.length]);

    const viewerHost = SERVER_HOST.split(":")[0];
    const viewerUrl = `http://${viewerHost}:${b.viewerPort}`;

    tile.innerHTML = `
      <div class="bot-tile-header">
        <span class="bot-dot"></span>
        <span class="bot-name">${b.name}</span>
        <span class="bot-now" id="bot-now-${b.name}">idle</span>
      </div>
      <div class="bot-tile-viewer">
        <iframe
          title="${b.name} POV"
          src="${viewerUrl}"
          credentialless
          allow="cross-origin-isolated"
        ></iframe>
        <div class="bot-tile-thought" id="bot-thought-${b.name}"></div>
      </div>
      <div class="bot-tile-log" id="bot-log-${b.name}"></div>
    `;
    grid.appendChild(tile);
  });
}

function appendBotLog(botName, html, cls = "") {
  const el = document.getElementById(`bot-log-${botName}`);
  if (!el) return;
  const div = document.createElement("div");
  div.className = "bot-log-entry " + cls;
  div.innerHTML = html;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 6) el.removeChild(el.firstChild);
}
function setBotNow(botName, text) {
  const el = document.getElementById(`bot-now-${botName}`);
  if (el) el.textContent = text;
}
function setBotThought(botName, text, kind = "thought") {
  const el = document.getElementById(`bot-thought-${botName}`);
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind; // user | thought
  el.classList.remove("fade");
  // fade out after 30s of no updates
  clearTimeout(el._fadeTimer);
  el._fadeTimer = setTimeout(() => el.classList.add("fade"), 30_000);
}

function formatArgs(args) {
  if (!args || Object.keys(args).length === 0) return "";
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === "string" ? `"${v}"` : v}`)
    .join(", ");
}
function truncate(s, n = 60) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// ─── QR code (uses qrcodejs from CDN, fallback to plain link) ────────────────
async function drawQR(text) {
  joinUrlEl.textContent = text;
  try {
    const { default: QRCode } = await import("https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm");
    await QRCode.toCanvas(qrCanvas, text, { width: 180, margin: 0, color: { dark: "#e8eaf2", light: "#0d0e12" } });
  } catch (e) {
    qrCanvas.style.display = "none";
  }
}

// ─── pod boot + relay handshake ──────────────────────────────────────────────
async function bootPodAndPushRelay() {
  // Pod terminal. Hidden by default for demo. Add ?showpod=1 to reveal it
  // (useful when debugging server.js crashes inside the pod).
  const showTerm = new URLSearchParams(location.search).get("showpod") === "1";
  let podTermEl = document.getElementById("pod-terminal");
  if (!podTermEl) {
    podTermEl = document.createElement("div");
    podTermEl.id = "pod-terminal";
    Object.assign(podTermEl.style, showTerm ? {
      position: "fixed", bottom: "0", left: "0", right: "0",
      height: "260px", background: "#000", color: "#0f0", zIndex: "9999",
      fontFamily: "monospace", overflow: "hidden", borderTop: "2px solid #0f0",
    } : {
      position: "fixed", bottom: "0", right: "0",
      width: "1px", height: "1px", opacity: "0", pointerEvents: "none",
    });
    document.body.appendChild(podTermEl);
  }
  setStatus("booting pod…");

  const anthropicKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    throw new Error("VITE_ANTHROPIC_API_KEY missing in host/.env");
  }

  const { portalUrl, podWsUrl } = await bootPod({
    terminalEl: podTermEl,
    anthropicKey,
    log: (s) => console.log("[pod]", s),
  });

  // Tell laptop server to dial out to the pod's relay.
  const laptopRelayUrl = `${podWsUrl}/ws/laptop`;
  const r = await fetch(`${HTTP_BASE}/relay-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: laptopRelayUrl }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`POST /relay-url failed: ${r.status} ${t}`);
  }
  console.log("[main-screen] pushed relay url to laptop:", laptopRelayUrl);
  return portalUrl;
}

// ─── boot ────────────────────────────────────────────────────────────────────
(async () => {
  let payload;
  try {
    payload = await loadBotList();
  } catch (e) {
    setStatus("could not reach server: " + e.message);
    return;
  }
  const bots = payload.bots;
  renderTiles(bots);

  // Wire the overview iframe (left half)
  if (payload.overviewPort) {
    const viewerHost = SERVER_HOST.split(":")[0];
    document.getElementById("overview").src = `http://${viewerHost}:${payload.overviewPort}`;
  }
  setStatus(`${bots.length} bots ready`);

  // ── Determine the phone URL ──
  // Priority: explicit ?phone=... → pod portal (if booted) → legacy laptop URL.
  let phoneUrl = PHONE_URL_OVERRIDE || LEGACY_PHONE_URL;
  drawQR(phoneUrl); // initial QR — gets replaced when pod portal fires

  if (!NO_POD && !PHONE_URL_OVERRIDE) {
    bootPodAndPushRelay()
      .then((portalUrl) => {
        phoneUrl = portalUrl;
        drawQR(portalUrl);
        setStatus(`${bots.length} bots ready · pod live`);
      })
      .catch((e) => {
        console.error("[main-screen] pod boot failed, staying on legacy QR:", e);
        setStatus(`${bots.length} bots ready · pod failed (using laptop QR)`);
      });
  }

  makeClient({
    url: WS_URL,
    onConnect: () => setStatus("connected"),
    onDisconnect: () => setStatus("disconnected — retrying"),
    onEvent: (msg) => {
      if (msg.event === "user_input") {
        setBotThought(msg.bot, `🗣 ${msg.text}`, "user");
        appendBotLog(msg.bot, `<span class="user">🗣 ${escapeHtml(msg.text)}</span>`);
      } else if (msg.event === "thought") {
        setBotThought(msg.bot, msg.text, "thought");
      } else if (msg.event === "tool_start") {
        setBotNow(msg.bot, `${msg.tool}`);
        appendBotLog(msg.bot, `<span class="tool">→ ${msg.tool}</span> <span class="args">${escapeHtml(formatArgs(msg.args))}</span>`);
      } else if (msg.event === "tool_end") {
        if (msg.ok) {
          appendBotLog(msg.bot, `<span class="ok">  ✓</span> <span class="args">${escapeHtml(truncate(JSON.stringify(msg.result)))}</span>`);
        } else {
          appendBotLog(msg.bot, `<span class="err">  ✗</span> <span class="args">${escapeHtml(msg.error || "")}</span>`);
        }
        setBotNow(msg.bot, "idle");
      }
    },
  });
})();
