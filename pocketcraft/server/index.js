// Pocketcraft — Phase 1.1: orchestrator.
//
// Boots a single Node process that hosts:
//   • flying-squid Minecraft server bound to 127.0.0.1:25565
//   • mineflayer bot that joins it as "Pocketcraft"
//
// Phase 1.4 will replace the loopback TCP with an in-process Duplex pair.
// For now we use real localhost TCP because it's easier to debug.

const log = (tag, ...m) => console.log(`[${tag}]`, ...m);

async function main() {
  // flying-squid writes log files relative to cwd, so make sure the dir exists
  require("fs").mkdirSync("logs", { recursive: true });

  log("boot", "starting flying-squid…");
  const { createMCServer } = require("flying-squid");

  const MC_VERSION = "1.16.5"; // modern enough for normal item names
  const PORT = 25565;
  const HOST = "127.0.0.1";

  const server = createMCServer({
    motd: "Pocketcraft",
    "max-players": 4,
    port: PORT,
    host: HOST,
    "online-mode": false,
    logging: true,
    gameMode: 1, // creative — bot can fly + place anything (nice for scripted demo)
    difficulty: 1,
    worldFolder: null, // ephemeral, in-memory
    generation: { name: "superflat", options: { worldHeight: 80 } },
    kickTimeout: 10_000,
    plugins: {},
    "everybody-op": true,
    "max-entities": 100,
    "view-distance": 10, // CRITICAL — without this no chunks ever get sent
    modpe: false,
    "max-players": 4,
    version: MC_VERSION,
    "player-list-text": { header: "", footer: "" },
  });

  server.on("listening", () => log("server", `listening on ${HOST}:${PORT}`));
  server.on("error", (e) => log("server-err", e));

  // Wait for server to be ready before connecting bot
  await new Promise((resolve) => server.on("listening", resolve));

  const { seedWorld, seedBotInventory } = require("./worldSetup");

  log("boot", "starting mineflayer bot…");
  const mineflayer = require("mineflayer");
  const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
  const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: "Pocketcraft",
    version: MC_VERSION,
    auth: "offline",
  });
  bot.loadPlugin(pathfinder);

  bot.on("error", (e) => log("bot-err", e.message));
  bot.on("kicked", (reason) => log("bot-kick", reason));
  bot.on("end", (reason) => log("bot-end", reason));

  let chunksLoaded = 0;
  bot.on("chunkColumnLoad", () => { chunksLoaded++; });

  // Log every packet name received — to see if chunk packets even arrive
  const seenPackets = {};
  bot._client.on("packet", (data, meta) => {
    seenPackets[meta.name] = (seenPackets[meta.name] || 0) + 1;
  });
  setInterval(() => {
    log("chunks", `loaded so far: ${chunksLoaded}`);
    log("packets", JSON.stringify(seenPackets));
  }, 3000);

  bot.once("spawn", async () => {
    const p = bot.entity.position;
    log("bot", `spawned at ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`);
    log("bot", `game=${bot.game.gameMode}`);

    // Seed inventory
    try {
      await seedBotInventory(bot, MC_VERSION);
      log("bot", "inventory seeded");
      const items = bot.inventory.items().map(i => `${i.name}x${i.count}`);
      log("bot", `inv: ${items.join(", ")}`);
    } catch (e) {
      log("inv-err", e.stack || e.message);
    }

    // Wait for the bot to actually have chunks loaded before seeding,
    // otherwise our setBlock fires while chunks are mid-stream and
    // the block_change packets get lost.
    await new Promise((r) => setTimeout(r, 1500));

    // Seed world relative to bot's actual position
    let seedPositions;
    try {
      seedPositions = await seedWorld(server, MC_VERSION, bot.entity.position);
      log("world", `craftingTable=${seedPositions.craftingTable}`);
      log("world", `diamondVein=${seedPositions.diamondVein}`);
    } catch (e) {
      log("world-err", e.stack || e.message);
    }

    // Prismarine-viewer in first-person — hides the static bot body
    // ("looking through the bot's eyes"). Better than third-person because
    // we don't have skeletal animations to make the body look natural.
    try {
      const { mineflayer: mfViewer } = require("prismarine-viewer");
      mfViewer(bot, { port: 3007, firstPerson: true });
      log("viewer", "prismarine-viewer (first-person) on :3007");
    } catch (e) {
      log("viewer-err", e.stack || e.message);
    }

    // Command WS server
    try {
      const { CommandServer } = require("./commands");
      const { makeTools } = require("./tools");
      const cmd = new CommandServer({ port: 3008, log });
      const tools = makeTools(bot, MC_VERSION);
      for (const [name, fn] of Object.entries(tools)) {
        cmd.registerTool(name, fn);
      }
      cmd.start();

      // Stream key bot events to clients
      bot.on("playerChat", (username, message) =>
        cmd.broadcast({ event: "bot_event", type: "chat", username, message })
      );
      bot.on("health", () =>
        cmd.broadcast({ event: "bot_event", type: "health", health: bot.health, food: bot.food })
      );
    } catch (e) {
      log("cmd-err", e.stack || e.message);
    }

    // (the 360° verification spin is removed — pathfinder needs precise yaw control)

    setTimeout(() => bot.chat("hello from pocketcraft"), 1000);

    // Verify bot can see seeded blocks
    setTimeout(() => {
      const diamond = bot.findBlock({
        matching: (b) => b && b.name === "diamond_ore",
        maxDistance: 64,
      });
      const table = bot.findBlock({
        matching: (b) => b && b.name === "crafting_table",
        maxDistance: 64,
      });
      log("scan", `diamond_ore: ${diamond ? diamond.position : "NOT FOUND"}`);
      log("scan", `crafting_table: ${table ? table.position : "NOT FOUND"}`);

      // Also try directly inspecting the block at the seeded coord
      if (seedPositions) {
        const tbl = bot.blockAt(seedPositions.craftingTable);
        const dia = bot.blockAt(seedPositions.diamondVein);
        log("scan", `bot.blockAt(table): ${tbl?.name}`);
        log("scan", `bot.blockAt(diamond): ${dia?.name}`);
      }
    }, 4000);

    setInterval(() => {
      if (!bot.entity) return;
      const p = bot.entity.position;
      log("tick", `pos=(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`);
    }, 5000);
  });
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
