// Boot the pod-host inside a BrowserPod sandbox.
//
// Stages the (small) pod-host tree, runs npm install (express + ws), launches
// `node server.js`, and resolves once the portal URL fires.
//
// Returns: { pod, terminal, portalUrl, podWsUrl }
//   portalUrl  — https://<sub>.browserpod.io  (use for /api/* + WS upgrade)
//   podWsUrl   — wss://<sub>.browserpod.io   (laptop dials /ws/laptop here)
//
// NOTE: a previous iteration tried to run flying-squid + prismarine-viewer
// inside the pod. That approach is preserved as bootPodLegacy.js and is
// confirmed not to fit (24k node_modules files trigger IndexedDB OOM).

import { BrowserPod } from "@leaningtech/browserpod";

const POD_HOST_PORT = 4000;
const POD_HOST_BASE = "/pod-host";
const APP_DIR = "/app";

async function fetchBuf(url) {
  const r = await fetch(url + (url.includes("?") ? "&" : "?") + "_=" + Date.now(), { cache: "no-cache" });
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  return r.arrayBuffer();
}

async function copyFile(pod, relPath, log) {
  const buf = await fetchBuf(`${POD_HOST_BASE}/${relPath}`);
  // Ensure parent dir exists
  const parent = relPath.split("/").slice(0, -1).join("/");
  if (parent) await pod.createDirectory(`${APP_DIR}/${parent}`, { recursive: true });
  const f = await pod.createFile(`${APP_DIR}/${relPath}`, "binary");
  await f.write(buf);
  await f.close();
  log(`  ${relPath} (${buf.byteLength} B)`);
}

/**
 * Boot pod-host in a BrowserPod sandbox.
 * @param {object} opts
 * @param {HTMLElement} opts.terminalEl     element to attach the pod terminal to
 * @param {string}      opts.anthropicKey   Anthropic API key (passed to pod env)
 * @param {(s:string)=>void} [opts.log]
 * @returns {Promise<{pod, terminal, portalUrl: string, podWsUrl: string}>}
 */
export async function bootPod({ terminalEl, anthropicKey, log = () => {} } = {}) {
  if (!anthropicKey) throw new Error("bootPod: anthropicKey required");

  // Bump this when changing pod-host structure to bypass corrupt IndexedDB
  // (BrowserPod uses storageKey to identify the persisted disk image).
  const params = new URLSearchParams(location.search);
  const storageKey = params.get("storage") || "concordia-podhost-v1";

  log("[boot] BrowserPod.boot()");
  const pod = await BrowserPod.boot({
    apiKey: import.meta.env.VITE_BP_APIKEY,
    storageKey,
  });
  log(`[boot] pod ready (storageKey=${storageKey})`);

  const terminal = terminalEl
    ? await pod.createDefaultTerminal(terminalEl)
    : undefined;

  // Capture portal URL — there's only one (port 4000).
  let portalUrl = null;
  let portalResolve;
  const portalReady = new Promise((r) => (portalResolve = r));
  pod.onPortal(({ url, port }) => {
    log(`[boot] portal :${port} → ${url}`);
    if (port === POD_HOST_PORT && !portalUrl) {
      portalUrl = url;
      portalResolve(url);
    }
  });

  // ── Stage files ────────────────────────────────────────────────────────────
  log(`[boot] fetching manifest from ${POD_HOST_BASE}/manifest.json`);
  const manifest = await fetch(`${POD_HOST_BASE}/manifest.json?_=${Date.now()}`, {
    cache: "no-cache",
  }).then((r) => r.json());
  log(`[boot] manifest has ${manifest.files.length} files`);

  await pod.createDirectory(APP_DIR, { recursive: true });

  log("[boot] copying files into pod…");
  for (const rel of manifest.files) {
    await copyFile(pod, rel, log);
  }

  // ── npm install (small: express + ws + their deps) ─────────────────────────
  log("[boot] npm install (express + ws)…");
  const tInst = Date.now();
  await pod.run("npm", ["install", "--no-audit", "--no-fund", "--omit=optional"], {
    echo: true,
    terminal,
    cwd: APP_DIR,
  });
  log(`[boot] npm install done in ${((Date.now() - tInst) / 1000).toFixed(1)}s`);

  // ── Launch server (background — pod.run is thenable, wrap in IIFE) ────────
  log("[boot] node server.js");
  (async () => {
    try {
      await pod.run("node", ["server.js"], {
        echo: true,
        terminal,
        cwd: APP_DIR,
        env: [
          `ANTHROPIC_API_KEY=${anthropicKey}`,
          `PORT=${POD_HOST_PORT}`,
        ],
      });
      log("[boot] !! server.js exited unexpectedly");
    } catch (e) {
      log(`[boot] !! server.js threw: ${e?.message || JSON.stringify(e)}`);
    }
  })();

  log("[boot] waiting for portal…");
  const url = await portalReady;
  const podWsUrl = url.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  log(`[boot] up — portalUrl=${url}`);
  return { pod, terminal, portalUrl: url, podWsUrl };
}
