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
  const lines = esc(s).split("\n");
  const out: string[] = [];
  let para: string[] = [];   // open paragraph: source lines, soft-wrapped (joined by space)
  let items: string[][] = []; // open list: one buffer of source lines per item
  let blanks = 0;
  const flushPara = () => {
    if (para.length) { out.push(`<p>${mdInline(para.join(" "))}</p>`); para = []; }
  };
  const flushList = () => {
    if (items.length) {
      out.push("<ul>" + items.map((it) => `<li>${mdInline(it.join(" "))}</li>`).join("") + "</ul>");
      items = [];
    }
  };
  const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l: string) => /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(l);
  const cells = (l: string) =>
    l.trim().replace(/^\||\|$/g, "").split("|").map((c) => mdInline(c.trim()));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // pipe table: a |…| row whose next line is the |---|---| separator
    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1]!)) {
      flushPara(); flushList();
      blanks = 0;
      out.push('<table class="md-table"><thead><tr>'
        + cells(line).map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>");
      i += 1; // the separator row renders nothing
      while (i + 1 < lines.length && isRow(lines[i + 1]!) && !isSep(lines[i + 1]!)) {
        i += 1;
        out.push("<tr>" + cells(lines[i]!).map((c) => `<td>${c}</td>`).join("") + "</tr>");
      }
      out.push("</tbody></table>");
      continue;
    }
    const h = line.match(/^(#{1,4}) (.*)/);
    const li = line.match(/^\s*[-*] (.*)/);
    if (!line.trim()) {
      flushPara(); flushList();
      // one blank line = paragraph break (p margins); each EXTRA blank line adds
      // visible space, so multiple newlines render spaced apart as authored
      if (++blanks > 1) out.push('<div class="md-gap"></div>');
      continue;
    }
    blanks = 0;
    if (h) { flushPara(); flushList(); const n = Math.min(h[1]!.length + 2, 6); out.push(`<h${n}>${mdInline(h[2]!)}</h${n}>`); }
    else if (li) { flushPara(); items.push([li[1]!]); }
    else if (items.length) items[items.length - 1]!.push(line.trim()); // continuation
    // (indented or lazy) joins the open item — inline styles may span source lines
    else para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join("");
}

const mdInline = (s: string): string => s
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  .replace(/\[([^\]]+)\]\([^)\s]*\)/g, "$1") // relative links: keep the label, drop the dead url
  .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
  .replace(/\*(\S(?:[^*]*\S)?)\*/g, "<i>$1</i>");
