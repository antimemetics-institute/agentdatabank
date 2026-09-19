// Export the current build's manifests and versioned hints into the static bundle.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [directory, output] = process.argv.slice(2);
if (!output) throw new Error("usage: build-catalog.mjs MANIFESTS OUTPUT");
const catalog = { v: 0, manifests: [], shared: {}, hints: {} };
if (directory) for (const file of readdirSync(directory).filter((file) => file.endsWith(".json")).sort()) {
  const manifest = JSON.parse(readFileSync(join(directory, file), "utf8"));
  const path = manifest.schema?.path;
  if (path) {
    catalog.hints[manifest.name] = { [manifest.schema.version]: JSON.parse(readFileSync(path, "utf8")) };
    catalog.shared = JSON.parse(readFileSync(join(dirname(path), "shared-schema.json"), "utf8"));
    delete manifest.schema.path;
  }
  catalog.manifests.push(manifest);
}
mkdirSync(output, { recursive: true });
writeFileSync(join(output, "catalog.json"), JSON.stringify(catalog));
if (directory && existsSync(join(directory, "assets")))
  cpSync(join(directory, "assets"), join(output, "catalog", "assets"), { recursive: true, dereference: true });
