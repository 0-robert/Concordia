// Pocketcraft — orchestrator (single-process, multi-agent, no TCP loopback).

// Load .env from repo root (ANTHROPIC_API_KEY for the team orchestrator).
(() => {
  const fs = require("fs");
  const path = require("path");
  for (const p of [
    path.resolve(__dirname, "..", "..", ".env"),
    path.resolve(__dirname, ".env"),
  ]) {
    try {
      const txt = fs.readFileSync(p, "utf8");
      for (const line of txt.split("\n")) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
        if (m && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
        }
      }
    } catch {
      // file missing is fine
    }
  }
})();

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
    // diamond_square is flying-squid's built-in realistic terrain
    // generator — natural hills, trees, stone layers. "seed" is fixed
    // so the demo world is reproducible across restarts.
    generation: { name: "diamond_square", options: { seed: 42424242, worldHeight: 80 } },
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

  // ── Shared world state — exposed to every bot's `team` + `deposit` ──
  // bots:            [{name, bot, tools, ...}] — populated as we spawn each
  // sharedChest:     Vec3 — set after worldSetup returns
  // chestContents:   { [itemName]: count } — grows with deposit() calls
  // lastActions:     Map<botName, {tool, argsSummary, time}>
  // onChestChange:   callback to broadcast chest state to phones + TV
  const world = {
    bots: [],
    sharedChest: null,
    chestContents: {},
    lastActions: new Map(),
    onChestChange: null, // wired below once CommandServer is up
  };

  // ── Spawn bots in sequence (so each gets its own duplex + spawn event) ──
  const { makeBot } = require("./bot");
  const bots = world.bots;
  for (const def of BOTS) {
    log("boot", `spawning bot '${def.name}'…`);
    try {
      const b = await makeBot(server, def.name, MC_VERSION, world);
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
  // Pin to a FIXED world center (instead of bots[0].entity.position) so
  // the base location is reproducible and bots can be TP'd to a known
  // safe spot regardless of where flying-squid randomly spawned them.
  const { Vec3 } = require("vec3");
  const WORLD_CENTER = new Vec3(0, 64, 0);
  await new Promise((r) => setTimeout(r, 1500));
  const { seedWorld } = require("./worldSetup");
  let seedPositions;
  try {
    seedPositions = await seedWorld(server, MC_VERSION, WORLD_CENTER);
    log("world", `basePlaza=${seedPositions.basePlaza}`);
    log("world", `craftingTable=${seedPositions.craftingTable}`);
    log("world", `sharedChest=${seedPositions.sharedChest}`);
    log("world", `${seedPositions.diamondSpots.length} exposed diamond veins`);
    // Expose chest position to all tools via the shared world object
    world.sharedChest = seedPositions.sharedChest;

    // Teleport bots onto the surface near the base plaza (on natural terrain
    // they spawn underground because flying-squid's spawn logic runs before
    // our world is ready to query).
    const base = seedPositions.basePlaza;
    const tpOffsets = [
      { dx:  2, dz:  2 },
      { dx: -2, dz:  2 },
      { dx:  2, dz: -2 },
      { dx: -2, dz: -2 },
    ];
    // TP each bot in three waves spread across 3 seconds. flying-squid's
    // spawn handshake intermittently swallows the first position packet;
    // repeating the TP guarantees every bot ends up at base.
    const tpOnce = async (label) => {
      for (let i = 0; i < bots.length; i++) {
        const off = tpOffsets[i % tpOffsets.length];
        const tx = base.x + off.dx;
        const tz = base.z + off.dz;
        const ty = base.y + 1;
        try {
          const player = server.players.find((p) => p.username === bots[i].name);
          const tpVec = new Vec3(tx, ty, tz);
          if (player && typeof player.sendSelfPosition === "function") {
            player.position = tpVec;
            player.sendSelfPosition(tpVec);
          }
          bots[i].bot.entity.position.set(tx, ty, tz);
          log("world", `tp[${label}] ${bots[i].name} → (${tx}, ${ty}, ${tz})`);
        } catch (e) {
          log("world-err", `tp ${bots[i].name}: ${e.message}`);
        }
      }
    };
    await tpOnce("1");
    await new Promise((r) => setTimeout(r, 800));
    await tpOnce("2");
    await new Promise((r) => setTimeout(r, 1500));
    await tpOnce("3");
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
    // to spin/zoom; covers the whole scene from up high. includeSelf=true
    // forces Alice's own entity to render so all 4 bots appear tinted in
    // the overview (without it, the camera-target's entity is hidden).
    mfViewer(bots[0].bot, {
      port: OVERVIEW_PORT,
      firstPerson: false,
      includeSelf: true,
    });
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
    const { runTeam } = require("./teamOrchestrator");

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
    const onTeamPrompt = (prompt) =>
      runTeam({ prompt, bots, cmdServer: cmd, log });

    cmd = new CommandServer({ port: 3008, log, onRelayUrl, onTeamPrompt });
    for (const { name, tools, viewerPort } of bots) {
      cmd.registerBot(name, tools, viewerPort);
    }
    cmd.start();

    // Track each tool call as "lastAction" on the world, so the `team`
    // tool can tell other bots what this one is currently doing.
    cmd.addBroadcastSink((evt) => {
      if (evt.event === "tool_start" && evt.bot) {
        const summary = (() => {
          if (!evt.args) return "";
          const kvs = Object.entries(evt.args)
            .filter(([k]) => k !== "why")
            .slice(0, 2)
            .map(([k, v]) => typeof v === "string" ? `${k}="${v.slice(0, 20)}"` : `${k}=${v}`);
          return kvs.join(",");
        })();
        world.lastActions.set(evt.bot, {
          tool: evt.tool, argsSummary: summary, time: Date.now(),
        });
      }
    });

    // Broadcast chest contents whenever it changes so the TV/phones can
    // render a shared "community chest" indicator — the visual payoff
    // of the deposit tool.
    world.onChestChange = (contents) => {
      cmd.broadcast({ event: "chest_state", contents });
    };

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
