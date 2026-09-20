import { dataSource, publishedMode } from "@/lib/data-source";
import { shQuote } from "@/lib/cmd-build";
import { CopyBlock } from "@/components/copy-block";

/** Published downloads come entirely from the index already used by the page. */
export function GetData({ name, runCount }: { name: string; runCount: number }) {
  if (!publishedMode()) return null;
  const index = dataSource().asset(`index/experiments/${encodeURIComponent(name)}/index.jsonl`);
  const download = String.raw`curl -sL ${shQuote(index)} \
| jq -r '[.store, "runs/\(.card.identity.condition)-\(.card.identity.experiment)/\(.card.identity.run)"] | @tsv' \
| while IFS=$'\t' read -r store run_path; do
    mkdir -p "$run_path"
    curl -sL "$store/$run_path/run.json" -o "$run_path/run.json"
    curl -sL "$store/$run_path/events.jsonl.zst" -o "$run_path/events.jsonl.zst"
  done`;
  const query = `-- one row per run: every parameter and every result
SELECT unnest(inputs.params), unnest(derived.results) FROM read_json_auto('runs/**/run.json');

-- events; use read_json_objects, not read_json_auto
SELECT json_extract_string(json,'$.event.type') AS type, count(*) AS n
FROM read_json_objects('runs/**/events.jsonl.zst') GROUP BY 1 ORDER BY 2 DESC;`;

  return <section aria-label="Get the data" className="min-w-0 space-y-3 rounded-md border p-4 [overflow-wrap:anywhere]">
    <div className="flex flex-wrap items-baseline gap-3">
      <h3 className="text-sm font-medium">Get the data</h3>
      <span className="text-xs text-muted-foreground">{runCount} {runCount === 1 ? "run" : "runs"} · {runCount * 2} files</span>
    </div>
    <p className="text-sm text-muted-foreground">
      The download lands in <code>runs/&lt;condition&gt;-&lt;experiment&gt;/&lt;run&gt;/</code>, mirroring the bucket.
      Each run has a <code>run.json</code> card and a zstd-compressed JSON Lines event stream.
      <code> event.type</code> is the discriminator.
    </p>
    <p className="text-sm text-muted-foreground">The download requires curl and jq; DuckDB is only needed for the queries in the second block.</p>
    <CopyBlock label="Download everything" text={download} />
    <p className="text-sm text-muted-foreground">
      Using <code>read_json_auto</code> on events infers a 90 KB union struct and breaks on unusual payloads,
      so the events query uses <code>read_json_objects</code>.
    </p>
    <CopyBlock label="Then query it locally" text={query} />
  </section>;
}
