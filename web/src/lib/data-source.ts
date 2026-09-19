/** Page transport. Published mode implements these resources in the browser. */
export interface DataSource {
  readonly mode: "local" | "published";
  readonly pollMs: number;
  json(path: string): Promise<unknown>;
  text(path: string): Promise<string>;
  post(path: string, body: unknown): Promise<unknown>;
  asset(path: string): string;
}

export class LocalSource implements DataSource {
  readonly mode = "local";
  readonly pollMs = 2000;
  asset(path: string): string {
    const base = window.location.pathname;
    return (base.endsWith("/") ? base : base + "/") + path.replace(/^\//, "");
  }
  private async response(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(this.asset(path), init);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `${response.status} ${path}`);
    }
    return response;
  }
  async json(path: string): Promise<unknown> { return (await this.response(path)).json(); }
  async text(path: string): Promise<string> { return (await this.response(path)).text(); }
  async post(path: string, body: unknown): Promise<unknown> {
    return (await this.response(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  }
}

let current: DataSource = new LocalSource();
export const dataSource = (): DataSource => current;
export const setDataSource = (source: DataSource): void => { current = source; };
export const publishedMode = (): boolean => current.mode === "published";
