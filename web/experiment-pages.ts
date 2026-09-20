import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

// Nix stages only presentation sources here; the dev server reads the checkout.
export function experimentPages(): Plugin {
  const root = existsSync(resolve("experiment-content")) ? resolve("experiment-content") : resolve("../experiments");
  return {
    name: "adb-experiment-pages",
    resolveId(id) { if (id === "virtual:experiment-pages") return "\0" + id; },
    load(id) {
      if (id !== "\0virtual:experiment-pages") return;
      const entries = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
        .map(entry => [entry.name, resolve(root, entry.name, "README.mdx")])
        .filter(([, path]) => existsSync(path!));
      return `export default {${entries.map(([name, path]) => `${JSON.stringify(name)}: () => import(${JSON.stringify(path)})`).join(",")}}`;
    },
  };
}
