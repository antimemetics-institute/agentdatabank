/* (spec, params) → Scene: expand forEach nodes, fill `{path}` templates, expand
   `id.*` flow endpoints. Pure data → data; nothing here touches the DOM, so the
   whole binding language is unit-testable under node --test. Labels stay RAW
   text here — escaping is the renderer's job at the XML boundary. */

import type {
  DiagramSpec,
  FlowSpec,
  NodeSpec,
  Params,
  Scene,
  SceneFlow,
  SceneNode,
} from "./spec.ts";

/* dotted-path lookup into params / a forEach element; missing → undefined */
const lookup = (root: unknown, path: string): unknown => {
  let v: unknown = root;
  for (const seg of path.split(".")) {
    if (v == null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[seg];
  }
  return v;
};

/* a hole's value as display text; objects/arrays are a spec bug we surface as
   empty rather than "[object Object]" (content.ts holds the same line) */
const holeText = (v: unknown): string =>
  v == null || typeof v === "object" ? "" : String(v);

/* fill `{path}` holes: element first (when in a forEach scope), then params.
   An EMPTY value doesn't resolve a hole — it falls through to the next scope,
   because empty-means-inherit is the params convention this vocabulary serves
   (concordia: roster `model: ""` = "use the run's model"; the picture should
   show what the agent actually gets). Unresolvable → "" so a template NEVER
   leaks braces into a picture. */
export const fill = (tpl: string, params: Params, element?: unknown): string =>
  tpl.replace(/\{([^{}]+)\}/g, (_, path: string) => {
    if (element !== undefined) {
      const fromElement = holeText(lookup(element, path));
      if (fromElement !== "") return fromElement;
    }
    return holeText(lookup(params, path));
  });

const bindNode = (spec: NodeSpec, id: string, params: Params, element?: unknown): SceneNode => {
  const opt = (tpl?: string) => {
    if (tpl === undefined) return undefined;
    const s = fill(tpl, params, element).trim();
    return s === "" ? undefined : s;
  };
  return {
    id,
    kind: spec.kind,
    label: fill(spec.label, params, element).trim(),
    detail: opt(spec.detail),
    badge: opt(spec.badge),
    variant: opt(spec.variant),
  };
};

const bindFlows = (
  specs: FlowSpec[],
  specIds: string[],
  nodes: SceneNode[],
  params: Params,
): SceneFlow[] => {
  const ids = nodes.map((n) => n.id);
  /* flows connect ROLES, never instances: a ref is a spec id (`gm`) or a
     forEach wildcard (`cast.*`). Instance refs like `cast.1` are unsayable by
     design — role-level flows are always drawable without crossing anything,
     which is what keeps the renderer free of edge routing forever. */
  const expand = (ref: string): string[] =>
    ref.endsWith(".*") && specIds.includes(ref.slice(0, -2))
      ? ids.filter((id) => id.startsWith(ref.slice(0, -1)))
      : specIds.includes(ref) && ids.includes(ref)
        ? [ref]
        : [];
  return specs.flatMap((f) => {
    const label = f.label ? fill(f.label, params).trim() || undefined : undefined;
    return expand(f.from).flatMap((from) =>
      expand(f.to).map((to) => ({ from, to, back: f.back, label })),
    );
  });
};

export const bindScene = (spec: DiagramSpec, params: Params): Scene => {
  const nodes = spec.nodes.flatMap((n) => {
    if (n.forEach === undefined) return [bindNode(n, n.id, params)];
    const list = lookup(params, n.forEach);
    if (!Array.isArray(list)) return []; // absent/mistyped list ⇒ no instances, not a crash
    return list.map((element, i) => bindNode(n, `${n.id}.${i}`, params, element));
  });
  return {
    layout: spec.layout,
    nodes,
    flows: bindFlows(spec.flows ?? [], spec.nodes.map((n) => n.id), nodes, params),
  };
};
