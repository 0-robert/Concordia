// Outbound WS bridge from this laptop into the pod-host relay.
//
// The pod-host runs in a public BrowserPod portal. We can't tunnel the
// laptop's :3008 inbound, so we invert the direction: the laptop dials
// out to the pod's wss://<portal>/ws/laptop endpoint and treats the
// connection as a multiplexed channel:
//
//   pod → laptop:
//     { type: "phone_msg", sid, payload }     phone X sent us a request
//     { type: "phone_connect", sid }          phone X joined
//     { type: "phone_disconnect", sid }       phone X left
//
//   laptop → pod:
//     { type: "bots", payload: {...} }        bot list cache (sent on connect)
//     { type: "phone_reply", sid, payload }   id-keyed reply for phone X
//     { type: "broadcast", payload }          fan-out event (tool_start, etc.)
//
// On disconnect we reconnect with backoff. While disconnected, broadcasts
// are dropped silently (the laptop's local WS clients still get them).

const WebSocket = require("ws");

function startRelayBridge({ relayUrl, cmdServer, log = () => {}, reconnectMs = 2000 }) {
  let ws = null;
  let isClosed = false;
  let reconnectTimer = null;

  const broadcastSink = (event) => {
    if (ws?.readyState === 1) {
      ws.send(JSON.stringify({ type: "broadcast", payload: event }));
    }
  };

  function pushBots() {
    if (ws?.readyState !== 1) return;
    ws.send(JSON.stringify({
      type: "bots",
      payload: {
        bots: cmdServer.listBots(),
        overviewPort: global.__overviewPort || null,
      },
    }));
  }

  function connect() {
    if (isClosed) return;
    log("bridge", `connecting to ${relayUrl}`);
    ws = new WebSocket(relayUrl);

    ws.on("open", () => {
      log("bridge", "connected");
      pushBots();
      cmdServer.addBroadcastSink(broadcastSink);
    });

    ws.on("message", async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      switch (msg.type) {
        case "phone_msg": {
          const sid = msg.sid;
          const sendBack = (obj) => {
            if (ws?.readyState === 1) {
              ws.send(JSON.stringify({ type: "phone_reply", sid, payload: obj }));
            }
          };
          try {
            await cmdServer.handleParsedMessage(msg.payload, sendBack);
          } catch (e) {
            log("bridge-err", `handleParsedMessage threw: ${e?.message}`);
          }
          return;
        }
        case "phone_connect":
          log("bridge", `phone joined: ${msg.sid}`);
          return;
        case "phone_disconnect":
          log("bridge", `phone left: ${msg.sid}`);
          return;
        default:
          log("bridge-warn", `unknown msg.type from relay: ${msg.type}`);
      }
    });

    const onGone = (why) => {
      cmdServer.removeBroadcastSink(broadcastSink);
      if (isClosed) return;
      log("bridge", `disconnected (${why}) — reconnecting in ${reconnectMs}ms`);
      reconnectTimer = setTimeout(connect, reconnectMs);
    };

    ws.on("close", () => onGone("close"));
    ws.on("error", (e) => log("bridge-err", e?.message || String(e)));
  }

  connect();

  return {
    close() {
      isClosed = true;
      clearTimeout(reconnectTimer);
      cmdServer.removeBroadcastSink(broadcastSink);
      try { ws?.close(); } catch {}
    },
    isConnected() { return ws?.readyState === 1; },
  };
}

module.exports = { startRelayBridge };
