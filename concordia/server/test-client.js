// Drive the bot through (a simplified version of) the demo scenario.
// Usage: node test-client.js

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

ws.on("open", async () => {
  const log = (s) => console.log(`[t+${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
  const t0 = Date.now();
  log("connected");

  await call("chat", { text: "starting demo run" });

  log("--- 1. find diamond_ore ---");
  const dia = await call("findBlock", { name: "diamond_ore" });
  console.log(dia);
  if (!dia.found) { console.log("no diamonds, abort"); process.exit(1); }

  log("--- 2. goTo diamond_ore ---");
  const arrived = await call("goTo", {
    x: dia.position.x, y: dia.position.y, z: dia.position.z, range: 2
  });
  console.log(arrived);

  log("--- 3. equip iron_pickaxe ---");
  console.log(await call("equip", { name: "iron_pickaxe" }));

  log("--- 4. mine the diamond ---");
  const mined = await call("mine", {
    x: dia.position.x, y: dia.position.y, z: dia.position.z
  });
  console.log(mined);

  log("--- 5. inventory check ---");
  const inv = await call("inventory");
  console.log(inv);

  log("--- 6. find crafting_table ---");
  const tbl = await call("findBlock", { name: "crafting_table" });
  console.log(tbl);

  log("--- 7. goTo crafting_table ---");
  console.log(await call("goTo", {
    x: tbl.position.x, y: tbl.position.y, z: tbl.position.z, range: 2
  }));

  await call("chat", { text: "demo run complete" });

  log("done");
  setTimeout(() => process.exit(0), 500);
});

ws.on("message", (data) => {
  const msg = JSON.parse(data);
  if (msg.event) {
    if (msg.event !== "tool_start" && msg.event !== "tool_end") {
      // console.log("  [event]", msg);
    }
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.result);
  else p.resolve({ error: msg.error });
});
ws.on("error", (e) => { console.error("ws error:", e.message); process.exit(1); });
