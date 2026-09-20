import { decompress } from "fzstd";
import type { DataSource } from "./data-source.ts";
import { LocalSource } from "./data-source.ts";
import type { FullEvent, Manifest, RunCard, RunMeta } from "../shared/types.ts";
import type { JsonSchema } from "./render-hints.ts";
import { cardMeta, cardReason, object, oneLineReason } from "./run-readability.ts";
import { conditionName } from "./identity.ts";
import { parseEventLine } from "./envelope.ts";
import { parameterIdentity } from "./conditions.ts";

export function publicUrl(value: string): URL {
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      || url.username || url.password || url.search || url.hash)
    throw new Error("Expected a public HTTPS URL without credentials, query or fragment");
  return url;
}

// Public objects may redirect to signed CDN URLs. Every hop omits browser credentials.
export const publicFetch = (url: URL, headers?: HeadersInit): Promise<Response> =>
  fetch(url, { credentials: "omit", redirect: "follow", referrerPolicy: "no-referrer", cache: "no-cache", headers });

interface Catalog { v: 0; manifests: Manifest[]; shared: JsonSchema; hints: Record<string, Record<string, JsonSchema>> }
interface Location { store: string; path: string; identity: RunCard["identity"] }
interface CachedText { etag: string | null; text: string }
const decoder = (): TextDecoder => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Source rows are derived; run.json and event lines under runs/ are authoritative. */
export class PublishedSource implements DataSource {
  readonly mode = "published";
  readonly pollMs = 60_000;
  readonly indexBase: URL;
  private readonly siteBase: URL;
  private rows: RunMeta[] = [];
  private locations = new Map<string, Location>();
  private issues = new Map<string, string>();
  private objects = new Map<string, Promise<Uint8Array>>();
  private streams = new Map<string, Promise<FullEvent[]>>();
  private indexes = new Map<string, CachedText>();
  private refreshAt = 0;
  private refreshing?: Promise<RunMeta[]>;
  private indexedCatalog?: Promise<Catalog>;
  private readonly now: () => number;
  constructor(site: string, now: () => number = Date.now) {
    this.now = now;
    this.siteBase = new URL("./", site);
    this.indexBase = new URL("index/", this.siteBase);
  }
  asset(path: string): string { return new URL(path.replace(/^\//, ""), this.siteBase).href; }
  private async mutable(path: string): Promise<string> {
    const url = new URL(path, this.indexBase);
    const cached = this.indexes.get(url.href);
    const response = await publicFetch(url, cached?.etag ? { "if-none-match": cached.etag } : undefined);
    if (response.status === 304 && cached) return cached.text;
    if (!response.ok) { this.indexes.delete(url.href); throw new Error(`${path}: HTTP ${response.status}`); }
    const text = decoder().decode(await response.arrayBuffer());
    this.indexes.set(url.href, { etag: response.headers.get("etag"), text });
    return text;
  }
  private immutable(url: URL): Promise<Uint8Array> {
    let request = this.objects.get(url.href);
    if (!request) {
      request = publicFetch(publicUrl(url.href)).then(async (response) => {
        if (!response.ok) throw new Error(`${url.pathname}: HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      });
      this.objects.set(url.href, request);
    }
    return request;
  }
  private catalog(): Promise<Catalog> {
    return this.indexedCatalog ??= this.immutable(new URL("catalog.json", this.indexBase)).then((bytes) => {
      const value = JSON.parse(decoder().decode(bytes)) as Catalog;
      if (value.v !== 0 || !Array.isArray(value.manifests) || !object(value.shared) || !object(value.hints))
        throw new Error("Invalid index catalog");
      return value;
    });
  }
  private diagnostic(experiment: string, run: string, reason: string, condition = "unknown-condition"): RunMeta {
    return { experiment, condition, run, readable: false, reason };
  }
  async list(): Promise<RunMeta[]> {
    if (this.refreshing) return this.refreshing;
    if (this.now() < this.refreshAt) return this.withIssues();
    this.refreshAt = this.now() + this.pollMs;
    this.refreshing = this.refresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private withIssues(): RunMeta[] {
    return this.rows.map((row) => {
      const reason = this.issues.get(`${row.condition}/${row.run}`);
      return reason ? { ...row, readable: false, reason } : row;
    });
  }
  private async refresh(): Promise<RunMeta[]> {
    const rows: RunMeta[] = [];
    const locations = new Map<string, Location>();
    try {
      const root: unknown = JSON.parse(await this.mutable("index.json"));
      if (!object(root) || root.v !== 0 || !Array.isArray(root.experiments)) throw new Error("Invalid index.json");
      for (const entry of root.experiments) {
        if (!object(entry) || typeof entry.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.name)) {
          rows.push(this.diagnostic("unknown", `index-entry-${rows.length}`, "Invalid experiment in index.json")); continue;
        }
        const name = entry.name;
        const shard = `experiments/${name}/index.jsonl`;
        let text: string;
        try { text = await this.mutable(shard); }
        catch (error) { rows.push(this.diagnostic(name, `index-${name}`, oneLineReason(error))); continue; }
        for (const [lineNumber, line] of text.split("\n").entries()) {
          if (!line.trim()) continue;
          let card: unknown;
          try {
            const row: unknown = JSON.parse(line);
            if (!object(row) || typeof row.store !== "string") throw new Error("Row needs store and card");
            card = row.card;
            const reason = cardReason(card);
            if (reason) throw new Error(reason);
            const valid = card as RunCard;
            if (valid.identity.experiment !== name) throw new Error("Card identity disagrees with experiment shard");
            const store = publicUrl(row.store).href.replace(/\/$/, "") + "/";
            const path = `runs/${conditionName(valid.identity.condition, name)}/${valid.identity.run}/`;
            const key = `${valid.identity.condition}/${valid.identity.run}`;
            if (locations.has(key)) throw new Error("Duplicate run identity in index");
            locations.set(key, { store, path, identity: valid.identity });
            rows.push({ ...cardMeta(valid), params: await this.thinParams(valid), readable: true });
          } catch (error) {
            const identity = object(card) && object(card.identity) ? card.identity : {};
            rows.push(this.diagnostic(name,
              typeof identity.run === "string" ? identity.run : `index-${name}-line-${lineNumber + 1}`,
              `${shard}:${lineNumber + 1}: ${oneLineReason(error)}`,
              typeof identity.condition === "string" ? identity.condition : undefined));
          }
        }
      }
    } catch (error) { rows.push(this.diagnostic("unknown", "index-root", oneLineReason(error))); }
    this.rows = rows.sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
    this.locations = locations;
    return this.withIssues();
  }
  private async thinParams(card: RunCard): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(card.inputs.params)) {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      if (text.length <= 2048) { result[key] = value; continue; }
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parameterIdentity(value)));
      result[key] = { __param_ref: { size: text.length,
        preview: (text.split("\n").find((line) => line.trim() && !/^-{3,}$/.test(line.trim())) ?? "").trim().slice(0, 160),
        ref: `${encodeURIComponent(card.identity.condition)}/${encodeURIComponent(card.identity.run)}/params/${encodeURIComponent(key)}`,
        hash: [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("") } };
    }
    return result;
  }
  private async location(cid: string, rid: string): Promise<Location> {
    await this.list();
    const location = this.locations.get(`${cid}/${rid}`);
    if (!location) throw new Error("Run has no readable index location");
    return location;
  }
  private async raw(location: Location): Promise<string> {
    return decoder().decode(await this.immutable(new URL(location.path + "run.json", location.store)));
  }
  private async card(location: Location): Promise<RunCard> {
    const value: unknown = JSON.parse(await this.raw(location));
    const reason = cardReason(value);
    if (reason) throw new Error(reason);
    const card = value as RunCard;
    if (Object.entries(location.identity).some(([key, expected]) => card.identity[key as keyof RunCard["identity"]] !== expected))
      throw new Error("run.json identity disagrees with its object path");
    return card;
  }
  private records(location: Location): Promise<FullEvent[]> {
    const key = location.store + location.path;
    let request = this.streams.get(key);
    if (!request) {
      request = (async () => {
        await this.card(location);
        const compressed = await this.immutable(new URL(location.path + "events.jsonl.zst", location.store));
        const text = decoder().decode(decompress(compressed));
        return (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((line, index) => {
          const record = parseEventLine(line);
          if (record.seq !== index || record.run !== location.identity.run || record.experiment !== location.identity.experiment || record.schema !== location.identity.schema)
            throw new Error(`events.jsonl:${index + 1}: record identity or sequence disagrees with its object path`);
          return { record, line };
        });
      })();
      this.streams.set(key, request);
    }
    return request;
  }
  private async resource(path: string, raw: boolean): Promise<unknown> {
    const parsed = new URL(path, this.siteBase);
    const parts = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== "api" || parts[1] !== "runs" || parts.length < 5) throw new Error("404 resource unavailable in published mode");
    const [, , cid, rid, kind, key] = parts;
    const location = await this.location(cid!, rid!);
    try {
      if (kind === "run.json" && raw) return await this.raw(location);
      if (kind === "params") {
        const card = await this.card(location);
        if (!Object.hasOwn(card.inputs.params, key!)) throw new Error("Unknown parameter");
        return { value: card.inputs.params[key!] };
      }
      if (kind === "schemas") {
        const card = await this.card(location);
        const catalog = await this.catalog();
        const hint = catalog.hints[card.identity.experiment]?.[String(card.identity.schema)];
        return hint ? [catalog.shared, hint] : [catalog.shared];
      }
      const records = await this.records(location);
      if (kind === "events") return records.filter(({ record }) => record.seq > Number(parsed.searchParams.get("after") ?? -1)).map(({ record }) => record);
      if (kind === "event" && raw) {
        const record = records.find(({ record }) => record.seq === Number(key));
        if (!record) throw new Error("Unknown event");
        return record.line;
      }
      throw new Error("404 resource unavailable in published mode");
    } catch (error) { this.issues.set(`${cid}/${rid}`, oneLineReason(error)); throw error; }
  }
  async json(path: string): Promise<unknown> {
    if (path === "/api/runs") return this.list();
    if (path === "/api/experiments") return (await this.catalog()).manifests;
    return this.resource(path, false);
  }
  async text(path: string): Promise<string> { return await this.resource(path, true) as string; }
  async post(): Promise<never> { throw new Error("Execution is unavailable in published mode"); }
}

/** site.json is optional; mode is fixed before React mounts. */
export async function startupSource(site: string): Promise<DataSource> {
  const url = new URL("site.json", new URL("./", site));
  // Keep Vite's development SPA fallback from returning index.html for a missing config.
  const response = await publicFetch(url, { accept: "application/json" });
  if (response.status === 404) return new LocalSource();
  if (!response.ok) throw new Error(`site.json: HTTP ${response.status}`);
  const config: unknown = await response.json();
  if (!object(config) || config.v !== 0 || Object.keys(config).some((key) => key !== "v"))
    throw new Error('Invalid site.json: expected only {"v":0}');
  return new PublishedSource(site);
}
