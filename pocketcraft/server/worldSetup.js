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

  // 2. Diamond vein: 2x2x2 cube starting 10 blocks west of spawn
  const veinOrigin = SPAWN.offset(-10, 0, 0);
  for (let dx = 0; dx < 2; dx++) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dz = 0; dz < 2; dz++) {
        await set(veinOrigin.offset(dx, dy, dz), "diamond_ore");
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
 * Once the bot has spawned, give it the starting inventory for the demo.
 * Creative-mode bots can set any inventory slot directly.
 */
async function seedBotInventory(bot, mcVersion) {
  const mcData = require("minecraft-data")(mcVersion);
  const Item = require("prismarine-item")(mcVersion);

  const make = (name, count = 1, metadata = null, nbt = null) => {
    const it = mcData.itemsByName[name];
    if (!it) throw new Error(`unknown item: ${name}`);
    return new Item(it.id, count, metadata, nbt);
  };

  // Slot numbering: hotbar is 36-44, main inventory is 9-35.
  // bot.creative.setInventorySlot uses absolute indices.

  // Hotbar slot 0 (= window slot 36): iron pickaxe with low durability
  // We can't set durability via the simple Item ctor; use NBT damage tag.
  const ironPick = make("iron_pickaxe");
  // Iron pickaxe has 250 max durability. Set damage to 248 → 2 uses left.
  ironPick.nbt = {
    type: "compound",
    name: "",
    value: {
      Damage: { type: "int", value: 248 },
    },
  };
  await bot.creative.setInventorySlot(36, ironPick);

  // Hotbar slot 7 (= window slot 43): fresh iron pickaxe (the spare)
  await bot.creative.setInventorySlot(43, make("iron_pickaxe"));

  // Other hotbar / inventory items
  await bot.creative.setInventorySlot(37, make("oak_planks", 5));
  await bot.creative.setInventorySlot(38, make("stick", 4));
  await bot.creative.setInventorySlot(39, make("string", 2));
}

module.exports = { seedWorld, seedBotInventory };
