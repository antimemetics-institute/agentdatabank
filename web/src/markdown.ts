/* Minimal safe markdown → HTML string, plus a ~40-line JSON syntax highlighter.
   Escape FIRST, then transform: fenced code (json fences get highlighted), inline
   code, **bold**, ## headings, - lists. Rendered via dangerouslySetInnerHTML — safe
   because every character of source text passes through esc() before any tag is
   introduced by us (the highlighter escapes each token the same way). */

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/* hand-rolled JSON tokenizer → HTML string with tok-* spans (colors in index.css).
   Escapes every emitted character; no dependency. */
export function highlightJson(src: string): string {
  const re =
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}\[\],:])/g;
  const out: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out.push(esc(src.slice(last, m.index)));
    if (m[1] !== undefined)
      out.push(`<span class="${m[2] ? "tok-key" : "tok-str"}">${esc(m[1])}</span>${esc(m[2] ?? "")}`);
    else if (m[3] !== undefined) out.push(`<span class="tok-bool">${m[3]}</span>`);
    else if (m[4] !== undefined) out.push(`<span class="tok-num">${m[4]}</span>`);
    else out.push(`<span class="tok-punc">${esc(m[5]!)}</span>`);
    last = re.lastIndex;
  }
  out.push(esc(src.slice(last)));
  return out.join("");
}

export function md(src: unknown): string {
  const s = String(src ?? "");
  const fence = /```(\w*)\n?([\s\S]*?)```/g;
  const out: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(s))) {
    out.push(mdBlocks(s.slice(last, m.index)));
    const code = m[1]!.toLowerCase() === "json" ? highlightJson(m[2]!) : esc(m[2]);
    out.push(`<pre class="code"><code>${code}</code></pre>`);
    last = m.index + m[0].length;
  }
  out.push(mdBlocks(s.slice(last)));
  return out.join("");
}

function mdBlocks(s: string): string {
  const out: string[] = [];
  let inList = false;
  let para: string[] = [];
  let blanks = 0;
  const flush = () => {
    if (para.length) { out.push(`<p>${para.map(mdInline).join("<br>")}</p>`); para = []; }
  };
  for (const line of esc(s).split("\n")) {
    const h = line.match(/^(#{1,4}) (.*)/);
    const li = line.match(/^\s*[-*] (.*)/);
    if (!line.trim()) {
      flush();
      if (inList) { out.push("</ul>"); inList = false; }
      // one blank line = paragraph break (p margins); each EXTRA blank line adds
      // visible space, so multiple newlines render spaced apart as authored
      if (++blanks > 1) out.push('<div class="md-gap"></div>');
      continue;
    }
    blanks = 0;
    if (inList && !li) { out.push("</ul>"); inList = false; }
    if (h) { flush(); const n = Math.min(h[1]!.length + 2, 6); out.push(`<h${n}>${mdInline(h[2]!)}</h${n}>`); }
    else if (li) { flush(); if (!inList) { out.push("<ul>"); inList = true; } out.push(`<li>${mdInline(li[1]!)}</li>`); }
    else para.push(line);
  }
  flush();
  if (inList) out.push("</ul>");
  return out.join("");
}

const mdInline = (s: string): string => s
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
  .replace(/\*(\S(?:[^*]*\S)?)\*/g, "<i>$1</i>");
