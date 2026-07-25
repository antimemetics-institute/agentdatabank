/* The widget contract (docs/plan/v0.md §5, "Composer architecture").
   One file per widget in src/widgets/, default-exporting a WidgetDef. Discovery is
   vite's import.meta.glob (eager) — adding a widget = dropping a file, no barrel, no
   codegen. Widgets render parameter editors for the composer; the viewer pages don't
   use them. */

import type { ComponentType } from "react";

export type SchemaNode = { kind: string; [k: string]: unknown };

export interface WidgetProps {
  schema: SchemaNode;
  value: unknown;
  onChange: (value: unknown) => void;
}

export interface WidgetDef {
  /* the type kind this widget renders (llm, harness, str, int, float, bool, enum, list, struct) */
  kind: string;
  Widget: ComponentType<WidgetProps>;
}

export const widgets: WidgetDef[] = Object.values(
  import.meta.glob("./widgets/*.tsx", { eager: true }),
).map((m) => (m as { default: WidgetDef }).default);
