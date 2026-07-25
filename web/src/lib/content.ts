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

/* one content block → its text (or reasoning, kept separate so text blocks win).
   The wire elides long strings ANYWHERE, including inside a block ({type:"text",
   text:{__elided}}), so an elided text/reasoning surfaces its preview instead of
   degrading to the opaque "[text]" type label. */
const blockText = (b: unknown): { text?: string; reasoning?: string } => {
  if (typeof b === "string") return { text: b };
  if (b && typeof b === "object") {
    const o = b as Record<string, unknown>;
    if (typeof o.text === "string") return { text: o.text };
    if (isElided(o.text)) return { text: `${o.text.__elided.preview ?? ""}…` };
    if (typeof o.reasoning === "string") return { reasoning: o.reasoning };
    if (isElided(o.reasoning)) return { reasoning: `${o.reasoning.__elided.preview ?? ""}…` };
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
