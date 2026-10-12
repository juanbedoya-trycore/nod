// Reproduce una sesión de OpenCode capturada por tools/probe-opencode a través del adaptador real (adapter.ts),
// con una Platform en memoria y un cliente del SDK falso. Cada evento y cada hook se entregan en el instante en que
// se grabaron y en su orden: el reloj del adaptador es el de la captura.
import { NodEngine } from "../../src/core/engine.js";
import type { Envelope } from "../../src/core/events.js";
import type { Platform } from "../../src/core/platform.js";
import { createAdapter } from "../../src/hosts/opencode/adapter.js";
import type { NodHooks, RepoInfo, RunMode } from "../../src/hosts/opencode/adapter.js";
import { loadRows } from "./harness.js";

export interface OpencodeReplay {
  envelopes: Envelope[];
  logs: string[];
  files: Map<string, string>;
  store: Map<string, unknown>;
  /** Llamadas al cliente del SDK (respuestas a permisos, abort, prompts). */
  client: { method: string; args: any }[];
  /** Lo que quedó en `output.parts` de cada command.execute.before (lo que verá el modelo). */
  commandParts: { command: string; parts: any[] }[];
  hooks: NodHooks;
  /** El comando /nod con estos argumentos, como lo lanzaría el humano en la sesión. */
  command: (args: string) => Promise<string>;
}

export interface OpencodeReplayOptions {
  mode?: RunMode;
  env?: Record<string, string>;
  repo?: RepoInfo;
  readable?: Record<string, string>;
  controller?: { base: string; fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; text: string }> };
  /** Falla al escribir en los destinos de fichero (para comprobar que nada rompe la sesión). */
  failWrites?: boolean;
  /** Filas que no se entregan (p. ej. session.created, para una sesión que se retoma). */
  skip?: (row: { event: string; phase: string }) => boolean;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

export async function replayOpencode(fixture: string, opts: OpencodeReplayOptions = {}): Promise<OpencodeReplay> {
  const rows = loadRows(fixture).filter((r) => !(opts.skip?.(r) ?? false));
  let now = rows[0]!.ts;
  const env: Record<string, string> = { HOME: "/Users/dev", ...opts.env };
  const files = new Map<string, string>();
  const store = new Map<string, unknown>();
  const readable = new Map(Object.entries(opts.readable ?? {}));
  const logs: string[] = [];
  const calls: OpencodeReplay["client"] = [];
  const commandParts: OpencodeReplay["commandParts"] = [];

  const platform: Platform = {
    info: async () => ({ host: "opencode", profile: "opencode", machine: "mbp" }),
    env: async () => env,
    now: async () => now,
    after: (_ms, cb) => {
      const h = setTimeout(cb, 0);
      return { cancel: () => clearTimeout(h) };
    },
    fetch: async (url, init) => {
      if (opts.controller !== undefined && url.startsWith(opts.controller.base)) return opts.controller.fetch(url, init);
      return { status: 200, ok: true, text: "{}" };
    },
    store: {
      get: async (k) => store.get(k),
      set: async (k, v) => void (v === null ? store.delete(k) : store.set(k, structuredClone(v))),
    },
    read: async (path) => {
      if (readable.has(path)) return readable.get(path)!;
      throw new Error(`ENOENT ${path}`);
    },
    append: async (path, text) => {
      if (opts.failWrites) throw new Error("EACCES");
      files.set(path, (files.get(path) ?? "") + text);
    },
    write: async (path, text) => void readable.set(path, text),
    random: async (n) => crypto.getRandomValues(new Uint8Array(n)),
    log: (m) => void logs.push(m),
  };

  const record = (method: string) => async (args: any) => {
    calls.push({ method, args });
    return { data: method === "session.get" ? { version: "1.18.34" } : true };
  };
  const client = {
    postSessionIdPermissionsPermissionId: record("permission.reply"),
    session: { abort: record("session.abort"), promptAsync: record("session.promptAsync"), get: record("session.get") },
  };

  const hooks = createAdapter({
    engine: new NodEngine(),
    platform,
    clock: () => now,
    client,
    mode: opts.mode ?? "tui",
    directory: "/Users/dev/proyecto",
    repo: opts.repo,
  });

  const replies = () => calls.filter((c) => c.method === "permission.reply").length;
  for (const row of rows) {
    now = row.ts;
    if (row.phase === "event") {
      const before = replies();
      await hooks.event({ event: { type: row.event, properties: row.data } });
      // Con Nod Control, la retención corre aparte: se le da tiempo a decidir antes del siguiente evento.
      if (row.event === "permission.asked" && opts.controller !== undefined) for (let i = 0; i < 200 && replies() === before; i++) await settle(1);
    } else if (row.phase === "in") {
      if (row.event === "config") await hooks.config({ command: {} });
      else if (row.event === "dispose") await hooks.dispose();
      else {
        const hook = (hooks as unknown as Record<string, ((i: unknown, o: unknown) => Promise<void>) | undefined>)[row.event];
        const output = structuredClone(row.data?.output ?? {});
        await hook?.(row.data?.input, output);
        if (row.event === "command.execute.before") commandParts.push({ command: String(row.data?.input?.command), parts: output.parts });
      }
    }
    await settle();
  }
  await settle(20);

  const envelopes: Envelope[] = [];
  for (const text of files.values()) for (const l of text.split("\n").filter(Boolean)) envelopes.push(JSON.parse(l) as Envelope);
  const command = async (args: string) => {
    const out = { parts: [{ type: "text", text: args }] };
    await hooks["command.execute.before"]({ command: "nod", sessionID: "ses-x", arguments: args }, out);
    return String(out.parts[0]?.text ?? "");
  };
  return { envelopes, logs, files, store, client: calls, commandParts, hooks, command };
}
