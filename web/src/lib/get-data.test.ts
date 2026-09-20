import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import type { DataSource } from "./data-source.ts";
import { publishedFixture } from "../../test/published-fixture.ts";

let vite: ViteDevServer;
let GetData: ComponentType<{ name: string; runCount: number }>;
let setDataSource: (source: DataSource) => void;
const noRequest = async (): Promise<never> => { throw new Error("The panel must not fetch data"); };
function source(mode: DataSource["mode"], base: string): DataSource {
  return { mode, pollMs: 0, asset: (path) => base + path, json: noRequest, text: noRequest, post: noRequest };
}
function snippets(html: string): string[] {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'" };
  return [...html.matchAll(/<pre[^>]*><code>([\s\S]*?)<\/code><\/pre>/g)]
    .map((match) => match[1]!.replace(/&(amp|lt|gt|quot|#x27);/g, (_, key: string) => entities[key]!));
}

before(async () => {
  vite = await createServer({ logLevel: "silent", server: { middlewareMode: true, hmr: false, watch: null } });
  ({ GetData } = await vite.ssrLoadModule("/src/components/get-data.tsx"));
  ({ setDataSource } = await vite.ssrLoadModule("/src/lib/data-source.ts"));
});
after(async () => { await vite?.close(); });

test("published download panel uses each experiment's own index URL and loaded counts", async () => {
  const fixture = await publishedFixture();
  try {
    setDataSource(source("published", fixture.app));
    for (const name of ["govsim", "another-experiment"]) {
      const html = renderToStaticMarkup(createElement(GetData, { name, runCount: 245 }));
      assert.match(html, /245 runs · 490 files/);
      assert.match(html, /Copy Download everything/);
      assert.match(html, /Copy Then query it locally/);
      const [command, query] = snippets(html);
      const expected = fixture.app + `index/experiments/${name}/index.jsonl`;
      assert.ok(command!.startsWith(`curl -sL '${expected}'`));
      // Only the supplied URL may contribute a hostname; stores come from each row.
      assert.deepEqual(command!.match(/https?:\/\/[^\s']+/g), [expected]);
      assert.ok(command!.includes('"runs/\\(.card.identity.condition)-\\(.card.identity.experiment)/\\(.card.identity.run)"'));
      assert.ok(command!.includes("IFS=$'\\t'"));
      assert.ok(command!.includes('"$store/$run_path/run.json"'));
      assert.ok(command!.includes('"$store/$run_path/events.jsonl.zst"'));
      assert.ok(query!.includes("unnest(inputs.params), unnest(derived.results)"));
      assert.ok(query!.includes("read_json_auto('runs/**/run.json')"));
      assert.ok(query!.includes("read_json_objects('runs/**/events.jsonl.zst')"));
      assert.ok(query!.includes("json_extract_string(json,'$.event.type')"));
    }
  } finally { await fixture.close(); }
});

test("no literal hostname is added when the data source supplies a relative index URL", () => {
  setDataSource(source("published", "/mounted-site/"));
  const [command] = snippets(renderToStaticMarkup(createElement(GetData, { name: "example", runCount: 0 })));
  assert.ok(command!.startsWith("curl -sL '/mounted-site/index/experiments/example/index.jsonl'"));
  assert.doesNotMatch(command!, /https?:\/\//);
});

test("local mode renders nothing and never resolves a public URL", () => {
  setDataSource({ ...source("local", ""), asset: () => { throw new Error("No public URL in local mode"); } });
  assert.equal(renderToStaticMarkup(createElement(GetData, { name: "govsim", runCount: 245 })), "");
});
