// World pre-seeding for the chestplate demo.
//
// After the server is listening but before the bot has fully spawned-in,
// we place a crafting table and a diamond vein at deterministic offsets
// from spawn, so the demo never depends on terrain RNG.

const { Vec3 } = require("vec3");

/**
 * Place blocks into the overworld via flying-squid's world API.
 * @param {object} server flying-squid server returned by createMCServer
 * @param {string} mcVersion e.g. "1.18.2"
 */
async function seedWorld(server, mcVersion, center) {
  const mcData = require("minecraft-data")(mcVersion);
  const overworld = server.overworld;

  // Seed relative to a given center (typically bot spawn position).
  // y is forced to 4 (the surface in flying-squid superflat).
  const SPAWN = new Vec3(Math.floor(center.x), 4, Math.floor(center.z));
  const blockByName = (name) => {
    const b = mcData.blocksByName[name];
    if (!b) throw new Error(`unknown block: ${name}`);
    return b;
  };

  // Use serv.setBlock — it broadcasts block_change to all players AND updates world.
  async function set(pos, name) {
    const b = blockByName(name);
    const stateId = b.defaultState ?? b.minStateId ?? b.id;
    await server.setBlock(overworld, pos, stateId);
  }

  // 1. Crafting table: 5 blocks east of spawn at ground level
  const craftPos = SPAWN.offset(5, 0, 0);
  await set(craftPos, "crafting_table");

  // 2. Diamond vein: 2x2x2 cube starting 10 blocks west of spawn,
  //    partially buried in a small hill so it looks discovered-natural.
  const veinOrigin = SPAWN.offset(-10, 0, 0);
  for (let dx = 0; dx < 2; dx++) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dz = 0; dz < 2; dz++) {
        await set(veinOrigin.offset(dx, dy, dz), "diamond_ore");
      }
    }
  }

  // 3. A small hill around/behind the diamond vein — makes the world
  //    feel less like a tennis court. Dome shape, 2 blocks tall at peak.
  const hillCenter = SPAWN.offset(-12, 0, 0);
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      const d = Math.sqrt(dx * dx + dz * dz);
      // dome: height falls off with distance
      const h = Math.max(0, Math.round(3 - d * 0.7));
      for (let dy = 0; dy < h; dy++) {
        const p = hillCenter.offset(dx, dy, dz);
        // don't overwrite diamonds
        const existing = await overworld.getBlock(p);
        if (existing && existing.name === "diamond_ore") continue;
        await set(p, dy === h - 1 ? "grass_block" : "dirt");
      }
    }
  }

  // 4. A couple of trees to give the scene depth
  const treePositions = [
    SPAWN.offset(3, 0, 8),
    SPAWN.offset(-3, 0, 10),
    SPAWN.offset(10, 0, -3),
  ];
  for (const base of treePositions) {
    // Trunk: 4 oak logs
    for (let dy = 0; dy < 4; dy++) {
      await set(base.offset(0, dy, 0), "oak_log");
    }
    // Leaves: cross/sphere pattern at top
    const top = base.offset(0, 3, 0);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = 0; dy <= 2; dy++) {
          const dist = Math.sqrt(dx * dx + dy * dy * 1.5 + dz * dz);
          if (dist > 2.2) continue;
          if (dx === 0 && dz === 0 && dy === 0) continue; // don't replace trunk
          const lp = top.offset(dx, dy, dz);
          const existing = await overworld.getBlock(lp);
          if (existing && existing.name !== "air") continue;
          await set(lp, "oak_leaves");
        }
      }
    }
  }

  return {
    spawn: SPAWN,
    craftingTable: craftPos,
    diamondVein: veinOrigin,
  };
}

/**
 * Force the bot inventory empty at spawn. flying-squid sometimes hands out
 * a stray iron_pickaxe in slot 36 (and a spare in 43 for some bots) — we
 * don't want it because the demo shows Claude gathering everything from
 * scratch. Wipe all slots, locally and on the server, before tools run.
 */
async function seedBotInventory(bot, mcVersion) {
  // Clear every player-inventory slot (9..45 = main + hotbar + offhand).
  // LOCAL ONLY (see tools.js comment) — server-side tracking is unreliable
  // over the duplex pair and the demo only cares about the bot's view.
  for (let slot = 9; slot <= 45; slot++) {
    if (bot.inventory.updateSlot) bot.inventory.updateSlot(slot, null);
    else bot.inventory.slots[slot] = null;
  }
}

module.exports = { seedWorld, seedBotInventory };
