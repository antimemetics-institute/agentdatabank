import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const VIRTUAL = ["virtual:experiment-pages", "virtual:experiment-thumbnails"];
const THUMBNAILS = ["svg", "png", "jpg", "webp"].map(ext => `thumbnail.${ext}`);

// Nix stages only presentation sources here; the dev server reads the checkout.
export function experimentPages(): Plugin {
  const root = existsSync(resolve("experiment-content")) ? resolve("experiment-content") : resolve("../experiments");
  const found = (files: string[]) => readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .flatMap(entry => {
      const path = files.map(file => resolve(root, entry.name, file)).find(existsSync);
      return path ? [[entry.name, path] as const] : [];
    });
  return {
    name: "adb-experiment-pages",
    resolveId(id) { if (VIRTUAL.includes(id)) return "\0" + id; },
    load(id) {
      if (id === "\0virtual:experiment-pages")
        return `export default {${found(["README.mdx"]).map(([name, path]) => `${JSON.stringify(name)}: () => import(${JSON.stringify(path)})`).join(",")}}`;
      // Optional card image: thumbnail.<ext> beside package.nix (extensions Nix stages), bundled as a hashed asset.
      if (id === "\0virtual:experiment-thumbnails") {
        const entries = found(THUMBNAILS);
        return entries.map(([, path], i) => `import t${i} from ${JSON.stringify(path)};`).join("\n")
          + `\nexport default {${entries.map(([name], i) => `${JSON.stringify(name)}: t${i}`).join(",")}}`;
      }
    },
  };
}
