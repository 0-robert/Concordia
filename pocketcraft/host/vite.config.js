import { defineConfig } from "vite";

// COOP/COEP for SharedArrayBuffer (required for BrowserPod once we go in-pod).
// Done via plugin middleware so dev server always sends headers regardless
// of vite version quirks.
export default defineConfig({
  server: {
    port: 5174,
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  plugins: [
    {
      name: "coop-coep",
      configureServer(server) {
        server.middlewares.use((_req, res, next) => {
          res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
          next();
        });
      },
    },
  ],
});
