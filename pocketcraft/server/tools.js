// Bot tool implementations.
//
// Each tool is async, takes a single args object, returns a plain JSON-able value.
// Throws on failure (the CommandServer wraps it as {ok:false,error:...}).

const { Vec3 } = require("vec3");
const { Movements, goals } = require("mineflayer-pathfinder");

// Expected drops for mined blocks (creative mode doesn't drop; we fake it).
// Map of block_name -> dropped item_name (usually same, sometimes different).
const BLOCK_DROP = {
  diamond_ore: "diamond",
  coal_ore: "coal",
  iron_ore: "iron_ingot",
  gold_ore: "gold_ingot",
  grass_block: "dirt",
  stone: "cobblestone",
  // fallback = block itself
};

// Crafting recipes — FAKE because flying-squid's crafting-table GUI is broken.
// We swap inventory directly via creative.setInventorySlot.
//
// `nearTable` = recipe requires a crafting_table within 16 blocks (3×3 craft).
// otherwise it's a 2×2 inventory craft (planks/sticks need no table in real MC).
const RECIPES = {
  // Wood chain
  oak_planks:       { inputs: [{name:"oak_log",     count:1}], out_count: 4, nearTable: false },
  stick:            { inputs: [{name:"oak_planks",  count:2}], out_count: 4, nearTable: false },
  crafting_table:   { inputs: [{name:"oak_planks",  count:4}], out_count: 1, nearTable: false },

  // Tools
  wooden_pickaxe:   { inputs: [{name:"oak_planks", count:3}, {name:"stick", count:2}], out_count: 1, nearTable: true },
  wooden_sword:     { inputs: [{name:"oak_planks", count:2}, {name:"stick", count:1}], out_count: 1, nearTable: true },
  wooden_axe:       { inputs: [{name:"oak_planks", count:3}, {name:"stick", count:2}], out_count: 1, nearTable: true },
  stone_pickaxe:    { inputs: [{name:"cobblestone", count:3}, {name:"stick", count:2}], out_count: 1, nearTable: true },
  iron_pickaxe:     { inputs: [{name:"iron_ingot",  count:3}, {name:"stick", count:2}], out_count: 1, nearTable: true },

  // Diamonds
  diamond_chestplate: { inputs: [{name:"diamond", count:8}], out_count: 1, nearTable: true },
  diamond_sword:      { inputs: [{name:"diamond", count:2}, {name:"stick", count:1}], out_count: 1, nearTable: true },
  diamond_pickaxe:    { inputs: [{name:"diamond", count:3}, {name:"stick", count:2}], out_count: 1, nearTable: true },

  // Misc
  fishing_rod:        { inputs: [{name:"stick", count:3}, {name:"string", count:2}], out_count: 1, nearTable: true },
};

function makeTools(bot, mcVersion, server) {
  const mcData = require("minecraft-data")(mcVersion);
  const Block = server ? require("prismarine-block")(mcVersion) : null;

  // Pathfinder movements — tuned for our flat world
  const movements = new Movements(bot);
  movements.canDig = true;
  movements.allow1by1towers = true;
  movements.allowFreeMotion = true;
  bot.pathfinder.setMovements(movements);

  // Narration: announce what we're doing in chat. This is the cheapest
  // way to make the demo "feel" alive given prismarine-viewer's animation gap.
  // Throttled because rapid chat from the bot looks unnatural.
  let lastChat = 0;
  function narrate(text) {
    const now = Date.now();
    if (now - lastChat < 250) return;
    lastChat = now;
    bot.chat(text);
  }

  /** Get nearest entity by name (currently unused — placeholder for "follow"). */
  // const nearestEntity = (name) => {
  //   return Object.values(bot.entities).find((e) => e.name === name);
  // };

  const tools = {
    /** Speak in chat. args: { text } */
    chat: async ({ text }) => {
      if (typeof text !== "string") throw new Error("text required");
      bot.chat(text);
      return { said: text };
    },

    /** Return bot's current state. */
    state: async () => ({
      position: bot.entity?.position,
      yaw: bot.entity?.yaw,
      pitch: bot.entity?.pitch,
      health: bot.health,
      food: bot.food,
      gameMode: bot.game?.gameMode,
      heldItem: bot.heldItem
        ? { name: bot.heldItem.name, count: bot.heldItem.count, slot: bot.heldItem.slot }
        : null,
    }),

    /** List inventory. */
    inventory: async () => {
      return bot.inventory.items().map((i) => ({
        name: i.name,
        count: i.count,
        slot: i.slot,
        damage: i.nbt?.value?.Damage?.value ?? 0,
      }));
    },

    /** Find nearest block of a given type.
     *  args: { name, maxDistance? = 64 }
     */
    findBlock: async ({ name, maxDistance = 64 }) => {
      if (!name) throw new Error("name required");
      const id = mcData.blocksByName[name]?.id;
      if (id === undefined) throw new Error(`unknown block: ${name}`);
      const found = bot.findBlock({ matching: id, maxDistance });
      if (!found) return { found: false };
      return {
        found: true,
        position: { x: found.position.x, y: found.position.y, z: found.position.z },
        name: found.name,
      };
    },

    /** Walk/path to a target position.
     *  args: { x, y, z, range? = 1, why? }
     */
    goTo: async ({ x, y, z, range = 1, why }) => {
      if ([x, y, z].some((v) => typeof v !== "number")) {
        throw new Error("x, y, z required (numbers)");
      }
      narrate(why ? `walking to ${why} (${x}, ${y}, ${z})` : `walking to (${x}, ${y}, ${z})`);
      const goal = new goals.GoalNear(x, y, z, range);
      await bot.pathfinder.goto(goal);
      const p = bot.entity.position;
      return { arrivedAt: { x: Math.round(p.x*10)/10, y: Math.round(p.y*10)/10, z: Math.round(p.z*10)/10 } };
    },

    /** Mine (dig) the block at given coords.
     *  args: { x, y, z, why? }
     *  In creative mode, flying-squid doesn't drop items — we synthesize the
     *  drop by adding the expected item to the bot's inventory ourselves.
     */
    mine: async ({ x, y, z, why }) => {
      if ([x, y, z].some((v) => typeof v !== "number")) {
        throw new Error("x, y, z required");
      }
      const target = bot.blockAt(new Vec3(x, y, z));
      if (!target) throw new Error("no block at that position (chunk not loaded?)");
      if (target.name === "air") throw new Error("block is air, nothing to mine");
      narrate(`mining ${target.name}` + (why ? ` (${why})` : ""));
      const dist = bot.entity.position.distanceTo(target.position);
      if (dist > 4.5) {
        await bot.pathfinder.goto(new goals.GoalLookAtBlock(target.position, bot.world));
      }
      const minedName = target.name;
      try {
        await bot.dig(target);
      } catch (e) {
        if (/block_not_diggable|no.*tool|wrong.*tool|broke/i.test(e.message)) {
          narrate("⚠ tool broke — switching");
          throw new Error("tool_broken: " + e.message);
        }
        throw e;
      }
      // Synthesize drop: creative mode doesn't drop items, so we add one
      // manually to the first empty inventory slot.
      const dropName = BLOCK_DROP[minedName] || minedName;
      try {
        await giveItem(dropName, 1);
      } catch (e) {
        // ignore — Claude sees {mined} regardless
      }
      return { mined: minedName, drop: dropName, at: { x, y, z } };
    },

    /** Equip an item to mainhand. args: { name } */
    equip: async ({ name }) => {
      if (!name) throw new Error("name required");
      const item = bot.inventory.items().find((i) => i.name === name);
      if (!item) throw new Error(`no ${name} in inventory`);
      narrate(`equipping ${name}`);
      await bot.equip(item, "hand");
      return { equipped: name };
    },

    /** Place a block from inventory next to the bot. We bypass mineflayer's
     *  placeBlock (which needs server-protocol cooperation that flying-squid
     *  is flaky about) and instead write directly via server.setBlock. We
     *  decrement inventory locally to compensate.
     *  args: { name }
     */
    place: async ({ name }) => {
      if (!name) throw new Error("name required");
      if (!server) throw new Error("place tool unavailable (no server ref)");

      const item = bot.inventory.items().find((i) => i.name === name);
      if (!item) throw new Error(`no ${name} in inventory to place`);

      const blockInfo = mcData.blocksByName[name];
      if (!blockInfo) throw new Error(`'${name}' is not a placeable block`);

      const Vec3 = require("vec3").Vec3;
      const botPos = bot.entity.position.floored();

      // Find a free spot at the bot's feet level: cardinal + diagonals, in
      // priority order. We need the spot to currently be air.
      const candidates = [
        new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1), new Vec3(0, 0, -1),
        new Vec3(1, 0, 1), new Vec3(1, 0, -1),
        new Vec3(-1, 0, 1), new Vec3(-1, 0, -1),
      ];
      let placedAt = null;
      for (const off of candidates) {
        const target = botPos.plus(off);
        const here = await server.overworld.getBlock(target);
        if (!here || here.name === "air") {
          // Place directly via server. setBlock broadcasts to clients.
          const stateId = blockInfo.defaultState ?? blockInfo.minStateId ?? blockInfo.id;
          const blk = Block.fromStateId(stateId, 0);
          await server.setBlock(server.overworld, target, blk);
          placedAt = target;
          break;
        }
      }
      if (!placedAt) throw new Error("no air block adjacent to place into");

      narrate(`placed ${name}`);

      // Decrement inventory: take 1 from the slot we found, set null if it was the last
      if (item.count <= 1) {
        if (bot.inventory.updateSlot) bot.inventory.updateSlot(item.slot, null);
        else bot.inventory.slots[item.slot] = null;
      } else {
        const Item = require("prismarine-item")(mcVersion);
        const newItem = new Item(mcData.itemsByName[name].id, item.count - 1);
        if (bot.inventory.updateSlot) bot.inventory.updateSlot(item.slot, newItem);
        else bot.inventory.slots[item.slot] = newItem;
      }

      return { placed: name, at: { x: placedAt.x, y: placedAt.y, z: placedAt.z } };
    },

    /** Craft an item. Uses our internal RECIPES since flying-squid's
     *  crafting-table GUI protocol is broken. For the demo, the bot
     *  is in creative mode, so we swap inventory directly.
     *  args: { name, count? = 1 }
     */
    craft: async ({ name, count = 1 }) => {
      if (!name) throw new Error("name required");
      const itemInfo = mcData.itemsByName[name];
      if (!itemInfo) throw new Error(`unknown item: ${name}`);
      const recipe = RECIPES[name];
      if (!recipe) throw new Error(`no recipe defined for ${name}`);

      // 3×3 recipes need a crafting table; 2×2 recipes don't.
      let tableBlock = null;
      if (recipe.nearTable) {
        tableBlock = bot.findBlock({
          matching: mcData.blocksByName.crafting_table.id,
          maxDistance: 16,
        });
        if (!tableBlock) {
          throw new Error(
            `crafting ${name} needs a crafting_table within 16 blocks — go find or place one`
          );
        }
      }

      // Check inventory has enough of each input
      const have = {};
      for (const it of bot.inventory.items()) {
        have[it.name] = (have[it.name] || 0) + it.count;
      }
      for (const inp of recipe.inputs) {
        const need = inp.count * count;
        if ((have[inp.name] || 0) < need) {
          throw new Error(
            `missing ingredient: need ${need} ${inp.name}, have ${have[inp.name] || 0}`
          );
        }
      }

      // Cinematic: face the table if there is one, brief pause, narrate
      narrate(`🔨 crafting ${name} ×${count}`);
      if (tableBlock) {
        await bot.lookAt(tableBlock.position.offset(0.5, 0.8, 0.5)).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 600));

      // Consume inputs
      for (const inp of recipe.inputs) {
        await removeItem(inp.name, inp.count * count);
      }
      // Produce output
      await giveItem(name, recipe.out_count * count);

      narrate(`✓ crafted ${name}`);
      return { crafted: name, count: recipe.out_count * count };
    },
  };

  // ── inventory helpers (creative-mode direct manipulation) ────────────────

  /** Find the first inventory slot that's empty (or stacks `name`). */
  function findSlotFor(name) {
    // Try to stack onto existing
    const existing = bot.inventory.items().find((i) => i.name === name);
    if (existing) return existing.slot;
    // Else find a free slot (36-44 hotbar, 9-35 main)
    for (let slot = 9; slot <= 44; slot++) {
      if (!bot.inventory.slots[slot]) return slot;
    }
    return null;
  }

  // Inventory manipulation: LOCAL ONLY. We don't fire the network packet
  // because mineflayer's slot tracking races against our local writes —
  // a delayed server response would overwrite a freshly-set slot. The
  // demo only cares about the bot's view of its own inventory.
  //
  // Uses inventory.updateSlot which fires the proper events so other
  // mineflayer plumbing (heldItem getter, etc) stays in sync.
  async function safeSetSlot(slot, item) {
    if (bot.inventory.updateSlot) {
      bot.inventory.updateSlot(slot, item);
    } else {
      bot.inventory.slots[slot] = item;
    }
  }

  /** Add `count` of `name` to the bot's inventory. */
  async function giveItem(name, count) {
    const itemInfo = mcData.itemsByName[name];
    if (!itemInfo) throw new Error(`unknown item: ${name}`);
    const Item = require("prismarine-item")(mcVersion);

    let remaining = count;
    while (remaining > 0) {
      const slot = findSlotFor(name);
      if (slot === null) throw new Error("inventory full");
      const existing = bot.inventory.slots[slot];
      const already = existing?.name === name ? existing.count : 0;
      const add = Math.min(remaining, 64 - already);
      const newCount = already + add;
      await safeSetSlot(slot, new Item(itemInfo.id, newCount));
      remaining -= add;
    }
  }

  /** Remove `count` of `name` from the bot's inventory (any slots). */
  async function removeItem(name, count) {
    const Item = require("prismarine-item")(mcVersion);
    let remaining = count;
    for (const it of bot.inventory.items()) {
      if (it.name !== name || remaining <= 0) continue;
      const take = Math.min(it.count, remaining);
      const leftover = it.count - take;
      if (leftover === 0) {
        await safeSetSlot(it.slot, null);
      } else {
        await safeSetSlot(
          it.slot,
          new Item(mcData.itemsByName[name].id, leftover)
        );
      }
      remaining -= take;
    }
    if (remaining > 0) throw new Error(`short ${remaining} of ${name}`);
  }

  return tools;
}

module.exports = { makeTools };
