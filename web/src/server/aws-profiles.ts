import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Names only, from the user's existing config. No AWS file is ever created. */
export async function awsProfiles(path = join(homedir(), ".aws", "config")): Promise<string[]> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/)?.[1]?.trim();
    if (section === "default") names.add("default");
    else if (section?.startsWith("profile ")) {
      const name = section.slice(8).trim();
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}
