// Pocketcraft — orchestrator (single-process, multi-agent, no TCP loopback).
//
// Boots a single Node process that hosts:
//   • flying-squid Minecraft server
//   • N mineflayer bots, each connected via an in-memory Duplex pair
//   • prismarine-viewer (tracks the first bot's POV)
//   • Command WS server with per-bot tool routing
//
// Critical: NO TCP loopback. BrowserPod blocks 127.0.0.1.

const log = (tag, ...m) => console.log(`[${tag}]`, ...m);

// Bot roster — names + viewer port. Each bot gets its own first-person
// viewer instance so judges can see each bot's POV side-by-side.
const BOTS = [
  { name: "Alice", viewerPort: 3007 },
  { name: "Bob",   viewerPort: 3017 },
  { name: "Carl",  viewerPort: 3027 },
  { name: "Dana",  viewerPort: 3037 },
];

async function main() {
  require("fs").mkdirSync("logs", { recursive: true });

  log("boot", "starting flying-squid…");
  const { createMCServer } = require("flying-squid");

  const MC_VERSION = "1.16.5";
  const PORT = 25565;
  const HOST = "127.0.0.1";

  const server = createMCServer({
    motd: "Pocketcraft",
    "max-players": 4,
    port: PORT,
    host: HOST,
    "online-mode": false,
    logging: true,
    gameMode: 1,
    difficulty: 1,
    worldFolder: null,
    generation: { name: "superflat", options: { worldHeight: 80 } },
    kickTimeout: 10_000,
    plugins: {},
    "everybody-op": true,
    "max-entities": 100,
    "view-distance": 10,
    modpe: false,
    version: MC_VERSION,
    "player-list-text": { header: "", footer: "" },
  });

  server.on("listening", () => log("server", `listening on ${HOST}:${PORT}`));
  server.on("error", (e) => log("server-err", e));

  await new Promise((resolve) => server.on("listening", resolve));

  // ── Spawn bots in sequence (so each gets its own duplex + spawn event) ──
  const { makeBot } = require("./bot");
  const bots = [];
  for (const def of BOTS) {
    log("boot", `spawning bot '${def.name}'…`);
    try {
      const b = await makeBot(server, def.name, MC_VERSION);
      b.viewerPort = def.viewerPort;
      bots.push(b);
    } catch (e) {
      log("boot-err", `failed to spawn ${def.name}: ${e.message}`);
    }
  }
  log("boot", `${bots.length} bots ready: ${bots.map((b) => b.name).join(", ")}`);

  if (bots.length === 0) {
    log("fatal", "no bots spawned, exiting");
    return;
  }

  // ── Seed the world AFTER bots have joined (so chunks are loaded) ──
  // Seed relative to the FIRST bot's position so structures are visible.
  await new Promise((r) => setTimeout(r, 1500));
  const { seedWorld } = require("./worldSetup");
  let seedPositions;
  try {
    seedPositions = await seedWorld(server, MC_VERSION, bots[0].bot.entity.position);
    log("world", `craftingTable=${seedPositions.craftingTable}`);
    log("world", `diamondVein=${seedPositions.diamondVein}`);
  } catch (e) {
    log("world-err", e.stack || e.message);
  }

  // ── prismarine-viewer: one first-person per bot + one OVERVIEW (orbit) ──
  // Overview tracks the first bot but in third-person so judges can drag
  // the camera around and see all agents at once.
  const OVERVIEW_PORT = 3047;
  try {
    const { mineflayer: mfViewer } = require("prismarine-viewer");

    // Per-bot first-person tiles
    for (const b of bots) {
      mfViewer(b.bot, { port: b.viewerPort, firstPerson: true });
      // Suppress usernames in entity emits — chunky floating names look bad
      const view = b.bot.viewer;
      if (view && view.emitter) {
        const origEmit = view.emitter.emit.bind(view.emitter);
        view.emitter.emit = (event, payload, ...rest) => {
          if (event === "entity" && payload && typeof payload === "object") {
            payload = { ...payload, username: undefined };
          }
          return origEmit(event, payload, ...rest);
        };
      }
      log("viewer", `${b.name} POV on :${b.viewerPort}`);
    }

    // Overview viewer: third-person orbit around bots[0]. Judges can drag
    // to spin/zoom; covers the whole scene from up high.
    mfViewer(bots[0].bot, { port: OVERVIEW_PORT, firstPerson: false });
    log("viewer", `OVERVIEW (third-person, orbit) on :${OVERVIEW_PORT}`);
  } catch (e) {
    log("viewer-err", e.stack || e.message);
  }
  // Stash for the /bots endpoint to expose
  global.__overviewPort = OVERVIEW_PORT;

  // ── Command WS server with per-bot routing ──
  try {
    const { CommandServer } = require("./commands");
    const { startRelayBridge } = require("./relayBridge");

    // The TV screen POSTs the pod's relay URL once the pod portal fires.
    // We track the live bridge here so we can replace it on subsequent
    // boots (e.g., the user reloads main.html and the pod gets a new URL).
    let activeBridge = null;
    let cmd; // forward-reference — onRelayUrl runs after cmd is constructed.
    const onRelayUrl = (url) => {
      if (activeBridge) {
        log("relay", `replacing existing bridge → ${url}`);
        activeBridge.close();
      }
      activeBridge = startRelayBridge({ relayUrl: url, cmdServer: cmd, log });
    };

    cmd = new CommandServer({ port: 3008, log, onRelayUrl });
    for (const { name, tools, viewerPort } of bots) {
      cmd.registerBot(name, tools, viewerPort);
    }
    cmd.start();

    // Boot-time fallback: env var works the same as POST /relay-url, useful
    // for headless / scripted runs.
    if (process.env.POCKETCRAFT_RELAY_URL) {
      onRelayUrl(process.env.POCKETCRAFT_RELAY_URL);
    }

    // Forward in-game chat from any bot back to UI
    for (const { name, bot } of bots) {
      bot.on("playerChat", (username, message) =>
        cmd.broadcast({
          event: "bot_event",
          bot: name,
          type: "chat",
          username,
          message,
        })
      );
    }
  } catch (e) {
    log("cmd-err", e.stack || e.message);
  }

  // Greeting chats so we know each bot is alive
  setTimeout(() => {
    for (const { name, bot } of bots) {
      bot.chat(`hi, i'm ${name}`);
    }
  }, 2000);

  // Periodic heartbeat
  setInterval(() => {
    for (const { name, bot } of bots) {
      if (!bot.entity) continue;
      const p = bot.entity.position;
      log(
        "tick",
        `${name} pos=(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`
      );
    }
  }, 10_000);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
