// End-to-end test: send a user message, let Claude decide tool calls,
// execute them against the running bot, observe the multi-turn loop.
//
// Requires:
//   • MC server running on :3008
//   • Proxy running on :3009 (with ANTHROPIC_API_KEY)
//
// Usage: node test-claude.js "your prompt here"
//        node test-claude.js              # defaults to "chestplate" scenario

const WebSocket = require("ws");

const PROXY_URL = "http://localhost:3009";
const CMD_WS = "ws://localhost:3008";

const USER_PROMPT = process.argv[2] ||
  "Please mine a diamond ore block and tell me what you did.";

// ───────────────────────── tool definitions for Claude ─────────────────────
const BOT_TOOLS = [
  {
    name: "findBlock",
    description: "Find the nearest block of a given type. Returns {found, position, name} or {found:false}.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        maxDistance: { type: "number" },
      },
      required: ["name"],
    },
  },
  {
    name: "goTo",
    description: "Walk to a given position using pathfinding. Returns {arrivedAt}.",
    input_schema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        z: { type: "number" },
        range: { type: "number" },
        why: { type: "string" },
      },
      required: ["x", "y", "z"],
    },
  },
  {
    name: "mine",
    description: "Mine the block at given coords. Returns {mined, drop, at} or throws 'tool_broken'.",
    input_schema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        z: { type: "number" },
        why: { type: "string" },
      },
      required: ["x", "y", "z"],
    },
  },
  {
    name: "equip",
    description: "Equip an item to mainhand.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "craft",
    description: "Craft an item at the nearest crafting table.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "integer" },
      },
      required: ["name"],
    },
  },
  {
    name: "inventory",
    description: "List items currently in inventory.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "chat",
    description: "Speak in game chat (narration).",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "state",
    description: "Get current position, health, held item.",
    input_schema: { type: "object", properties: {} },
  },
];

const SYSTEM = `You are Concordia, an AI agent embodied in a Minecraft bot running inside a BrowserPod browser tab.

Rules:
- Be concise. Narrate what you're doing (1 short sentence) using the 'chat' tool before major actions.
- Break goals into sub-goals, then execute.
- Use block coordinates directly from findBlock results.
- If 'mine' throws 'tool_broken', equip a fresh pickaxe (check inventory) and retry.
- The world is flat superflat with pre-placed diamond_ore and a crafting_table near spawn.`;

// ──────────────────────── ws client boilerplate ────────────────────────────
const ws = new WebSocket(CMD_WS);
let nextId = 1;
const pending = new Map();
function callBot(tool, args = {}) {
  const id = String(nextId++);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, tool, args }));
  });
}
ws.on("message", (data) => {
  const msg = JSON.parse(data);
  if (msg.event) return; // ignore broadcasts
  if (msg.id === undefined) return;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.result);
  else p.reject(new Error(msg.error || "(empty)"));
});

// ───────────────────────── Claude loop ─────────────────────────────────────
async function claudeCall(messages) {
  const resp = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system: SYSTEM, tools: BOT_TOOLS, messages, max_tokens: 1024 }),
  });
  if (!resp.ok) throw new Error(`proxy ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  if (data.error) throw new Error(`claude: ${data.error}`);
  return data;
}

const fmt = {
  section: (s) => console.log(`\n\x1b[36m━━━ ${s} ━━━\x1b[0m`),
  think: (s) => console.log(`\x1b[90m  💭 ${s}\x1b[0m`),
  text: (s) => console.log(`\x1b[37m  📝 claude: ${s}\x1b[0m`),
  tool: (t, a) => console.log(`\x1b[33m  🔧 ${t}(${JSON.stringify(a).slice(0, 120)})\x1b[0m`),
  result: (r) => console.log(`\x1b[32m  ✓  ${JSON.stringify(r).slice(0, 200)}\x1b[0m`),
  error: (e) => console.log(`\x1b[31m  ✗  ${e}\x1b[0m`),
};

async function runConversation() {
  fmt.section(`USER: "${USER_PROMPT}"`);
  const messages = [{ role: "user", content: USER_PROMPT }];

  for (let turn = 0; turn < 20; turn++) {
    fmt.think(`turn ${turn + 1}: calling claude…`);
    const resp = await claudeCall(messages);
    messages.push({ role: "assistant", content: resp.content });

    for (const block of resp.content) {
      if (block.type === "text" && block.text.trim()) fmt.text(block.text);
    }

    if (resp.stop_reason !== "tool_use") {
      fmt.section(`DONE (stop_reason=${resp.stop_reason}, ${turn + 1} turns)`);
      return;
    }

    const results = [];
    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;
      fmt.tool(block.name, block.input);
      let out, isErr = false;
      try {
        out = await callBot(block.name, block.input);
        fmt.result(out);
      } catch (e) {
        out = { error: e.message };
        isErr = true;
        fmt.error(e.message);
      }
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(out),
        is_error: isErr,
      });
    }
    messages.push({ role: "user", content: results });
  }
  fmt.error("max turns reached");
}

ws.on("open", async () => {
  fmt.think("connected to bot");
  try {
    await runConversation();
  } catch (e) {
    fmt.error("conversation failed: " + (e.stack || e.message));
    process.exitCode = 1;
  }
  setTimeout(() => process.exit(), 300);
});

ws.on("error", (e) => { console.error("ws error:", e.message); process.exit(1); });
