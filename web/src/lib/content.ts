/* Value → display string for event fields. THE chokepoint against coercion leaks:
   model message content is either a plain string or a LIST OF TYPED BLOCKS
   ({type:"text",text}, {type:"reasoning",reasoning}, …) — inspect emits the latter
   for reasoning models — and a bare String() on such an array renders
   "[object Object],[object Object]". So: extract text deliberately, and NEVER fall
   back to String() for objects (JSON.stringify is the honest last resort).
   content.test.ts holds the no-[object Object] invariant; the docs-clip recorder
   asserts it against the live UI on real run data. */

export const isElided = (v: unknown): v is { __elided: { bytes: number; preview?: string } } =>
  !!v && typeof v === "object" && "__elided" in (v as object);

/* a string-or-elided field → its readable form (elided → preview), else null */
const readable = (v: unknown): string | null =>
  typeof v === "string" ? v : isElided(v) ? `${v.__elided.preview ?? ""}…` : null;

/* one content block → its text (or reasoning, kept separate so text blocks win).
   The wire elides long strings ANYWHERE, including inside a block ({type:"text",
   text:{__elided}}), so an elided text/reasoning surfaces its preview instead of
   degrading to the opaque "[text]" type label.

   Reasoning blocks follow inspect_ai's ContentReasoning contract (its .text
   property in _util/content.py is the canonical rendering rule): `redacted` is
   the discriminator — when true, `reasoning` is an OPAQUE replay payload
   (Anthropic signature, Google thought_signature, OpenAI encrypted blob) and
   `summary` holds the only readable text (absent on fully-redacted blocks).
   The redacted check runs BEFORE the elision fallback: the preview of an
   opaque blob is still opaque. */
const blockText = (
  b: unknown,
): { text?: string; reasoning?: string; summarized?: boolean; redactedStub?: boolean } => {
  if (typeof b === "string") return { text: b };
  if (b && typeof b === "object") {
    const o = b as Record<string, unknown>;
    const text = readable(o.text);
    if (text !== null) return { text };
    if (o.type === "reasoning" || o.reasoning !== undefined) {
      if (o.redacted === true) {
        const summary = readable(o.summary);
        return summary !== null && summary.trim()
          ? { reasoning: summary, summarized: true }
          : { redactedStub: true };
      }
      const r = readable(o.reasoning);
      if (r !== null) return { reasoning: r };
    }
    if (typeof o.type === "string") return { text: `[${o.type}]` };
  }
  return { text: JSON.stringify(b) };
};

/* an elision marker anywhere inside v (top level or nested in a content block) —
   drives the "load full event" affordance where isElided's top-level check misses */
export const containsElision = (v: unknown): boolean =>
  v !== undefined && (JSON.stringify(v) ?? "").includes('"__elided"');

export const elStr = (v: unknown): string => {
  if (isElided(v)) return String(v.__elided.preview ?? "");
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const parts = v.map(blockText);
    const texts = parts.map((p) => p.text).filter((t): t is string => !!t?.trim());
    if (texts.length) return texts.join("\n");
    return parts.map((p) => p.reasoning).filter(Boolean).join("\n");
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

/* assistant message → its two lanes. Reasoning arrives in EITHER of two shapes:
   the OpenAI-compatible `reasoning_content` field (llama.cpp/vLLM/DeepSeek-style
   dumps) or {type:"reasoning"} blocks inside a content list (inspect's shape —
   kimi, qwen, o-series, anthropic). llm.call rendering needs them SEPARATE —
   thinking styled as thinking, before the reply — so this splits instead of
   funnelling through elStr, whose text-wins policy drops in-block reasoning when
   a text block coexists. Two buckets, reasoning first: interleaving order inside
   the block list is not preserved (providers emit reasoning-first).

   Beyond the two lanes, the result reports the reasoning's provenance (from the
   ContentReasoning contract, never guessed): `summarized` — the readable text is
   a provider-written summary, not the raw chain of thought; `redacted` — count
   of reasoning blocks with NO readable text at all (opaque payload only), so the
   UI can say "redacted" instead of showing nothing. */
export const splitContent = (
  msg: unknown,
): { text: string; reasoning: string; summarized: boolean; redacted: number } => {
  if (!msg || typeof msg !== "object")
    return { text: "", reasoning: "", summarized: false, redacted: 0 };
  const m = msg as Record<string, unknown>;
  const reasoning: string[] = [];
  let summarized = false;
  let redacted = 0;
  const rc = readable(m.reasoning_content);
  if (rc !== null && rc.trim()) reasoning.push(rc);
  let text = "";
  const c = m.content;
  if (Array.isArray(c)) {
    const parts = c.map(blockText);
    text = parts.map((p) => p.text).filter((t): t is string => !!t?.trim()).join("\n");
    for (const p of parts) {
      if (p.reasoning?.trim()) {
        reasoning.push(p.reasoning);
        if (p.summarized) summarized = true;
      }
      if (p.redactedStub) redacted += 1;
    }
  } else {
    text = elStr(c);
  }
  return { text, reasoning: reasoning.join("\n\n"), summarized, redacted };
};
