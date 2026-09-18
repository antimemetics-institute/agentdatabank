import { open, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { FullEvent, RunCard, RunMeta } from "../shared/types.ts";
import { cardMeta, cardReason, metadataReason, object, oneLineReason } from "../lib/run-readability.ts";
import { conditionName } from "../lib/identity.ts";
import { readEventRecords } from "./events.ts";

export interface RunSnapshot { meta: RunMeta; records?: FullEvent[] }

/** One read policy for listings and endpoints. The card owns summaries; no server summary cache. */
export class RunReader {
  private readonly locations = new Map<string, string>();
  private readonly skipped = new Set<string>();
  readonly root: string;
  private readonly log: (message: string) => void;
  constructor(root: string, log: (message: string) => void = console.warn) { this.root = root; this.log = log; }

  async directory(cid: string, rid: string): Promise<string | null> {
    const key = `${cid}/${rid}`;
    if (!this.locations.has(key)) await this.list();
    return this.locations.get(key) ?? null;
  }

  async raw(cid: string, rid: string): Promise<string> {
    const dir = await this.directory(cid, rid);
    if (!dir) throw new Error("no such run");
    return readFile(join(dir, "run.json"), "utf8");
  }

  async read(cid: string, rid: string, withRecords = false): Promise<RunSnapshot | null> {
    const dir = await this.directory(cid, rid);
    return dir ? this.readDirectory(dir, withRecords) : null;
  }

  private async readDirectory(dir: string, withRecords = false): Promise<RunSnapshot | null> {
    let value: unknown;
    let heartbeatAt: string;
    try {
      // Read bytes and mtime from the same file, even across atomic replacements.
      const file = await open(join(dir, "run.json"));
      try {
        const [text, info] = await Promise.all([file.readFile("utf8"), file.stat()]);
        value = JSON.parse(text);
        heartbeatAt = info.mtime.toISOString();
      } finally { await file.close(); }
    }
    catch (error) {
      if (!this.skipped.has(dir)) {
        this.skipped.add(dir);
        this.log(`Skipping ${basename(dirname(dir))}/${basename(dir)}: no parseable run.json (${oneLineReason(error)})`);
      }
      return null;
    }
    const full = object(value) && object(value.identity) ? value.identity : {};
    const rid = basename(dir);
    // Read identity from the record. A damaged record uses the opaque directory
    // name for navigation only; the experiment suffix is never parsed.
    const cid = typeof full.condition === "string" && /^[A-Za-z0-9_-]+$/.test(full.condition)
      ? full.condition : basename(dirname(dir));
    this.locations.set(`${cid}/${rid}`, dir);
    let reason = cardReason(value);
    if (!reason) reason = metadataReason(cardMeta(value as RunCard), { condition: cid, run: rid });
    if (!reason) {
      try {
        const expected = join(this.root, "runs", conditionName(cid, full.experiment as string), rid);
        if (dir !== expected) reason = "run.json: condition and experiment do not match the storage path";
      } catch (error) { reason = oneLineReason(error); }
    }
    const meta: RunMeta = { run: rid, condition: cid,
      experiment: typeof full.experiment === "string" && full.experiment ? full.experiment : "unknown",
      readable: !reason };
    if (reason) { meta.reason = reason; return { meta }; }
    Object.assign(meta, cardMeta(value as RunCard), { heartbeat_at: heartbeatAt });
    let records: FullEvent[] | undefined;
    try {
      // Read for integrity diagnostics, never to calculate summary values.
      records = await readEventRecords(dir) ?? [];
      const events = records.map(({ record }) => record);
      if (events.some((record) => record.run !== rid || record.experiment !== full.experiment))
        throw new Error("event envelope identity does not match run.json");
      const start = events.find(({ event }) => event.type === "run.start")?.event;
      if (start && start.condition !== cid) throw new Error("run.start.condition does not match run.json");
    } catch (error) { meta.readable = false; meta.reason = oneLineReason(error); }

    return { meta, ...(withRecords && meta.readable ? { records: records ?? [] } : {}) };
  }

  async list(): Promise<RunMeta[]> {
    const runs: RunMeta[] = [];
    this.locations.clear();
    let conditions: string[];
    try { conditions = await readdir(join(this.root, "runs")); } catch { return runs; }
    for (const cid of conditions) {
      let entries;
      try { entries = await readdir(join(this.root, "runs", cid), { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const snapshot = await this.readDirectory(join(this.root, "runs", cid, entry.name));
        if (snapshot) runs.push(snapshot.meta);
      }
    }
    return runs.sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  }
}
