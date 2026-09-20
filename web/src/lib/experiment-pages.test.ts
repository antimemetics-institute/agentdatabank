import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { createServer } from "vite";

test("narratives are discovered from README.mdx and absent for experiments without one", async () => {
  const vite = await createServer({ logLevel: "silent", server: { middlewareMode: true, hmr: false, watch: null } });
  try {
    const { hasNarrative } = await vite.ssrLoadModule("/src/components/experiment-narrative.tsx") as {
      hasNarrative(name: string): boolean;
    };
    assert.ok(existsSync("../experiments/govsim/README.mdx"));
    assert.ok(!existsSync("../experiments/govsim/README.md"));
    assert.equal(hasNarrative("govsim"), true);
    assert.ok(existsSync("../experiments/concordia/package.nix"));
    assert.ok(!existsSync("../experiments/concordia/README.mdx"));
    assert.equal(hasNarrative("concordia"), false);
    assert.equal(hasNarrative("not-an-experiment"), false);
  } finally { await vite.close(); }
});
