/* The experiment-diagram vocabulary — the draft of what manifests will one day
   declare under `diagram = ...` (nix side not wired yet; fixtures.ts holds the
   intended manifest JSON verbatim). Deliberately tiny: a closed set of node
   kinds the web renders as bespoke glyphs, plus three binding forms — `forEach`
   over a list param, `{field}` interpolation, `variant` switching a glyph by a
   param value. No expressions, no conditionals: an experiment that can't say
   itself in this vocabulary wants a new primitive, not a bigger language. */

export const NODE_KINDS = [
  "agent", // a character/actor driven by a model
  "orchestrator", // the thing that runs the scene (game master, scaffold, solver)
  "environment", // the shared world/premise the actors act in
  "model", // an LLM endpoint as a first-class box (pipelines)
  "dataset", // a task/sample source (inspect-style pipelines)
  "judge", // a scorer/grader stage
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export type NodeSpec = {
  id: string;
  kind: NodeKind;
  /* param path holding a list — the node repeats once per element, and `{field}`
     templates resolve against the element, falling back to whole-params; an
     EMPTY element value falls through too (empty-means-inherit, the params
     convention). Instances get ids `<id>.0`, `<id>.1`, … which `<id>.*` matches
     in flows. */
  forEach?: string;
  /* templates: literal text with `{path}` holes. A hole that resolves to nothing
     renders as empty — never as the literal `{path}`. */
  label: string;
  detail?: string;
  /* small chip under the label (model ids, splits); empty ⇒ chip not drawn */
  badge?: string;
  /* glyph modifier, e.g. the game_master prefab name; unknown values are fine —
     the renderer falls back to the kind's base glyph (never a broken picture) */
  variant?: string;
};

export type FlowSpec = {
  /* a ROLE reference: a spec node id (`gm`), or `<id>.*` for every instance of
     a forEach node. Individual instances (`cast.1`) are deliberately not
     addressable — role-level flows always draw without crossing anything, so
     the renderer never needs edge routing. If an experiment ever parameterizes
     per-agent topology, that's a containment primitive, not a flow. */
  from: string;
  to: string;
  back?: boolean; // arrowheads both ends
  label?: string; // template, same rules as node templates
};

export type DiagramSpec = {
  /* named arrangement, not a layout engine: `arena` = cast around a shared
     environment (concordia-shaped), `pipeline` = left-to-right stages
     (inspect-shaped). New shapes are new names here + code in layout.ts. */
  layout: "arena" | "pipeline";
  nodes: NodeSpec[];
  flows?: FlowSpec[];
};

/* realized params, as the builder holds them / the run record stores them */
export type Params = Record<string, unknown>;

/* ---- bound scene (bind.ts output): specs resolved against params ---- */

export type SceneNode = {
  id: string; // instance id: spec id, or `<id>.<i>` for forEach instances
  kind: NodeKind;
  label: string;
  detail?: string;
  badge?: string;
  variant?: string;
};

export type SceneFlow = { from: string; to: string; back?: boolean; label?: string };

export type Scene = {
  layout: DiagramSpec["layout"];
  nodes: SceneNode[];
  flows: SceneFlow[];
};
