// Server-side Claude tool-use loop for "TEAM mode" — when no judge phones
// are connected yet (the opening of the demo), the laptop runs Claude for
// all 4 bots simultaneously. They see each other via the team tool and
// coordinate without human routing.
//
// Triggered by POST /team-prompt {prompt} on the CommandServer's HTTP port.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL =
  process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
const MAX_TURNS = 12;

// Tool schema — kept in sync with host/src/claude.js but redefined here so
// the server doesn't need to import ESM browser code.
const BOT_TOOLS = [
  {
    name: "findBlock",
    description:
      "Find the nearest block of a given type. Returns {found, position?:{x,y,z}, name}.",
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
    description: "Walk to the given position via pathfinding.",
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
    description: "Mine the block at given coords. Bot must be in reach.",
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
    description: "Equip an item from inventory.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "place",
    description: "Place a block from inventory next to the bot.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "craft",
    description: "Craft an item using a nearby crafting_table.",
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
    description: "List items currently in the bot's inventory.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "chat",
    description: "Speak in-game chat — useful to coordinate with teammates.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "state",
    description: "Get the bot's current position, look direction, etc.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "team",
    description:
      "List the OTHER 3 agents in this world: their position, inventory, and last action. CALL THIS FIRST so you don't duplicate someone else's work.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "deposit",
    description:
      "Deposit items into the shared team chest (walks there automatically). args: {name?, count?} — omit name to deposit everything except tools.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "integer" },
      },
    },
  },
];

function systemPromptFor(botName) {
  return `You are ${botName}, an AI agent in Minecraft running inside a BrowserPod sandbox. You are ONE of FOUR teammates: Alice, Bob, Carl, Dana. You share a world and a shared chest.

# COORDINATION (read first)
- Call 'team' BEFORE doing anything to see where the other 3 agents are. If someone is heading to the same vein, pick a different one.
- 'chat' to announce your plan ("I'll take the south vein"). Other agents read your chat.
- When you finish gathering, call 'deposit' to drop items in the team chest. Team wins together.

# WORLD
- Natural terrain (hills, trees, stone). A base plaza near (0,0) holds a crafting_table and a shared CHEST. Several 2×2 diamond veins are exposed at the surface in different directions, ~15-25 blocks out.
- You start with EMPTY inventory. Use creative-mode mining (no pickaxe required for this demo).

# RULES
- Plan 1-2 sentences in plain text BEFORE tools.
- Be concise. Don't loop forever. If a vein has no diamonds left, find another.
- Stop after deposit — don't keep mining indefinitely.`;
}

/**
 * Run a single bot's Claude tool-use loop with the given user prompt.
 * Tool calls are dispatched through cmdServer.handleParsedMessage.
 */
async function runBotTurn({ bot, prompt, cmdServer, log, apiKey }) {
  const messages = [{ role: "user", content: prompt }];
  cmdServer.broadcast({ event: "user_input", bot: bot.name, text: prompt });

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let resp;
    try {
      resp = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          max_tokens: 1024,
          system: systemPromptFor(bot.name),
          tools: BOT_TOOLS,
          messages,
        }),
      });
    } catch (e) {
      log("team", `${bot.name} fetch error: ${e.message}`);
      return;
    }
    if (!resp.ok) {
      const txt = await resp.text();
      log("team-err", `${bot.name} Claude HTTP ${resp.status}: ${txt.slice(0, 200)}`);
      return;
    }
    const data = await resp.json();
    messages.push({ role: "assistant", content: data.content });

    // Surface text-block reasoning as 'thought' broadcasts so the TV/phones
    // show what each bot is thinking.
    for (const block of data.content || []) {
      if (block.type === "text" && block.text && block.text.trim()) {
        cmdServer.broadcast({
          event: "thought",
          bot: bot.name,
          text: block.text,
        });
      }
    }

    if (data.stop_reason !== "tool_use") {
      log("team", `${bot.name} done (${data.stop_reason}) after ${turn + 1} turns`);
      return;
    }

    // Execute each tool_use block via cmdServer
    const toolResults = [];
    for (const block of data.content || []) {
      if (block.type !== "tool_use") continue;
      const toolPromise = new Promise((resolve) => {
        cmdServer
          .handleParsedMessage(
            {
              id: `team-${bot.name}-${block.id}`,
              bot: bot.name,
              tool: block.name,
              args: block.input,
            },
            (reply) => resolve(reply),
          )
          .catch((e) => resolve({ ok: false, error: e?.message || String(e) }));
      });
      const reply = await toolPromise;
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(reply.ok ? reply.result : { error: reply.error }),
        is_error: !reply.ok,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }
  log("team", `${bot.name} hit max turns (${MAX_TURNS})`);
}

/**
 * Kick off all 4 bots running the same prompt in parallel.
 */
function runTeam({ prompt, bots, cmdServer, log }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log("team-err", "ANTHROPIC_API_KEY missing in env");
    return Promise.reject(new Error("ANTHROPIC_API_KEY missing"));
  }
  log("team", `running team prompt across ${bots.length} bots: "${prompt.slice(0, 80)}…"`);
  cmdServer.broadcast({ event: "team_start", prompt });
  return Promise.allSettled(
    bots.map((b) => runBotTurn({ bot: b, prompt, cmdServer, log, apiKey })),
  ).then((results) => {
    cmdServer.broadcast({ event: "team_done" });
    log("team", `team prompt finished (${results.length} bots)`);
  });
}

module.exports = { runTeam };
