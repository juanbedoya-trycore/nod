// Reproduce una sesión capturada por tools/probe a través del adaptador de Claude Code real, con un `$`
// simulado. Cada hook se llama en el instante de su evento de entrada y su `next()` se resuelve en el instante
// de su salida: el orden y los tiempos son los de la sesión original.
import { readFileSync } from "node:fs";
import { vi } from "vitest";
import type { Envelope } from "../../src/core/events.js";

interface Row {
  ts: number;
  phase: "in" | "out";
  event: string;
  data: any;
}

type Hook = ($: any, e: any, next: any) => any;
interface Registered {
  event: string;
  matcher: Record<string, unknown> | undefined;
  hook: Hook;
}

/** Llamadas a `$` que la sonda registró como eventos: el arnés las contesta con lo que se grabó. */
const API = new Set(["session.id", "session.usage", "session.version", "session.repo", "session.model"]);

export interface Replay {
  envelopes: Envelope[];
  posts: { url: string; headers: Record<string, string>; body: Envelope }[];
  logs: string[];
  files: Map<string, string>;
  store: Map<string, unknown>;
  command: (args: string) => Promise<string>;
}

export interface ReplayOptions {
  env?: Record<string, string>;
  httpStatus?: number;
  /** Contenido del fichero de configuración (NOD_CONFIG o ~/.config/nod/config.json). */
  configFile?: string;
}

/** Ejecuta un hook: si es un generador (streaming), lo recorre hasta su valor de retorno. */
async function drive(r: any): Promise<unknown> {
  if (r && typeof r[Symbol.asyncIterator] === "function") {
    for (;;) {
      const step = await r.next();
      if (step.done) return step.value;
    }
  }
  return r;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

export function loadRows(path: string): Row[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
}

export async function replay(fixture: string, opts: ReplayOptions = {}): Promise<Replay> {
  vi.resetModules();
  const { register } = await import("../../src/hosts/claude/register.js");
  const registered: Registered[] = [];
  const on = (event: string, a: any, b?: any) => {
    registered.push({ event, matcher: b === undefined ? undefined : a, hook: b ?? a });
    return { catch: () => undefined };
  };
  register(on as never);

  const rows = loadRows(fixture);
  // Las llamadas a `$` se contestan con lo que devolvió el motor en ese momento de la sesión (el último valor
  // grabado hasta `now`), no con el final: así un snapshot leído a destiempo se nota.
  const lastValue = (name: string) => {
    let found: unknown;
    for (const r of rows) {
      if (r.ts > now) break;
      if (r.event === name && r.phase === "out") found = r.data?.value;
    }
    if (found !== undefined) return found;
    return rows.find((r) => r.event === name && r.phase === "out")?.data?.value;
  };
  const env: Record<string, string> = { HOME: "/Users/dev", CLAUDE_CONFIG_DIR: "/Users/dev/.local/state/ws/claude/personal", ...opts.env };
  const files = new Map<string, string>();
  const store = new Map<string, unknown>();
  const logs: string[] = [];
  const posts: Replay["posts"] = [];
  let now = rows[0]!.ts;

  const $ = {
    clock: {
      now: async () => now,
      after: (_ms: number, cb: () => void) => {
        const h = setTimeout(cb, 0);
        return { cancel: () => clearTimeout(h) };
      },
    },
    env: { get: async (k: string) => env[k] },
    store: {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: unknown) => void store.set(k, structuredClone(v)),
      delete: async (k: string) => void store.delete(k),
    },
    fs: {
      read: async (p: string) => {
        const cfg = env.NOD_CONFIG ?? `${env.HOME}/.config/nod/config.json`;
        if (opts.configFile !== undefined && p === cfg) return opts.configFile;
        throw new Error(`ENOENT ${p}`);
      },
    },
    process: {
      run: async (argv: string[], o?: { stdin?: string }) => {
        if (argv[0] === "tee") {
          files.set(argv[2]!, (files.get(argv[2]!) ?? "") + (o?.stdin ?? ""));
          return { exitCode: 0, stdout: o?.stdin ?? "" };
        }
        if (argv[0] === "hostname") return { exitCode: 0, stdout: "mbp\n" };
        return { exitCode: 0, stdout: "" };
      },
    },
    http: {
      fetch: async (url: string, init: { headers: Record<string, string>; body: string }) => {
        posts.push({ url, headers: init.headers, body: JSON.parse(init.body) as Envelope });
        const status = opts.httpStatus ?? 200;
        return { status, ok: status < 300, text: "{}" };
      },
    },
    session: {
      id: async () => lastValue("session.id"),
      version: async () => lastValue("session.version"),
      repo: async () => lastValue("session.repo"),
      model: async () => lastValue("session.model"),
      usage: async () => lastValue("session.usage"),
      cwd: async () => "/Users/dev/proyecto",
    },
    command: { register: async () => undefined },
    ui: { log: (m: string) => void logs.push(m), toast: () => undefined, status: () => undefined },
  };

  const matches = (r: Registered, e: any) =>
    r.matcher === undefined ? !registered.some((o) => o.event === r.event && o.matcher !== undefined && Object.entries(o.matcher).every(([k, v]) => e?.[k] === v)) : Object.entries(r.matcher).every(([k, v]) => e?.[k] === v);

  // Para cada evento, las salidas pendientes en orden de llegada (FIFO por nombre).
  const waiting = new Map<string, ((v: unknown) => void)[]>();
  const running: Promise<unknown>[] = [];
  for (const row of rows) {
    now = row.ts;
    if (API.has(row.event)) continue;
    if (row.phase === "in") {
      const hooks = registered.filter((r) => r.event === row.event && matches(r, row.data));
      let resolveOut!: (v: unknown) => void;
      const out = new Promise((r) => (resolveOut = r));
      const q = waiting.get(row.event) ?? [];
      q.push(resolveOut);
      waiting.set(row.event, q);
      // turn.step va en streaming: su next() es un iterable asíncrono cuyo valor de retorno es la salida.
      const stream = row.event === "turn.step";
      const call = stream ? () => (async function* () { return await out; })() : () => out;
      const next = Object.assign(call, { signal: undefined, event: row.event });
      for (const h of hooks) running.push(drive(h.hook($, row.data, next)));
    } else {
      waiting.get(row.event)?.shift()?.(row.data);
    }
    await settle();
  }
  await Promise.all(running);
  await settle(20);

  const envelopes: Envelope[] = [];
  for (const text of files.values()) for (const l of text.split("\n").filter(Boolean)) envelopes.push(JSON.parse(l) as Envelope);
  const command = async (args: string) => {
    const h = registered.find((r) => r.event === "command.run" && r.matcher?.command === "nod")!;
    return String((await h.hook($, { command: "nod", args }, () => undefined)).text);
  };
  return { envelopes, posts, logs, files, store, command };
}
