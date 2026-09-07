import { readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

export async function readReadmeAsset(catalog: string | null, encodedParts: string[]) {
  if (!catalog || encodedParts.length < 2) return null;
  let parts: string[];
  try { parts = encodedParts.map(decodeURIComponent); } catch { return null; }
  if (parts.some((p) => !p || p === "." || p === ".." || /[\\/\x00]/.test(p))) return null;
  const type = TYPES[extname(parts.at(-1)!)];
  if (!type) return null;
  try {
    // Nix's catalog contains directory symlinks; resolve the experiment root first.
    const root = await realpath(resolve(catalog, "assets", parts[0]!));
    const path = await realpath(resolve(root, ...parts.slice(1)));
    if (!path.startsWith(root + sep)) return null;
    return { type, body: await readFile(path) };
  } catch { return null; }
}
