/* Unit tests for the hand-rolled markdown renderer — pure in/out, node's built-in
   runner, zero dependencies:  pnpm test  (= node --experimental-strip-types --test) */

import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, highlightJson, md } from "./markdown.ts";

test("esc escapes all five HTML-significant characters", () => {
  assert.equal(esc(`<a href="x" & 'y'>`), "&lt;a href=&quot;x&quot; &amp; &#39;y&#39;&gt;");
  assert.equal(esc(null), "");
});

test("headings map # levels to h3..h6, capped", () => {
  assert.ok(md("# top").includes("<h3>top</h3>"));
  assert.ok(md("## sub").includes("<h4>sub</h4>"));
  assert.ok(md("#### deep").includes("<h6>deep</h6>"));
});

test("single newlines soft-wrap: hard-wrapped prose joins with a space", () => {
  assert.equal(md("line one\nline two"), "<p>line one line two</p>");
});

test("list items continue across lines (indented and lazy), styles span the wrap", () => {
  // the werewolf.md regression: multi-line bullets must stay ONE item, not
  // item + orphan paragraphs
  const out = md("- Do agents see model identities? Default **no** (anonymized);\n"
    + "  could become a `bool` param later.\n"
    + "- Token/cost guardrail: `max_days` bounds it;\n"
    + "a circuit breaker can wait.");
  assert.equal((out.match(/<li>/g) ?? []).length, 2);
  assert.ok(!out.includes("<p>"), "continuation lines must not become paragraphs");
  assert.ok(out.includes("<b>no</b>") && out.includes("<code>bool</code>"));
  // bold spanning a source line break inside an item
  const spanned = md("- are **messages\n  with machine-readable `meta`** — the fold");
  assert.ok(spanned.includes("<b>messages with machine-readable <code>meta</code></b>"));
});

test("links: http(s) become safe anchors, relative links keep only their label", () => {
  const out = md("see [the spec](https://example.com/a?b=1) and [run-references.md](../run-references.md)");
  assert.ok(out.includes('<a href="https://example.com/a?b=1"'));
  assert.ok(out.includes('rel="noopener noreferrer"'));
  assert.ok(out.includes("run-references.md") && !out.includes("../run-references.md"));
});

test("newline runs scale: 2 = paragraph break, 3 = +1 gap, 4 = +2 gaps", () => {
  const gaps = (s: string) => (md(s).match(/md-gap/g) ?? []).length;
  assert.equal(md("a\n\nb"), "<p>a</p><p>b</p>"); // no spacer: p margins carry it
  assert.equal(gaps("a\n\nb"), 0);
  assert.equal(gaps("a\n\n\nb"), 1);
  assert.equal(gaps("a\n\n\n\nb"), 2);
});

test("bullet lists open/close around items, both markers", () => {
  assert.equal(md("- one\n* two"), "<ul><li>one</li><li>two</li></ul>");
  // lazy continuation: an unmarked line right after an item continues it;
  // a blank line is what ends the list
  assert.equal(md("- item\nplain"), "<ul><li>item plain</li></ul>");
  assert.equal(md("- item\n\nplain"), "<ul><li>item</li></ul><p>plain</p>");
});

test("inline: code, bold, italic, and their precedence", () => {
  assert.ok(md("has `code` here").includes("<code>code</code>"));
  assert.ok(md("**bold** and *ital*").includes("<b>bold</b>"));
  assert.ok(md("**bold** and *ital*").includes("<i>ital</i>"));
  // spaced asterisks in prose are not italics
  assert.ok(!md("2 * 3 * 4").includes("<i>"));
});

test("fences: escaped verbatim; json fences highlighted; markdown inert inside", () => {
  const plain = md("```\n**not bold** <tag>\n```");
  assert.ok(plain.includes("**not bold** &lt;tag&gt;"));
  assert.ok(!plain.includes("<b>"));
  const json = md('```json\n{"k": 1}\n```');
  assert.ok(json.includes('<span class="tok-key">&quot;k&quot;</span>'));
});

test("pipe tables render with header, body, and inline styles in cells", () => {
  const out = md("| a | b |\n|---|---|\n| *x* | **y** |\n| z | `w` |");
  assert.ok(out.includes('<table class="md-table">'));
  assert.ok(out.includes("<th>a</th>") && out.includes("<th>b</th>"));
  assert.ok(out.includes("<td><i>x</i></td>") && out.includes("<td><b>y</b></td>"));
  assert.ok(out.includes("<td><code>w</code></td>"));
});

test("pipe rows without a separator line are NOT tables", () => {
  const out = md("| just | pipes |\nplain text");
  assert.ok(!out.includes("<table"));
  assert.ok(out.includes("| just | pipes |"));
});

test("highlightJson tokenizes keys, strings, numbers, bools, punctuation — escaped", () => {
  const out = highlightJson('{"k": "v<i>", "n": -1.5e3, "b": true, "z": null}');
  assert.ok(out.includes('<span class="tok-key">&quot;k&quot;</span>'));
  assert.ok(out.includes('<span class="tok-str">&quot;v&lt;i&gt;&quot;</span>'));
  assert.ok(out.includes('<span class="tok-num">-1.5e3</span>'));
  assert.ok(out.includes('<span class="tok-bool">true</span>'));
  assert.ok(out.includes('<span class="tok-bool">null</span>'));
  assert.ok(out.includes('<span class="tok-punc">{</span>'));
});

test("XSS: script tags are inert in every position", () => {
  for (const src of ["<script>alert(1)</script>",
                     "| <script>x</script> |\n|---|\n| <img onerror=x> |",
                     "# <script>h</script>",
                     "```\n<script>c</script>\n```"]) {
    const out = md(src);
    assert.ok(!out.includes("<script"), `unescaped script in: ${src}`);
    assert.ok(!out.includes("<img"), `unescaped img in: ${src}`);
  }
});
