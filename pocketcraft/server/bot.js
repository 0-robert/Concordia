// makeBot(server, name, mcVersion) — spawn a mineflayer bot connected
// to flying-squid via an in-memory duplex pair (no TCP).
//
// Each bot is independent:
//   • Its own Pipe pair end-to-end with the server's socketServer
//   • Its own mineflayer client + pathfinder plugin
//   • Its own tool set (closures capture this bot's bot instance)
//   • Its own seeded inventory
//
// Returns { bot, name, tools } once the bot's `spawn` event has fired.

const mineflayer = require("mineflayer");
const { pathfinder } = require("mineflayer-pathfinder");
const { makeDuplexPair } = require("./duplexPair");
const { makeTools } = require("./tools");
const { seedBotInventory } = require("./worldSetup");

const log = (tag, ...m) => console.log(`[${tag}]`, ...m);

/**
 * Spawn a bot.
 * @param {object} server flying-squid server instance
 * @param {string} name in-game username
 * @param {string} mcVersion e.g. "1.16.5"
 * @returns {Promise<{bot, name, tools, position}>}
 */
async function makeBot(server, name, mcVersion, world = null) {
  log(`bot:${name}`, "creating duplex pair…");
  const { serverEnd, clientEnd } = makeDuplexPair();

  // Hand the server end to flying-squid's accept path
  server._server.socketServer.emit("connection", serverEnd);

  const bot = mineflayer.createBot({
    stream: clientEnd,
    host: "127.0.0.1",
    port: 25565,
    username: name,
    version: mcVersion,
    auth: "offline",
  });
  bot.loadPlugin(pathfinder);

  bot.on("error", (e) => log(`bot:${name}-err`, e.message));
  bot.on("kicked", (reason) => log(`bot:${name}-kick`, reason));
  bot.on("end", (reason) => log(`bot:${name}-end`, reason));

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`bot ${name} spawn timeout`)),
      15_000
    );
    bot.once("spawn", () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  const p = bot.entity.position;
  log(`bot:${name}`, `spawned at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`);

  // What does the bot have at spawn (before any seeding)?
  const preItems = bot.inventory.items().map((i) => `${i.name}×${i.count}@${i.slot}`);
  log(`bot:${name}`, `pre-seed inv: [${preItems.join(", ")}]`);

  // Seed inventory (gives each bot a starting kit)
  try {
    await seedBotInventory(bot, mcVersion);
    const items = bot.inventory.items().map((i) => `${i.name}×${i.count}`);
    log(`bot:${name}`, `post-seed inv: ${items.join(", ")}`);
  } catch (e) {
    log(`bot:${name}-inv-err`, e.stack || e.message);
  }

  // Build tools bound to this bot — server reference allows place to write
  // blocks directly via server.setBlock instead of fighting MC protocol.
  // `world` (if provided) exposes cross-bot state for the team + deposit tools.
  const tools = makeTools(bot, mcVersion, server, world);

  return { bot, name, tools, position: bot.entity.position.clone() };
}

module.exports = { makeBot };
