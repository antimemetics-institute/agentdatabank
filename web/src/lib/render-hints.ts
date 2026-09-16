/* JSON Schema presentation only. Event bytes and producer metadata stay opaque. */
import type { Ev, EventPayload } from "../shared/types.ts";

import { containsElision } from "./event-transport.ts";

export interface RenderHint {
  icon: string;
  actor?: string | null;
  actor_label?: string | null;
  actor_registry?: { path: string; label: string } | null;
  title?: string | null;
  body?: string | null;
  format?: "text" | "markdown" | "json" | "html-text";
  fields?: string[] | null;
  badge?: string | null;
}
export type JsonSchema = Record<string, any>;
export interface EventDefinition {
  type: string;
  kind?: string;
  schema: JsonSchema;
}

export function compileSchemas(schemas: JsonSchema[]): EventDefinition[] {
  const definitions = new Map<string, EventDefinition>();
  for (const root of schemas) {
    const visit = (node: JsonSchema, refs = new Set<string>()) => {
      if (node.$ref) {
        if (refs.has(node.$ref) || !node.$ref.startsWith("#/$defs/")) return;
        const target = root.$defs?.[node.$ref.slice(8).replace(/~1/g, "/").replace(/~0/g, "~")];
        if (target) visit(target, new Set([...refs, node.$ref]));
        return;
      }
      for (const member of node.oneOf ?? node.anyOf ?? []) visit(member, refs);
      const props = node.properties;
      if (!props?.type) return;
      const types: string[] = props.type.const ? [props.type.const] : props.type.enum ?? [];
      const kinds: (string | undefined)[] = props.kind?.const
        ? [props.kind.const] : props.kind?.enum ?? [undefined];
      for (const type of types) for (const kind of kinds)
        definitions.set(`${type}/${kind ?? ""}`, { type, kind, schema: node });
    };
    visit(root);
  }
  return [...definitions.values()];
}

export function fieldAt(event: EventPayload, path?: string | null): unknown {
  if (!path) return undefined;
  let value: unknown = event;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** Bare paths keep their original meaning. Templates have substitutions only. */
export function hintValue(event: EventPayload, template?: string | null): unknown {
  if (!template) return undefined;
  if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(template)) return fieldAt(event, template);
  return template.replace(/\{([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\}/g,
    (_match, path: string) => hintText(fieldAt(event, path)));
}

/** Convert foreign HTML to inert text, without ever handing it to a DOM sink. */
export function htmlToText(html: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][^"'<>]*(?:(?:"[^"]*"|'[^']*')[^"'<>]*)*>/g,
      (tag) => /^<\/?(?:div|p|br|li|h[1-6]|tr|blockquote|section)\b/i.test(tag) ? "\n" : "")
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
      if (!entity.startsWith("#")) return entities[entity.toLowerCase()] ?? match;
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
    }).replace(/\n[ \t]*\n+/g, "\n").trim();
}

export function hintBody(event: EventPayload, hint: RenderHint): string {
  const text = hintText(hintValue(event, hint.body));
  return hint.format === "html-text" ? htmlToText(text) : text;
}

export function renderHint(event: EventPayload, definitions: EventDefinition[]): RenderHint | null {
  const definition = definitions.find((d) => d.type === event.type && d.kind === event.kind)
    ?? definitions.find((d) => d.type === event.type && d.kind === undefined);
  if (!definition) return null;
  let hint: RenderHint | null = definition.schema["x-adb-render"] ?? null;
  for (const branch of definition.schema.allOf ?? []) {
    const test = branch.if;
    if (test && (test.required ?? []).every((key: string) => Object.hasOwn(event, key))
      && Object.entries(test.properties ?? {}).every(([key, value]) =>
        event[key] === (value as JsonSchema).const))
      hint = branch.then?.["x-adb-render"] ?? hint;
  }
  return hint;
}

export function actorFor(event: Ev, definitions: EventDefinition[]): string | null {
  const value = fieldAt(event.event, renderHint(event.event, definitions)?.actor);
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

/** Seed the whole roster before applying row labels, in transcript order. IDs remain identity. */
export function actorLabels(events: Ev[], definitions: EventDefinition[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const event of events) {
    const registry = renderHint(event.event, definitions)?.actor_registry;
    if (!registry) continue;
    const entries = fieldAt(event.event, registry.path);
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const [id, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || !Object.hasOwn(entry, registry.label)) continue;
      const value = entry[registry.label];
      if (typeof value === "string" && value.trim()) labels.set(id, value);
    }
  }
  for (const event of events) {
    const id = actorFor(event, definitions);
    const value = fieldAt(event.event, renderHint(event.event, definitions)?.actor_label);
    if (id === null || typeof value !== "string" || !value.trim()) continue;
    labels.set(id, value);
  }
  return labels;
}

export const eventKind = (event: Ev): string => event.event.type === "custom" ? event.event.kind ?? "custom" : event.event.type;
export const kindNamespace = (kind: string): string | null => kind.includes(".") ? kind.split(".", 1)[0]! : null;
export const schemaKinds = (definitions: EventDefinition[]): string[] =>
  [...new Set(definitions.map((d) => d.kind ?? d.type))];

export function hintText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (containsElision(value)) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
