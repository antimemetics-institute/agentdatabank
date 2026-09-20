import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import mdx from "@mdx-js/rollup";
import remarkGfm from "remark-gfm";
import { experimentPages } from "./experiment-pages";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  /* relative asset URLs, so the built app also works served under a path prefix
     (code-server's /proxy/<port>/ — absolute /assets/... would resolve against the
     proxy's origin root and 404). Safe because routing is hash-based: the document
     path never changes. The api() helper in lib/data.ts is prefix-relative to match. */
  base: "./",
  plugins: [experimentPages(), mdx({ remarkPlugins: [remarkGfm] }), react(), tailwindcss()],
  resolve: { dedupe: ["react", "react-dom"], alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // dev.mjs supplies the API proxy after the local server binds a free port.
});
