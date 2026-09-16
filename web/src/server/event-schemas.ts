import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Manifest } from "../shared/types.ts";
import type { JsonSchema } from "../lib/render-hints.ts";

async function readSchema(path: string): Promise<JsonSchema | null> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readRunSchemas(
  manifests: Manifest[], experiment?: string, version?: number,
): Promise<JsonSchema[]> {
  const manifest = manifests.find((m) => m.name === experiment && m.schema?.version === version);
  const path = manifest?.schema?.path;
  const sharedPath = path ?? manifests.find((m) => m.schema?.path)?.schema?.path;
  const [shared, specific] = await Promise.all([
    sharedPath ? readSchema(join(dirname(sharedPath), "shared-schema.json")) : null,
    path ? readSchema(path) : null,
  ]);
  return [shared, specific].filter((schema): schema is JsonSchema => schema !== null);
}
