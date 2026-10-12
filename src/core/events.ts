// Nod v1 (docs/nod-v1.md): los eventos que emite Nod, sin nada del agente ni del consumidor.

export const NOD_VERSION = 1;

export type Privacy = "completo" | "redactado" | "trabajo";
export const PRIVACY_LEVELS: readonly Privacy[] = ["completo", "redactado", "trabajo"];

export interface Usage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  model?: string;
}

export interface Source {
  instance: string;
  host: string;
  host_version?: string;
  machine?: string;
  profile: string;
  privacy: Privacy;
}

export type EventType =
  | "session.start"
  | "session.end"
  | "prompt.submit"
  | "turn.start"
  | "turn.step"
  | "turn.end"
  | "tool.call"
  | "tool.result"
  | "permission.request"
  | "permission.decision"
  | "agent.spawn"
  | "agent.end"
  | "usage"
  | "command"
  | "task.set";

/** Un evento antes de numerar: lo que produce el normalizador. */
export interface Draft {
  ts: number;
  type: EventType;
  session: string;
  turn?: string;
  agent?: string;
  task?: string;
  data: Record<string, unknown>;
}

export interface NodEvent extends Draft {
  seq: number;
}

export interface Envelope {
  nod: typeof NOD_VERSION;
  source: Source;
  events: NodEvent[];
}

/** Uso del modelo tal como lo dan los agentes (nombres de la API de Anthropic) → Nod. */
export function usageOf(u: unknown): Usage | undefined {
  if (u === null || typeof u !== "object") return undefined;
  const o = u as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const out: Usage = {
    input: n(o.input_tokens ?? o.input),
    output: n(o.output_tokens ?? o.output),
    cache_read: n(o.cache_read_input_tokens ?? o.cache_read),
    cache_write: n(o.cache_creation_input_tokens ?? o.cache_write),
  };
  if (typeof o.model === "string") out.model = o.model;
  return out;
}

export function addUsage(a: Usage, b: Usage | undefined): Usage {
  if (b === undefined) return a;
  const out: Usage = {
    input: a.input + b.input,
    output: a.output + b.output,
    cache_read: a.cache_read + b.cache_read,
    cache_write: a.cache_write + b.cache_write,
  };
  const model = b.model ?? a.model;
  if (model !== undefined) out.model = model;
  return out;
}

export const ZERO_USAGE: Usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
