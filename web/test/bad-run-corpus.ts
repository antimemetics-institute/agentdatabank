import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const badRunNames = ["20260916t120000z-000000000001", "20260916t120000z-000000000002", "20260916t120000z-000000000003", "20260916t120000z-000000000004"];
export async function copyBadRunCorpus() {
  const root = await mkdtemp(join(tmpdir(), "adb-bad-runs-"));
  await cp("test/fixtures/bad-runs", root, { recursive: true });
  await rm(join(root, "runs/corpus-corpus/20260916t120000z-000000000005/.gitkeep"));
  return root;
}
