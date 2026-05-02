// Exercise every tool the bot exposes, end-to-end.
// Usage: node test-all-tools.js

const WebSocket = require("ws");

const ws = new WebSocket("ws://localhost:3008");
let nextId = 1;
const pending = new Map();

function call(tool, args = {}) {
  const id = String(nextId++);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, tool, args }));
  });
}

const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1);
const header = (s) => console.log(`\n[${elapsed()}s] ━━━ ${s} ━━━`);
const pass = (s) => console.log(`  ✅ ${s}`);
const fail = (s) => { console.log(`  ❌ ${s}`); failures.push(s); };
const info = (s) => console.log(`  ›  ${s}`);
const failures = [];

async function expectOk(tool, args, check = null) {
  try {
    const r = await call(tool, args);
    if (check) {
      const msg = check(r);
      if (msg) { fail(`${tool}: ${msg}`); return r; }
    }
    pass(`${tool}(${JSON.stringify(args).slice(0, 60)}) → ${JSON.stringify(r).slice(0, 100)}`);
    return r;
  } catch (e) {
    fail(`${tool}(${JSON.stringify(args)}) threw: ${e.message}`);
    return null;
  }
}

async function expectError(tool, args, errRegex) {
  try {
    const r = await call(tool, args);
    fail(`${tool}(${JSON.stringify(args)}) should have thrown but returned ${JSON.stringify(r)}`);
  } catch (e) {
    if (errRegex.test(e.message)) {
      pass(`${tool}(${JSON.stringify(args)}) → correctly errored: ${e.message.slice(0, 80)}`);
    } else {
      fail(`${tool}(${JSON.stringify(args)}) threw wrong error: ${e.message}`);
    }
  }
}

ws.on("open", async () => {
  console.log(`[${elapsed()}s] connected`);

  // ── basic read tools
  header("1/8  state");
  const st = await expectOk("state", {}, (r) =>
    !r.position ? "missing position" :
    r.gameMode !== "creative" ? "expected creative mode" :
    null
  );

  header("2/8  inventory");
  const inv = await expectOk("inventory", {}, (r) =>
    !Array.isArray(r) ? "not an array" :
    r.length === 0 ? "inventory unexpectedly empty" :
    null
  );
  info(`bot has ${inv?.length || 0} item stacks`);

  header("3/8  chat");
  await expectOk("chat", { text: "running self-test" }, (r) =>
    r.said !== "running self-test" ? "wrong echo" : null);

  // ── findBlock: success + not found + unknown block
  header("4/8  findBlock (success + not-found + error)");
  const dia = await expectOk("findBlock", { name: "diamond_ore" }, (r) =>
    !r.found ? "diamond_ore should be found" : null);
  const tbl = await expectOk("findBlock", { name: "crafting_table" }, (r) =>
    !r.found ? "crafting_table should be found" : null);
  await expectOk("findBlock", { name: "obsidian" }, (r) =>
    r.found ? "obsidian shouldn't exist in this world" : null);
  await expectError("findBlock", { name: "not_a_real_block" }, /unknown block/);

  // ── equip + goTo + mine
  header("5/8  equip");
  await expectOk("equip", { name: "iron_pickaxe" }, (r) =>
    r.equipped !== "iron_pickaxe" ? "not equipped" : null);

  header("6/8  goTo (→ diamond ore)");
  if (!dia?.found) { fail("skipping goTo: no diamond_ore"); }
  else {
    await expectOk("goTo", {
      x: dia.position.x, y: dia.position.y, z: dia.position.z, range: 2
    }, (r) => !r.arrivedAt ? "no arrivedAt" : null);
  }

  header("7/8  mine");
  if (!dia?.found) { fail("skipping mine: no diamond_ore"); }
  else {
    await expectOk("mine", {
      x: dia.position.x, y: dia.position.y, z: dia.position.z
    }, (r) => r.mined !== "diamond_ore" ? `wrong mined: ${r.mined}` : null);
    const inv2 = await call("inventory");
    const hasD = inv2.find((i) => i.name === "diamond");
    if (hasD) info(`inventory now has diamond ×${hasD.count}`);
    else info("no diamond in inventory yet (may be instant-drop)");
  }

  // ── goTo crafting_table + craft
  header("8/8  craft (fishing_rod: needs 3 stick + 2 string)");
  if (!tbl?.found) { fail("skipping craft: no crafting_table"); }
  else {
    await expectOk("goTo", {
      x: tbl.position.x, y: tbl.position.y, z: tbl.position.z, range: 2
    });
    await expectOk("craft", { name: "fishing_rod", count: 1 }, (r) =>
      r.crafted !== "fishing_rod" ? `wrong crafted: ${r.crafted}` : null);
    const inv3 = await call("inventory");
    const rod = inv3.find((i) => i.name === "fishing_rod");
    if (rod) info(`crafted fishing_rod ×${rod.count}`);
    else fail("fishing_rod not in inventory after craft");
  }

  // ── summary
  console.log(`\n[${elapsed()}s] ━━━ SUMMARY ━━━`);
  if (failures.length === 0) {
    console.log(`  🎉 ALL TOOLS PASSED`);
  } else {
    console.log(`  ⚠  ${failures.length} failure(s):`);
    for (const f of failures) console.log(`     • ${f}`);
    process.exitCode = 1;
  }
  setTimeout(() => process.exit(), 300);
});

ws.on("message", (data) => {
  const msg = JSON.parse(data);
  if (msg.event) return; // ignore event broadcasts
  if (msg.id === undefined) return;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.result);
  else p.reject(new Error(msg.error || "(empty error)"));
});
ws.on("error", (e) => { console.error("ws error:", e.message); process.exit(1); });
