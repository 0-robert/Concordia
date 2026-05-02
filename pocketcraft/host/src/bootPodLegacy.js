// Boot a BrowserPod, stage the server code into it, run npm install,
// run `node index.js`, and resolve once both portals (viewer + command WS)
// have fired.
//
// Returns:
//   { pod, viewerUrl, cmdWsUrl, terminal }
//
// The caller wires viewerUrl into the iframe and cmdWsUrl into a WebSocket.

import { BrowserPod } from "@leaningtech/browserpod";

// Server source files — small, copied as text into /app/.
const SERVER_FILES = [
  "index.js",
  "bot.js",
  "commands.js",
  "duplexPair.js",
  "tools.js",
  "worldSetup.js",
  "extract.js",
  "package.json",
];

// Pre-built node_modules tarball — shipped instead of running npm install
// inside the pod (which is too slow due to IndexedDB write churn during reify).
const NODE_MODULES_TARBALL = "node_modules.tar.gz";

const VIEWER_PORT = 3007;
const CMD_PORT = 3008;

async function copyFile(pod, relPath) {
  const f = await pod.createFile("/app/" + relPath, "binary");
  // Cache-bust so the browser doesn't serve stale bytes between rebuilds
  const resp = await fetch("/app/" + relPath + "?v=" + Date.now(), {
    cache: "no-cache",
  });
  if (!resp.ok) throw new Error(`fetch ${relPath} failed: ${resp.status}`);
  const buf = await resp.arrayBuffer();
  await f.write(buf);
  await f.close();
  return buf.byteLength;
}

/**
 * Stream a large file into the pod in chunks — avoids OOM (Chrome ERR 5)
 * for files like the 106 MB node_modules tarball. Calls onProgress(soFar, total).
 */
async function copyFileStreamed(pod, relPath, onProgress = () => {}) {
  const f = await pod.createFile("/app/" + relPath, "binary");
  const resp = await fetch("/app/" + relPath);
  if (!resp.ok) throw new Error(`fetch ${relPath} failed: ${resp.status}`);
  const total = Number(resp.headers.get("content-length") || 0);
  const reader = resp.body.getReader();
  let written = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // value is Uint8Array — get its ArrayBuffer slice (NOT the underlying which may be larger)
    const ab = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    await f.write(ab);
    written += value.byteLength;
    onProgress(written, total);
  }
  await f.close();
  return written;
}

/**
 * Boot pod, stage files, install deps, run server, wait for portals.
 * @param {object} opts
 * @param {HTMLElement} opts.terminalEl  - element for pod's xterm.js terminal
 * @param {(line: string) => void} [opts.log]  - optional progress logger
 * @returns {Promise<{pod, terminal, viewerUrl: string, cmdWsUrl: string}>}
 */
export async function bootPod({ terminalEl, log = () => {} } = {}) {
  log("[boot] BrowserPod.boot()…");

  // Stable storageKey so the extracted /app/node_modules/ persists across
  // reloads. Bump this version string any time we hit a `function signature
  // mismatch` / corrupted-IndexedDB error to abandon the poisoned store.
  // URL `?storage=fresh-<x>` forces a one-off fresh disk.
  const params = new URLSearchParams(location.search);
  const storageKey = params.get("storage") || "pocketcraft-v2-clean";

  const pod = await BrowserPod.boot({
    apiKey: import.meta.env.VITE_BP_APIKEY,
    storageKey,
  });
  log(`[boot] pod ready (storageKey=${storageKey})`);

  const terminal = terminalEl
    ? await pod.createDefaultTerminal(terminalEl)
    : undefined;

  // Capture portal URLs as they fire — the SECOND portal we get back may
  // arrive after we've already started waiting, so we use a Map keyed by
  // port number.
  const portals = new Map();
  const portalWaiters = new Map();
  pod.onPortal(({ url, port }) => {
    log(`[boot] portal :${port} → ${url}`);
    portals.set(port, url);
    const waiter = portalWaiters.get(port);
    if (waiter) waiter(url);
  });
  function awaitPortal(port) {
    if (portals.has(port)) return Promise.resolve(portals.get(port));
    return new Promise((resolve) => portalWaiters.set(port, resolve));
  }

  log("[boot] mkdir /app, /app/logs…");
  await pod.createDirectory("/app", { recursive: true });
  await pod.createDirectory("/app/logs", { recursive: true });

  log(`[boot] copying ${SERVER_FILES.length} server files…`);
  for (const f of SERVER_FILES) {
    const n = await copyFile(pod, f);
    log(`  ${f} (${n} bytes)`);
  }

  // Cache check: only skip extract if a marker file with the CURRENT
  // tarball version exists. Each rebuild bumps CACHE_VERSION → forces
  // re-extract. Avoids serving stale (broken) prior extracts.
  const CACHE_VERSION = "v5-streaming-extract";
  let alreadyExtracted = false;
  try {
    const probe = await pod.openFile("/app/.cache-version", "utf-8");
    const v = await probe.read();
    await probe.close();
    if (v === CACHE_VERSION) {
      alreadyExtracted = true;
      log(`[boot] node_modules cached at ${CACHE_VERSION} — skipping extract`);
    } else {
      log(`[boot] cache version mismatch (have ${v}, want ${CACHE_VERSION}) — re-extract`);
    }
  } catch {
    log("[boot] no cache marker — fresh extract");
  }

  if (!alreadyExtracted) {
    // Defensive: delete any stale tarball + node_modules from previous
    // failed boots. createFile appears to append to existing files in some
    // cases, leading to corrupted (oversized) tarballs.
    log("[boot] cleaning stale /app/node_modules*…");
    await pod.run(
      "node",
      [
        "-e",
        "const fs=require('fs'); try{fs.rmSync('/app/node_modules.tar.gz',{force:true});}catch{} try{fs.rmSync('/app/node_modules',{recursive:true,force:true});}catch{} console.log('cleaned');",
      ],
      { echo: true, terminal, cwd: "/app" }
    );

    log(`[boot] copying ${NODE_MODULES_TARBALL} (~15 MB)…`);
    const tStart = Date.now();
    const n = await copyFile(pod, NODE_MODULES_TARBALL);
    const dt = ((Date.now() - tStart) / 1000).toFixed(1);
    log(`[boot]   tarball copied: ${(n / 1024 / 1024).toFixed(1)} MB in ${dt}s`);

    // Verify size matches what we sent (sanity for the append-vs-overwrite bug)
    log("[boot] verifying tarball size in pod…");
    await pod.run(
      "node",
      ["-e", "console.log('tarball size in pod:', require('fs').statSync('/app/node_modules.tar.gz').size, 'bytes')"],
      { echo: true, terminal, cwd: "/app" }
    );

    log("[boot] extracting into /app/node_modules/ (watch pod terminal)…");
    // Watchdog: if extract runs > 5 min, complain (IndexedDB writes are slow)
    const extractStart = Date.now();
    const watchdog = setInterval(() => {
      const mins = ((Date.now() - extractStart) / 60000).toFixed(1);
      log(`[boot] … still extracting (${mins} min elapsed)`);
    }, 30_000);
    try {
      await pod.run("node", ["extract.js", "node_modules.tar.gz", "."], {
        echo: true,
        terminal,
        cwd: "/app",
      });
    } finally {
      clearInterval(watchdog);
    }
    const extractDt = ((Date.now() - extractStart) / 1000).toFixed(1);
    log(`[boot] extract done in ${extractDt}s`);

    // Write cache marker so next boot knows this version is good
    const markerFile = await pod.createFile("/app/.cache-version", "utf-8");
    await markerFile.write(CACHE_VERSION);
    await markerFile.close();
    log(`[boot] extract done — cache marker written (${CACHE_VERSION})`);
  }

  // Sanity check the deps actually loaded post-extract
  log("[boot] sanity: require all deps…");
  await pod.run("node", [
    "-e",
    "['flying-squid','mineflayer','mineflayer-pathfinder','prismarine-viewer','ws'].forEach(m => { try { require(m); console.log('  OK', m); } catch (e) { console.log('  FAIL', m, e.message); } })",
  ], { echo: true, terminal, cwd: "/app" });

  // Fire-and-forget node index.js. pod.run returns a THENABLE (not a real
  // Promise) — calling .catch on it doesn't work. Wrap in an async IIFE.
  log("[boot] node index.js…");
  (async () => {
    try {
      await pod.run("node", ["index.js"], {
        echo: true,
        terminal,
        cwd: "/app",
      });
      log("[boot] !! node index.js exited unexpectedly — check pod terminal for error");
    } catch (e) {
      log(`[boot] !! node index.js threw: ${e?.message || JSON.stringify(e)}`);
    }
  })();

  log("[boot] waiting for portals (viewer + cmd)…");
  const [viewerUrl, cmdUrl] = await Promise.all([
    awaitPortal(VIEWER_PORT),
    awaitPortal(CMD_PORT),
  ]);

  // Convert HTTPS portal URL to WSS for the WebSocket
  const cmdWsUrl = cmdUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");

  log(`[boot] all portals up`);
  log(`  viewer : ${viewerUrl}`);
  log(`  cmd ws : ${cmdWsUrl}`);
  return { pod, terminal, viewerUrl, cmdWsUrl };
}
