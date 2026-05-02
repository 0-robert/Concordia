// Shared WebSocket client that talks to the server's command WS.
// Used by both main-screen.js (read-only event observer) and phone.js
// (sends tool calls + observes its own bot's events).

export function makeClient({
  url,
  onEvent = () => {},
  onConnect = () => {},
  onDisconnect = () => {},
} = {}) {
  let ws = null;
  let nextId = 1;
  const pending = new Map();

  function call(bot, tool, args = {}) {
    if (!ws || ws.readyState !== ws.OPEN) {
      return Promise.reject(new Error("not connected"));
    }
    const id = String(nextId++);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, bot, tool, args }));
    });
  }

  function connect() {
    ws = new WebSocket(url);
    ws.onopen = () => onConnect();
    ws.onclose = () => {
      onDisconnect();
      setTimeout(connect, 1500);
    };
    ws.onerror = () => {};
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.event) {
        onEvent(msg);
        return;
      }
      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(String(msg.error || "(no error)")));
      }
    };
  }

  connect();
  return { call, get ws() { return ws; } };
}
