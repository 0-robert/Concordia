// In-memory Duplex pair for connecting flying-squid's server-side
// minecraft-protocol handler directly to mineflayer's client-side, without
// going through TCP.
//
// This is necessary because BrowserPod blocks 127.0.0.1 TCP loopback — even
// between two endpoints within the same Node process. Using a stream-pair
// bypasses the kernel's TCP stack entirely (it's all in-memory queues).
//
// Each returned stream:
//   • IS a Duplex stream (extends Readable + Writable)
//   • Looks enough like a `net.Socket` for `minecraft-protocol.setSocket`
//     to accept it (see client.js#setSocket: pipe, on(end|close|timeout|error),
//     setNoDelay, etc.)
//   • Emits a `connect` event on next tick so the client-side handler
//     (which waits for connect before emitting its own 'connect') doesn't hang

const { Duplex } = require("stream");

class Pipe extends Duplex {
  constructor() {
    super({ allowHalfOpen: false });
    this._peer = null;
  }
  _read() {
    // no-op — data is pushed in from our peer's _write
  }
  _write(chunk, enc, cb) {
    if (!this._peer || this._peer.destroyed) return cb();
    this._peer.push(chunk);
    cb();
  }
  _final(cb) {
    if (this._peer && !this._peer.destroyed) this._peer.push(null);
    cb();
  }
  _destroy(err, cb) {
    if (this._peer && !this._peer.destroyed) {
      try { this._peer.destroy(err); } catch {}
    }
    cb(err);
  }
  // Stub methods net.Socket has that minecraft-protocol touches.
  setNoDelay() { return this; }
  setTimeout() { return this; }
  setKeepAlive() { return this; }
  get remoteAddress() { return "127.0.0.1"; }
  get remotePort() { return 0; }
}

/**
 * Create a connected duplex pair. Writes to one side are readable on the
 * other. Both sides emit `connect` on next tick so handlers waiting for
 * connection wake up.
 * @returns {{serverEnd: Pipe, clientEnd: Pipe}}
 */
function makeDuplexPair() {
  const serverEnd = new Pipe();
  const clientEnd = new Pipe();
  serverEnd._peer = clientEnd;
  clientEnd._peer = serverEnd;
  setImmediate(() => {
    serverEnd.emit("connect");
    clientEnd.emit("connect");
  });
  return { serverEnd, clientEnd };
}

module.exports = { makeDuplexPair };
