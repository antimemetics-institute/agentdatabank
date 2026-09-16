/* Review products are presentation files, kept outside recorded runs. */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

function physicalPath(path: string): string {
  if (lstatSync(path, { throwIfNoEntry: false })) return realpathSync(path);
  // Resolve the existing prefix before appending directories not created yet.
  return join(physicalPath(dirname(path)), basename(path));
}

export function reviewOutputDirectory(run: string, output: string): string {
  if (!output) throw new Error("A review output directory outside recorded runs is required");
  const source = realpathSync(run);
  const destination = physicalPath(resolve(output));
  for (let parent = destination; ; parent = dirname(parent)) {
    if (parent === source || existsSync(join(parent, "run.json")))
      throw new Error("Review output must be outside recorded runs");
    if (dirname(parent) === parent) break;
  }
  return destination;
}
