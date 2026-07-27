/* Fixture specs + param sets: the draft interface. Each spec here is written as
   the exact JSON a manifest's future `diagram = ...` declaration should produce
   (concordia's roster/premise params are the real ones from its package.nix), so
   "plugging in" later is transcribing these shapes into adb.types — no renderer
   changes. The gallery page and the render test both iterate this list. */

import type { DiagramSpec, Params } from "./spec.ts";

export type Fixture = { name: string; title: string; spec: DiagramSpec; params: Params };

/* concordia: cast around a shared scene, game master narrating from the side */
export const concordiaSpec: DiagramSpec = {
  layout: "arena",
  nodes: [
    { id: "cast", kind: "agent", forEach: "agents", label: "{name}", detail: "{goal}", badge: "{model}" },
    { id: "gm", kind: "orchestrator", label: "game master", detail: "{game_master}" },
    { id: "world", kind: "environment", label: "{premise}", detail: "premise" },
  ],
  flows: [
    { from: "cast.*", to: "world", back: true },
    { from: "gm", to: "world" },
  ],
};

const cafeParams: Params = {
  agents: [
    { name: "Alice", goal: "Catch up warmly and find out how Bob has been.", model: "" },
    { name: "Bob", goal: "Share what has changed in your life since you last met.", model: "" },
  ],
  premise:
    "Alice and Bob, old friends who have not spoken in months, run into each other at a small cafe on a rainy afternoon.",
  game_master: "dialogic",
  model: "mock/model",
};

const marketParams: Params = {
  agents: [
    { name: "Mara", goal: "Sell the lamp for at least 40 coins.", model: "openai/qwen3.5-9b" },
    { name: "Tomas", goal: "Buy the lamp for under 25 coins.", model: "anthropic/claude-sonnet-5" },
    { name: "Ines", goal: "Undercut Mara with a rival lamp.", model: "openai/qwen3.5-9b" },
    { name: "Rook", goal: "Watch for pickpockets, interrupt any deal.", model: "" },
  ],
  premise: "A crowded market square at noon; a brass lamp is up for haggling.",
  game_master: "generic",
  model: "mock/model",
};

/* an inspect-shaped run: dataset → solver(model) → scorer */
export const inspectSpec: DiagramSpec = {
  layout: "pipeline",
  nodes: [
    { id: "data", kind: "dataset", label: "{task}", detail: "{split} split", badge: "{limit} samples" },
    { id: "solver", kind: "agent", label: "solver", detail: "{solver}", badge: "{model}" },
    { id: "scorer", kind: "judge", label: "scorer", detail: "{scorer}" },
  ],
  flows: [
    { from: "data", to: "solver", label: "samples" },
    { from: "solver", to: "scorer", label: "transcripts" },
  ],
};

const inspectParams: Params = {
  task: "impossiblebench",
  split: "impossible-swebench",
  limit: 25,
  solver: "basic agent",
  scorer: "model-graded",
  model: "openai/qwen3.5-9b",
};

export const fixtures: Fixture[] = [
  { name: "concordia-cafe", title: "concordia — cafe (2 agents, keyless initial)", spec: concordiaSpec, params: cafeParams },
  { name: "concordia-market", title: "concordia — market haggle (4 agents, mixed models)", spec: concordiaSpec, params: marketParams },
  {
    name: "concordia-crowd",
    title: "concordia — crowd (7 agents: row wrap)",
    spec: concordiaSpec,
    params: {
      ...marketParams,
      agents: [
        ...(marketParams.agents as unknown[]),
        { name: "Petra", goal: "Find her lost brother in the crowd.", model: "" },
        { name: "Old Sal", goal: "Tell everyone about the old days at great length.", model: "" },
        { name: "The Crier", goal: "Announce the mayor's decree over and over.", model: "openai/qwen3.5-9b" },
      ],
    },
  },
  { name: "inspect-pipeline", title: "inspect-shaped — dataset → solver → scorer", spec: inspectSpec, params: inspectParams },
  {
    name: "concordia-empty",
    title: "concordia — blank builder form (degradation check)",
    spec: concordiaSpec,
    params: { agents: [], premise: "", game_master: "" },
  },
];
