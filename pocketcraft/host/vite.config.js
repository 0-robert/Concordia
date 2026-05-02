import { defineConfig } from "vite";

// COOP/COEP for SharedArrayBuffer (required by BrowserPod).
// Per browserpod docs (`pages/guides/hosting.md`): require-corp + same-origin.
// Portal URLs do send CORP headers so iframes embed cleanly.
import { resolve } from "path";

export default defineConfig({
  // 3 entry points:
  //   /              → index.html (single-bot debug UI, kept for dev)
  //   /main.html     → main screen with tiled views + QR
  //   /phone.html    → mobile chat-only control surface
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        main: resolve(__dirname, "main.html"),
        phone: resolve(__dirname, "phone.html"),
      },
    },
  },
  server: {
    host: "0.0.0.0", // accessible to phones on LAN
    port: 5174,
    headers: {
      // `credentialless` instead of `require-corp` — still cross-origin
      // isolated (SharedArrayBuffer works) but allows embedding iframes
      // (like localhost:3007 prismarine-viewer) that don't send CORP headers.
      "Cross-Origin-Embedder-Policy": "credentialless",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  plugins: [
    {
      name: "coop-coep",
      configureServer(server) {
        // Belt + braces: also set headers via middleware
        server.middlewares.use((_req, res, next) => {
          res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
          next();
        });
      },
    },
    {
      // Stop vite from re-compressing our pre-gzipped tarball. Without
      // this, the response gets `Content-Encoding: gzip` slapped on,
      // browser auto-decompresses, and what we write to the pod is the
      // uncompressed tar (10x bigger), which then fails the gunzip step.
      name: "preserve-gzip-tarballs",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url && req.url.endsWith(".tar.gz") || (req.url && req.url.includes(".tar.gz?"))) {
            res.setHeader("Content-Encoding", "identity");
            res.setHeader("Content-Type", "application/octet-stream");
          }
          next();
        });
      },
    },
  ],
});
