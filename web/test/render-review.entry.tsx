/* Static review artifacts made with the real run tabs and current build schemas. */
import { constants, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { cardMeta } from "../src/lib/run-readability";
import { fixtureMeta } from "./event-fixtures";
import { RunView } from "../src/pages/run";
import { compileSchemas } from "../src/lib/render-hints";
import { parseEventLine } from "../src/lib/envelope";
import { readRunSchemas } from "../src/server/event-schemas";
import { reviewOutputDirectory } from "../src/server/review-output";

async function main() {
  const run = process.argv[2]!;
  const output = reviewOutputDirectory(run, process.argv[3]!);
  const catalog = process.argv[4]!;
  const disk = ["events.jsonl"]
    .flatMap((f) => (readFileSync(join(run, f), "utf8").match(/[^\n]*\n|[^\n]+$/g) ?? [])
      .map((line) => ({ record: parseEventLine(line), line })));
  const records = disk.map(({ record }) => record);
  const diskRecords = new Map(disk.map((entry) => [entry.record.seq, entry]));
  const manifests = readdirSync(catalog).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(catalog, f), "utf8")));
  const schemas = await readRunSchemas(manifests, records[0].experiment, records[0].schema);
  const events = records;
  const meta = cardMeta(JSON.parse(readFileSync(join(run, "run.json"), "utf8")));
  const manifest = manifests.find((m) => m.name === records[0].experiment);
  // A prefix of the same captured run demonstrates pending results and progress.
  const firstState = events.findIndex((e) => e.event.kind === "govsim.state");
  const partial = events.slice(0, firstState >= 0 ? firstState + 2 : Math.max(1, Math.floor(events.length / 2)))
    .filter((e) => e.event.type !== "run.end");
  const css = readdirSync("dist/assets").filter((f) => f.endsWith(".css"))
    .map((f) => readFileSync(join("dist/assets", f), "utf8")).join("\n");
  mkdirSync(output, { recursive: true });
  for (const [prefix, snapshot] of [["", events], ["partial-", partial]] as const) {
    const now = Date.parse(snapshot.at(-1)!.ts) + 1500;
    const snapshotMeta = prefix ? { ...fixtureMeta(snapshot), heartbeat_at: snapshot.at(-1)!.ts } : meta;
    const views = [
      { name: "summary", query: "tab=summary" },
      { name: "stream", query: "tab=stream" },
      ...(!prefix ? [
        { name: "govsim-stream", query: "tab=stream&filter=namespace%3Agovsim" },
      ] : []),
    ];
    for (const view of views) {
      const markup = renderToStaticMarkup(<RunView review events={snapshot} diskRecords={diskRecords}
        definitions={compileSchemas(schemas)} meta={snapshotMeta} manifest={manifest} now={now}
        query={view.query} cid={meta.condition} rid={records[0].run} />);
      const path = join(output, `${prefix}${view.name}.html`);
      writeFileSync(path, `<!doctype html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1"><title>GovSim ${prefix}${view.name} review</title>
      <style>${css}</style></head><body><main style="height:100vh;padding:1rem;max-width:72rem;margin:auto">${markup}</main></body></html>`,
      { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW });
      console.log(`Rendered ${snapshot.length} records: ${path}`);
    }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
