// Bot tool implementations.
//
// Each tool is async, takes a single args object, returns a plain JSON-able value.
// Throws on failure (the CommandServer wraps it as {ok:false,error:...}).

const { Vec3 } = require("vec3");
const { Movements, goals } = require("mineflayer-pathfinder");

function makeTools(bot, mcVersion) {
  const mcData = require("minecraft-data")(mcVersion);

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
     */
    mine: async ({ x, y, z, why }) => {
      if ([x, y, z].some((v) => typeof v !== "number")) {
        throw new Error("x, y, z required");
      }
      const target = bot.blockAt(new Vec3(x, y, z));
      if (!target) throw new Error("no block at that position (chunk not loaded?)");
      if (target.name === "air") throw new Error("block is air, nothing to mine");
      narrate(`mining ${target.name}` + (why ? ` (${why})` : ""));
      // Move to within reach if needed
      const dist = bot.entity.position.distanceTo(target.position);
      if (dist > 4.5) {
        await bot.pathfinder.goto(new goals.GoalLookAtBlock(target.position, bot.world));
      }
      const minedName = target.name;
      try {
        await bot.dig(target);
      } catch (e) {
        // Detect common pickaxe-broken / wrong-tool errors and surface them
        // as recoverable so Claude (or the demo logic) can react.
        if (/block_not_diggable|no.*tool|wrong.*tool|broke/i.test(e.message)) {
          narrate("⚠ tool broke or wrong tool — switching");
          throw new Error("tool_broken: " + e.message);
        }
        throw e;
      }
      return { mined: minedName, at: { x, y, z } };
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

    /** Craft an item using nearest crafting table. args: { name, count? } */
    craft: async ({ name, count = 1 }) => {
      if (!name) throw new Error("name required");
      const id = mcData.itemsByName[name]?.id;
      if (id === undefined) throw new Error(`unknown item: ${name}`);

      const tableBlock = bot.findBlock({
        matching: mcData.blocksByName.crafting_table.id,
        maxDistance: 16,
      });

      const recipes = bot.recipesFor(id, null, count, tableBlock);
      if (recipes.length === 0) {
        throw new Error(`no recipe for ${name} with current inventory`);
      }
      narrate(`🔨 crafting ${name} x${count}`);
      // Look at the table for a more cinematic moment
      if (tableBlock) {
        await bot.lookAt(tableBlock.position.offset(0.5, 0.5, 0.5)).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 600)); // brief pause = "doing it"
      await bot.craft(recipes[0], count, tableBlock || undefined);
      narrate(`✓ crafted ${name}`);
      return { crafted: name, count };
    },
  };

  return tools;
}

module.exports = { makeTools };
