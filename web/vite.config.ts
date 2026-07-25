import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  /* relative asset URLs, so the built app also works served under a path prefix
     (code-server's /proxy/<port>/ — absolute /assets/... would resolve against the
     proxy's origin root and 404). Safe because routing is hash-based: the document
     path never changes. The api() helper in lib/data.ts is prefix-relative to match. */
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // dev.sh runs the real API server on 8340; the vite dev server proxies to it
  server: { proxy: { "/api": "http://127.0.0.1:8340" } },
});
