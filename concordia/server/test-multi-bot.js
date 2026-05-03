// Verify per-bot routing: Alice and Bob each get their own state.
const WebSocket = require("ws");
const ws = new WebSocket("ws://localhost:3008");
let nextId = 1;
const pending = new Map();

function call(bot, tool, args = {}) {
  const id = String(nextId++);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, bot, tool, args }));
  });
}

ws.on("open", async () => {
  console.log("connected");

  console.log("\n--- Alice state ---");
  console.log(await call("Alice", "state"));

  console.log("\n--- Bob state ---");
  console.log(await call("Bob", "state"));

  console.log("\n--- Alice chat ---");
  console.log(await call("Alice", "chat", { text: "hello from Alice" }));

  console.log("\n--- Bob chat ---");
  console.log(await call("Bob", "chat", { text: "hi I'm Bob" }));

  console.log("\n--- bad bot ---");
  console.log(await call("Charlie", "state").catch(e => ({ err: e.message })));

  console.log("\n--- Alice goTo (3, 5, 2) ---");
  console.log(await call("Alice", "goTo", { x: 3, y: 5, z: 2, range: 1 }));
  console.log(await call("Alice", "state"));

  console.log("\n--- Bob goTo (10, 5, 2) ---");
  console.log(await call("Bob", "goTo", { x: 10, y: 5, z: 2, range: 1 }));
  console.log(await call("Bob", "state"));

  console.log("\nDONE");
  setTimeout(() => process.exit(), 200);
});

ws.on("message", (data) => {
  const msg = JSON.parse(data);
  if (msg.event) return;
  if (msg.id === undefined) return;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.result);
  else p.reject(new Error(msg.error));
});
ws.on("error", (e) => { console.error("ws err:", e.message); process.exit(1); });
