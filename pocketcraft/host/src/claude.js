// Claude tool-use loop.
//
// Given a user message and a `callTool(tool, args)` function that executes
// against the running bot, runs a multi-turn conversation with Claude:
//
//   1. Send messages + tool definitions
//   2. If Claude responds with tool_use blocks, execute them via callTool
//   3. Append tool_result blocks to messages, loop
//   4. If Claude responds with only text (no tool_use), emit it and stop
//
// `onStep` is called with {kind, ...} events so the UI can render progress.

// Claude proxy.
//   Default (pod-host serves this page): POST /api/claude, same origin.
//   Legacy / direct-LAN: explicit ?claude=<url> or ?legacy=1 → laptop :3009.
const _params = new URLSearchParams(location.search);
const _claudeOverride = _params.get("claude");
const _legacy = _params.get("legacy") === "1" || _params.has("host");
const PROXY_URL =
  _claudeOverride ||
  (_legacy ? `http://${location.hostname}:3009` : "/api/claude");

export const BOT_TOOLS = [
  {
    name: "findBlock",
    description:
      "Find the nearest block of a given type. Returns {found: true, position: {x,y,z}, name} or {found: false}.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Block name like 'diamond_ore' or 'crafting_table'" },
        maxDistance: { type: "number", description: "Search radius in blocks (default 64)" },
      },
      required: ["name"],
    },
  },
  {
    name: "goTo",
    description:
      "Walk to the given position using pathfinding. Returns {arrivedAt:{x,y,z}}.",
    input_schema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        z: { type: "number" },
        range: { type: "number", description: "How close to get (default 1 block)" },
        why: { type: "string", description: "Human-readable reason (for the viewer's narration)" },
      },
      required: ["x", "y", "z"],
    },
  },
  {
    name: "mine",
    description:
      "Mine (dig) the block at given coords. Bot must be within reach. Returns {mined, at}. IMPORTANT: throws 'tool_broken' if the pickaxe breaks mid-mining — when this happens you should equip a fresh pickaxe.",
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
    description: "Equip an item from inventory to the mainhand. Throws if not in inventory.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "place",
    description:
      "Place a block from inventory in the world next to the bot. Useful for putting down a crafting_table after crafting one. The bot picks a free adjacent spot.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "block name like 'crafting_table'" } },
      required: ["name"],
    },
  },
  {
    name: "craft",
    description:
      "Craft an item using the nearest crafting table. Bot must be within 16 blocks of a crafting_table.",
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
    description: "Speak in-game chat — helpful for narrating the bot's reasoning to the human.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "state",
    description: "Get the bot's current position, look direction, health, and held item.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "team",
    description:
      "See what the other 3 AI agents in this world are doing right now. Returns {teammates: [{name, pos, distanceFromMe, inventory, lastAction}...], sharedChest: {x,y,z}}. CALL THIS FIRST before starting a task so you don't duplicate another bot's work. Use `chat` to coordinate.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "deposit",
    description:
      "Walk to the shared team chest and deposit items into it. Used to contribute to the team's collective stockpile. args: {name?, count?} — omit `name` to deposit everything except tools. Returns {deposited, chest: {...current contents}}.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "item name, e.g. 'diamond' or 'oak_log'. Omit to deposit everything." },
        count: { type: "integer", description: "number to deposit (default: all of that item)" },
      },
    },
  },
];

function systemPromptFor(botName) {
  return `You are ${botName}, an AI agent embodied in a Minecraft bot running inside a BrowserPod browser tab. You are ONE of FOUR agents (Alice, Bob, Carl, Dana) working together as a team. You share a world and a shared chest.

# TEAM COORDINATION — read this first
- Before starting any task, CALL the 'team' tool to see where the other 3 agents are and what they're doing. If someone is already heading to the forest, YOU should head to the hill instead. Don't cluster.
- When you finish gathering something useful (logs, diamonds, cobblestone), CALL 'deposit' to put it in the shared chest. The team wins collectively, not individually.
- Use the 'chat' tool frequently to announce your intent, e.g. "I'll take the west forest" or "Heading to hill for diamonds — Bob, can you bring wood?". Other agents DO read your chat.
- When a human gives you a goal, think about whether it's better done solo or split. If it needs teamwork, coordinate via chat.

# How you think
- Plan in plain language BEFORE calling tools — explain what you're going to do in 1-2 short sentences. The human watching wants to follow your reasoning.
- Then call tools to execute the plan.
- Narrate progress in-game with the 'chat' tool (one short line per major step).
- If a tool errors, read the error message and recover. Don't give up on the first failure.

# The world
- Natural terrain: grass hills, oak forests, stone, caves. Not flat.
- A BASE PLAZA near spawn holds a crafting_table and a shared CHEST — this is your team's home. The team tool's response includes the chest coordinates.
- Several 2x2 DIAMOND VEINS are exposed at the surface in various directions from base (roughly 15-25 blocks out). Use findBlock("diamond_ore") to locate the nearest.
- Oak trees are naturally scattered — findBlock("oak_log") finds one.
- Bots start with EMPTY inventory. Anything you need, you must mine and craft.
- Block coordinates are {x, y, z}. Use values from findBlock results directly.

# Crafting recipe knowledge (your craft tool only accepts these)
2×2 (no table needed):
- 1× oak_log → 4× oak_planks
- 2× oak_planks → 4× stick
- 4× oak_planks → 1× crafting_table

3×3 (need crafting_table within 16 blocks):
- 3× oak_planks + 2× stick → 1× wooden_pickaxe (or wooden_axe, similar pattern)
- 2× oak_planks + 1× stick → 1× wooden_sword
- 3× cobblestone + 2× stick → 1× stone_pickaxe
- 3× iron_ingot + 2× stick → 1× iron_pickaxe
- 3× diamond + 2× stick → 1× diamond_pickaxe
- 2× diamond + 1× stick → 1× diamond_sword
- 8× diamond → 1× diamond_chestplate
- 3× stick + 2× string → 1× fishing_rod

# Multi-step example
User: "make me a wooden pickaxe"
Plan: I need 3 oak_planks + 2 sticks AND a crafting_table to craft the pickaxe at. From 1 oak_log I get 4 planks; from 2 planks I get 4 sticks; 4 planks → 1 crafting_table; the pickaxe itself needs 3 planks + 2 sticks. Total wood need: ~3 logs (1 for table, 2 for planks/sticks for pickaxe). Then place the table down so I can use it.
Actions: findBlock("oak_log") → goTo → mine(log) ×3 → craft("oak_planks") (×3, gives 12 planks) → craft("stick") (gives 4) → craft("crafting_table") (gives 1) → place("crafting_table") → craft("wooden_pickaxe").

Important: if you need a crafting_table for a 3×3 recipe and there isn't one nearby, CRAFT one (4 planks → 1 table) and PLACE it before calling craft again.

# Rules
- ${botName} is your in-game name. Don't impersonate other bots.
- Keep narration concise. Each 'chat' should be one short line.
- Don't call tools you don't need. Pure text replies are fine for chat-only requests.`;
}

/**
 * Run a full user-turn. Handles Claude's tool-use loop internally.
 * @param {string} userText
 * @param {(tool: string, args: object) => Promise<any>} callTool
 * @param {{messages?: Array, onStep?: (e: object) => void, botName?: string}} opts
 * @returns updated messages array (including user, assistant, tool_result blocks)
 */
export async function runClaudeTurn(userText, callTool, opts = {}) {
  const messages = opts.messages ? [...opts.messages] : [];
  const onStep = opts.onStep || (() => {});
  const botName = opts.botName || "Pocketcraft";
  const system = systemPromptFor(botName);

  messages.push({ role: "user", content: userText });
  onStep({ kind: "user", text: userText });

  for (let turn = 0; turn < 20; turn++) {
    onStep({ kind: "thinking", turn });
    const resp = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system, tools: BOT_TOOLS, messages, max_tokens: 1024 }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`proxy error: ${resp.status} ${err}`);
    }
    const data = await resp.json();
    if (data.error) throw new Error(`claude error: ${data.error}`);

    // Append assistant message (with its content blocks)
    messages.push({ role: "assistant", content: data.content });

    // Emit text blocks to the UI
    for (const block of data.content) {
      if (block.type === "text" && block.text.trim()) {
        onStep({ kind: "assistant_text", text: block.text });
      }
    }

    if (data.stop_reason !== "tool_use") {
      // Final answer turn. Done.
      return messages;
    }

    // Execute each tool_use block
    const toolResults = [];
    for (const block of data.content) {
      if (block.type !== "tool_use") continue;
      onStep({ kind: "tool_call", tool: block.name, args: block.input, id: block.id });
      let result, isError = false;
      try {
        result = await callTool(block.name, block.input);
      } catch (e) {
        result = { error: e.message || String(e) };
        isError = true;
      }
      onStep({ kind: "tool_result", tool: block.name, result, isError, id: block.id });
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
        is_error: isError,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  throw new Error("too many turns (20) — aborting");
}
