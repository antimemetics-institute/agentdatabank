import type { Ev } from "../shared/types.ts";

export interface ToolCall { id: string; function: string; arguments: unknown; parse_error?: string | null }
export interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: ToolCall[] | null;
  tool_call_id?: string | string[] | null;
  function?: string | null;
  error?: { type: string; message: string } | null;
  [field: string]: unknown;
}

/** Sequence order across the whole run, independent of the active facet/window. */
export function previousCalls(events: Ev[]): Map<number, Ev> {
  const previous = new Map<number, Ev>();
  const agents = new Map<string, Ev>();
  for (const record of [...events].sort((a, b) => a.seq - b.seq)) {
    if (record.event.type !== "llm.call" || typeof record.event.agent !== "string") continue;
    const last = agents.get(record.event.agent);
    if (last) previous.set(record.seq, last);
    agents.set(record.event.agent, record);
  }
  return previous;
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => equal(value, right[index]));
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

export function historyStart(input: ChatMessage[], previous?: ChatMessage[]): { start: number; differs: boolean } {
  if (previous === undefined) return { start: 0, differs: false };
  return previous.length < input.length && previous.every((message, index) => equal(message, input[index]))
    ? { start: previous.length, differs: false } : { start: 0, differs: true };
}

export interface MessageEntry {
  message: ChatMessage;
  index: number;
  contextOnly: boolean;
  results: Map<string, ChatMessage[]>;
}

/** Attach visible tool results to their preceding request, by id, without mutation.
 * If the request is in hidden history, expose only that call as labeled context.
 */
export function messageEntries(messages: ChatMessage[], start = 0): MessageEntry[] {
  const calls = new Map<string, number>();
  const entries = new Map<number, MessageEntry>();
  const entry = (index: number) => {
    let item = entries.get(index);
    if (!item) { item = { message: messages[index]!, index, contextOnly: index < start, results: new Map() }; entries.set(index, item); }
    return item;
  };
  for (const [index, message] of messages.entries()) {
    for (const call of message.tool_calls ?? []) calls.set(call.id, index);
    if (index < start) continue;
    const id = message.role === "tool" && typeof message.tool_call_id === "string" ? message.tool_call_id : null;
    const owner = id ? calls.get(id) : undefined;
    if (id && owner !== undefined && owner < index) {
      const request = entry(owner);
      request.results.set(id, [...(request.results.get(id) ?? []), message]);
    } else entry(index);
  }
  return [...entries.values()].sort((a, b) => a.index - b.index);
}
