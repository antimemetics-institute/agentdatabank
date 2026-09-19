import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { zstdCompressSync } from "node:zlib";
import { envelope, fixtureCard } from "./event-fixtures.ts";

export async function staticServer(files = new Map<string, string | Buffer>(), host = "127.0.0.1") {
  const redirects = new Map<string, string>();
  const requests: { path: string; url: string; headers: IncomingHttpHeaders; status: number }[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    const body = files.get(path);
    const location = redirects.get(path);
    const etag = body === undefined ? null : '"' + createHash("sha256").update(body).digest("hex") + '"';
    const status = req.method === "OPTIONS" ? 204 : location ? 302 : body === undefined ? 404 : req.headers["if-none-match"] === etag ? 304 : 200;
    requests.push({ path, url: req.url!, headers: req.headers, status });
    res.writeHead(status, { "access-control-allow-origin": "*", "access-control-allow-headers": "if-none-match",
      "access-control-expose-headers": "etag", ...(etag ? { etag } : {}), ...(location ? { location } : {}),
      "content-type": path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".html") || path.endsWith("/") ? "text/html" : "application/octet-stream" });
    res.end(status === 200 ? body : undefined);
  }).listen(0, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No static server address");
  return { files, redirects, requests, origin: `http://${host}:${address.port}`,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

export async function publishedFixture(redirectObjects = false, appPath = "/app/") {
  const store = await staticServer();
  const site = await staticServer();
  const cdn = await staticServer(new Map(), "127.0.0.2");
  const long = "large café parameter ".repeat(200);
  const events = [
    envelope({ type: "run.start", condition: "condition", params: { long }, seed: 7, result_definitions: [] }),
    envelope({ type: "custom", kind: "note", data: { text: "é", n: 1 } }, 1),
    envelope({ type: "run.end", state: "completed", exit_code: 0, duration_s: 1 }, 2),
  ];
  const lines = events.map((event) => JSON.stringify(event) + "\n");
  lines[1] = " \t" + lines[1]!.trimEnd().replace('"n":1', '"n":1e0').replace('"text":"é"', '"text":"é\\u0041"') + " \r\n";
  const card = fixtureCard(events);
  const stem = `/bucket/runs/condition-example/${card.identity.run}`;
  const raw = JSON.stringify(card, null, 2) + "\n";
  store.files.set(stem + "/run.json", raw);
  store.files.set(stem + "/events.jsonl.zst", zstdCompressSync(Buffer.from(lines.join(""))));
  if (redirectObjects) for (const name of ["run.json", "events.jsonl.zst"]) {
    cdn.files.set(`/objects/${name}`, store.files.get(`${stem}/${name}`)!);
    store.files.delete(`${stem}/${name}`);
    store.redirects.set(`${stem}/${name}`, `${cdn.origin}/objects/${name}?X-Amz-Signature=fixture-signature`);
  }
  const row = { store: store.origin + "/bucket", card };
  const indexPath = appPath + "index/";
  site.files.set(indexPath + "index.json", JSON.stringify({ v: 0, experiments: [{ name: "example", runs: 1 }], runs: 1, built_at: "2026-09-18T12:00:00.000000Z" }));
  site.files.set(indexPath + "experiments/example/index.jsonl", JSON.stringify(row) + "\n");
  site.files.set(appPath + "catalog.json", JSON.stringify({ v: 0, manifests: [{ name: "example", params: {} }], shared: { title: "shared" }, hints: { example: { 0: { title: "specific" } } } }));
  return { store, site, cdn, app: site.origin + appPath, appPath, indexPath, row, card, raw, stem, long, lines,
    close: async () => { await store.close(); await site.close(); await cdn.close(); } };
}
