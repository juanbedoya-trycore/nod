// Adaptador de Claude Code (API de mods, claude >= 2.1.296): traduce los eventos del motor a NodEngine
// (../../core/engine.ts) y le da una Platform hecha con `$`. Observa sin cambiar nada, salvo en un sitio: con
// Nod Control activo, `tool.check` espera a la retención y puede devolver la decisión de un aprobador
// (docs/control-v1.md). Los nombres y campos de los eventos están comprobados con tools/probe (docs/nod-v1.md).
//
// Restricciones del sandbox: sin Node ni DOM; `register` declarada con `function`; `$` se escribe siempre
// `$.noun.verb(...)` en la llamada; `$.env.get` con nombre literal.
import { COMMAND_DESCRIPTION, NodEngine } from "../../core/engine.js";
import type { NodEnv } from "../../core/config.js";
import type { HostInfo, Platform } from "../../core/platform.js";
import type { SessionInfo, UsageSnapshot } from "../../core/normalize.js";
import { usageOf } from "../../core/events.js";
import { withContext } from "../../core/control/messages.js";
import { MODE_CACHE_MS, lastMode, modeGrepArgs, transcriptPath } from "./mode.js";

type Engine = any;
type Hook = ($: Engine, e: any, next: any) => any;
type StreamHook = ($: Engine, e: any, next: any) => AsyncGenerator<unknown, unknown, unknown>;
interface On {
  (event: string, hook: Hook | StreamHook): { catch: (handler: Hook | StreamHook) => unknown };
  (event: string, matcher: Record<string, unknown>, hook: Hook): { catch: (handler: Hook) => unknown };
}

const nod = new NodEngine();
let env: Promise<NodEnv> | undefined;
let info: Promise<HostInfo> | undefined;
let sessionId: string | undefined;
let sessionCwd: string | undefined;
const madeDirs = new Set<string>();
/** Modo de permisos que dio el hook clásico UserPromptSubmit (si la política deja que llegue). */
let hookMode: string | undefined;
let transcript: string | undefined;
let modeCache: { at: number; session: string; mode: string | undefined } | undefined;

/**
 * Lo que Claude Code devuelve al modelo cuando el humano niega un permiso (con `isError`). Anclado al principio:
 * una tool que imprima esta frase (un grep, un cat de este fichero) no es un rechazo.
 */
const REJECTED_RE = /^(Error: )?The user doesn't want to proceed with this tool use/;

async function readEnv($: Engine): Promise<NodEnv> {
  return {
    NOD_SINKS: await $.env.get("NOD_SINKS"),
    NOD_TOKEN: await $.env.get("NOD_TOKEN"),
    NOD_PRIVACY: await $.env.get("NOD_PRIVACY"),
    NOD_INSTANCE: await $.env.get("NOD_INSTANCE"),
    NOD_TASK: await $.env.get("NOD_TASK"),
    NOD_CONFIG: await $.env.get("NOD_CONFIG"),
    NOD_OFF: await $.env.get("NOD_OFF"),
    NOD_CONTROL: await $.env.get("NOD_CONTROL"),
    NOD_CONTROL_TOKEN: await $.env.get("NOD_CONTROL_TOKEN"),
    NOD_FORBIDDEN_ADD: await $.env.get("NOD_FORBIDDEN_ADD"),
    HOME: await $.env.get("HOME"),
    XDG_CONFIG_HOME: await $.env.get("XDG_CONFIG_HOME"),
    XDG_STATE_HOME: await $.env.get("XDG_STATE_HOME"),
  };
}

/** Perfil de Claude Code: el nombre del directorio de configuración (`~/.claude` → `claude`). */
export function profileOf(configDir: string | undefined): string {
  const d = (configDir ?? "").replace(/\/+$/, "");
  if (d === "") return "claude";
  const b = d.slice(d.lastIndexOf("/") + 1);
  return b === ".claude" || b === "" ? "claude" : b;
}

async function readInfo($: Engine): Promise<HostInfo> {
  const version = await Promise.resolve().then(() => $.session.version()).catch(() => undefined);
  const host = await $.process.run(["hostname", "-s"]).catch(() => undefined);
  const machine = typeof host?.stdout === "string" ? host.stdout.trim() : "";
  const out: HostInfo = { host: "claude", profile: profileOf(await $.env.get("CLAUDE_CONFIG_DIR")) };
  const v = typeof version === "string" ? version : version?.version;
  if (typeof v === "string") out.hostVersion = v;
  if (machine !== "") out.machine = machine;
  return out;
}

async function mkdirFor($: Engine, path: string): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir !== "" && !madeDirs.has(dir)) {
    await $.process.run(["mkdir", "-p", dir]);
    madeDirs.add(dir);
  }
}

/** n bytes de un CSPRNG: `crypto.getRandomValues` si el sandbox lo tiene; si no, `openssl rand`. */
async function randomBytes($: Engine, n: number): Promise<Uint8Array> {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c !== undefined && typeof c.getRandomValues === "function") return c.getRandomValues(new Uint8Array(n));
  const r = await $.process.run(["openssl", "rand", "-hex", String(n)]);
  const hex = String(r?.stdout ?? "").trim();
  if (!new RegExp(`^[0-9a-f]{${2 * n}}$`).test(hex)) throw new Error("sin generador aleatorio criptográfico");
  return Uint8Array.from(hex.match(/../g)!.map((h: string) => parseInt(h, 16)));
}

function quiet(f: () => void): void {
  try {
    f();
  } catch {
    // sin superficie (p. ej. -p)
  }
}

function platform($: Engine): Platform {
  return {
    info: () => (info ??= readInfo($).catch((err) => {
      info = undefined;
      throw err;
    })),
    env: () => (env ??= readEnv($).catch((err) => {
      env = undefined;
      throw err;
    })),
    now: async () => Number(await $.clock.now()),
    after: (ms, cb) => $.clock.after(ms, cb),
    fetch: async (url, init) => {
      const r = await $.http.fetch(url, init);
      return { status: r.status, ok: r.ok, text: String(r.text ?? "") };
    },
    store: {
      get: (key) => $.store.get(key),
      set: (key, value) => (value === null ? $.store.delete(key) : $.store.set(key, value)),
    },
    read: async (path) => String(await $.fs.read(path)),
    append: async (path, text) => {
      await mkdirFor($, path);
      const r = await $.process.run(["tee", "-a", path], { stdin: text });
      const code = r?.exitCode ?? r?.code ?? 0;
      if (code !== 0) throw new Error(`tee salió con ${code}: ${String(r?.stderr ?? "").trim()}`);
    },
    write: async (path, text) => {
      await mkdirFor($, path);
      await $.fs.write(path, text);
    },
    random: (n) => randomBytes($, n),
    log: (message) => $.ui.log(message, { to: "debug" }),
    status: (text) => quiet(() => $.ui.status(text)),
    toast: (text) => quiet(() => $.ui.toast(text)),
    session: {
      abortTurn: async (turnId) => {
        await $.turn.abort({ turnId });
      },
      submitPrompt: async (text) => {
        await $.prompt.submit({ text, asUser: true });
      },
    },
  };
}

/**
 * Modo de permisos de la sesión (ver mode.ts): el del hook clásico si llegó; si no, el último que escribió
 * Claude Code en la transcripción (cacheado 2 s). undefined si no se sabe: entonces se retiene.
 */
async function sessionMode($: Engine): Promise<string | undefined> {
  if (hookMode !== undefined) return hookMode;
  try {
    const now = Number(await $.clock.now());
    const session = await currentSession($);
    if (modeCache !== undefined && modeCache.session === session && now - modeCache.at < MODE_CACHE_MS) return modeCache.mode;
    if (transcript === undefined || !transcript.endsWith(`/${session}.jsonl`)) {
      const home = await $.env.get("HOME");
      const configDir = (await $.env.get("CLAUDE_CONFIG_DIR")) || (home ? `${home}/.claude` : undefined);
      const cwd = sessionCwd ?? (await $.session.cwd());
      if (typeof configDir !== "string" || typeof cwd !== "string") return undefined;
      transcript = transcriptPath(configDir, cwd, session);
    }
    let r = await $.process.run(modeGrepArgs(transcript));
    if (lastMode(r?.stdout) === undefined) {
      // La carpeta sale de la ruta real (/tmp → /private/tmp): se busca la transcripción por su nombre.
      const projects = transcript.slice(0, transcript.lastIndexOf("/projects/") + "/projects".length);
      const f = await $.process.run(["/usr/bin/find", projects, "-maxdepth", "2", "-name", `${session}.jsonl`]);
      const found = typeof f?.stdout === "string" ? f.stdout.split("\n").find((l: string) => l.endsWith(".jsonl")) : undefined;
      if (found !== undefined && found !== transcript) {
        transcript = found;
        r = await $.process.run(modeGrepArgs(found));
      }
    }
    const mode = lastMode(r?.stdout);
    modeCache = { at: now, session, mode };
    return mode;
  } catch {
    return undefined;
  }
}

async function currentSession($: Engine): Promise<string> {
  sessionId ??= String(await $.session.id());
  return sessionId;
}

const opt = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

async function sessionInfo($: Engine, e: any): Promise<SessionInfo> {
  const repo = await Promise.resolve().then(() => $.session.repo()).catch(() => undefined);
  const model = await Promise.resolve().then(() => $.session.model()).catch(() => undefined);
  return {
    cwd: opt(e?.cwd),
    repo: repo && typeof repo === "object" ? { root: repo.root ?? null, remote: repo.remote ?? null, name: repo.name ?? null } : undefined,
    model: opt(model),
    interactive: e?.isInteractive === true,
    surface: opt(e?.surface),
  };
}

/** Contexto, límites de uso y costo de la sesión (`$.session.usage`, si el motor lo tiene). */
async function usageSnapshot($: Engine): Promise<UsageSnapshot | undefined> {
  const u = await Promise.resolve().then(() => $.session.usage()).catch(() => undefined);
  if (u === undefined || u === null) return undefined;
  const out: UsageSnapshot = {};
  if (u.context && typeof u.context.window === "number") out.context = { tokens: u.context.tokens, window: u.context.window, percent: u.context.percent };
  if (Array.isArray(u.rateLimits)) {
    out.limits = u.rateLimits
      .filter((l: any) => typeof l?.kind === "string" && typeof l?.percentUsed === "number")
      .map((l: any) => ({ kind: l.kind, percent_used: l.percentUsed, ...(typeof l.resetsAt === "string" ? { resets_at: l.resetsAt } : {}) }));
  }
  if (u.cost && typeof u.cost.usd === "number") out.cost_usd = u.cost.usd;
  return out;
}

/** La entrada de una tool: el evento sin los campos del motor. */
function toolInput(e: any): Record<string, unknown> {
  const { tool: _t, tool_use_id: _i, agentId: _a, ...input } = e ?? {};
  return input;
}

export function register(on: On, _options?: unknown): void {
  on("session.start", async ($, e, next) => {
    try {
      await $.command.register({ name: "nod", description: COMMAND_DESCRIPTION });
      sessionId = String(await $.session.id());
      sessionCwd = opt(e?.cwd);
      await nod.sessionStart(platform($), sessionId, await sessionInfo($, e));
    } catch (err) {
      $.ui.log(`nod: session.start falló (${String(err)})`, { to: "debug" });
    }
    return next(e);
  }).catch((_$, e, next) => next(e));

  on("command.run", { command: "nod" }, async ($, e) => ({ text: await nod.runCommand(platform($), await currentSession($), String(e.args ?? "")) }));

  on("command.run", async ($, e, next) => {
    if (typeof e?.command === "string" && e.command !== "nod") void nod.command(platform($), await currentSession($), e.command);
    return next(e);
  }).catch((_$, e, next) => next(e));

  on("prompt.edit", async ($, e, next) => {
    await nod.promptEdit(platform($), {
      before: String(e?.text ?? ""),
      start: Number(e?.start) || 0,
      end: Number(e?.end) || 0,
      inserted: String(e?.inputText ?? ""),
    });
    return next(e);
  }).catch((_$, e, next) => next(e));

  on("prompt.submit", async ($, e, next) => {
    // Los hooks que bloquean al agente (prompt.submit, tool.call, tool.check…) no esperan a Nod: el trabajo va en
    // la fila del motor, en orden.
    void nod.promptSubmit(platform($), await currentSession($), String(e?.text ?? ""), opt(e?.origin?.kind) ?? "unknown");
    return next(e);
  }).catch((_$, e, next) => next(e));

  on("turn.start", async ($, e, next) => {
    if (typeof e?.turnId === "string") await nod.turnStart(platform($), await currentSession($), e.turnId, opt(e.agentId));
    return next(e);
  }).catch((_$, e, next) => next(e));

  // turn.step va en streaming: el hook es un generador que deja pasar los fragmentos y lee el resultado final.
  on("turn.step", async function* ($: Engine, e: any, next: any) {
    if (typeof e?.turnId === "string") void nod.stepBegin(platform($), e.turnId, opt(e.agentId));
    const out = yield* next(e);
    if (typeof e?.turnId === "string") {
      await nod.step(platform($), await currentSession($), {
        turn: e.turnId,
        agent: opt(e.agentId),
        index: Number(e.index) || 0,
        model: opt(e.model),
        effort: opt(e.effort),
        stopReason: opt(out?.stopReason),
        tools: Array.isArray(out?.toolUses) ? out.toolUses.map((t: any) => String(t?.name ?? "?")) : [],
        usage: usageOf(out?.usage),
      });
    }
    return out;
  }).catch(async function* (_$: Engine, e: any, next: any) {
    return yield* next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const out = await next(e);
    if (typeof e?.turnId === "string") {
      await nod.turnEnd(platform($), await currentSession($), {
        turn: e.turnId,
        agent: opt(e.agentId),
        durationMs: typeof e.durationMs === "number" ? e.durationMs : undefined,
        outcome: e.isAborted === true ? "aborted" : opt(e.reason) ?? "answer",
        usage: usageOf(e.usage),
        answer: typeof e.answer === "string" ? e.answer : undefined,
      }, () => usageSnapshot($));
    }
    return out;
  }).catch((_$, e, next) => next(e));

  on("tool.call", async ($, e, next) => {
    const session = await currentSession($);
    const id = opt(e?.tool_use_id);
    const tool = String(e?.tool ?? "?");
    if (id !== undefined) void nod.toolCall(platform($), session, { toolUseId: id, tool, input: toolInput(e), agent: opt(e.agentId) });
    const out = await next(e);
    if (id !== undefined) {
      const text = typeof out?.text === "string" ? out.text : typeof out?.result === "string" ? out.result : "";
      const rejected = out?.isError === true && REJECTED_RE.test(typeof out?.result === "string" ? out.result : text);
      void nod.toolResult(platform($), session, { toolUseId: id, tool, ok: out?.isError !== true, rejected, outputChars: text.length });
    }
    // Un mensaje de un aprobador llegado a mitad de turno: el modelo lo lee con este resultado, sin esperar.
    const note = nod.takeNote(opt(e?.agentId));
    return note === undefined ? out : withContext(out, note);
  }).catch((_$, e, next) => next(e));

  on("tool.check", async ($, e, next) => {
    const started = $.clock.now();
    const verdict = await next(e);
    const id = opt(e?.tool_use_id);
    const d = verdict?.decision;
    if (id !== undefined && (d === "allow" || d === "deny" || d === "ask")) {
      // check_ms: lo que tardó el agente en decidir (otro mod que retiene el permiso lo alarga).
      const checkMs = Math.max(0, Number(await $.clock.now()) - Number(await started));
      void nod.toolCheck(platform($), await currentSession($), id, String(e?.tool ?? "?"), d, opt(verdict?.reason), checkMs);
    }
    // El único sitio donde Nod cambia una decisión: con Nod Control activo, un permiso preguntado espera una
    // decisión remota firmada. Si no llega (plazo, cancelación, fallo), el terminal pregunta como siempre.
    if (id !== undefined && d === "ask") {
      const info = { toolUseId: id, tool: String(e?.tool ?? "?"), input: e?.input, agent: opt(e?.agentId) };
      const remote = await nod.checkPermission(platform($), await currentSession($), info, next?.signal, () => sessionMode($));
      if (remote === "allow") return { decision: "allow", reason: "aprobado desde fuera del terminal (Nod Control)" };
      if (remote === "deny") return { decision: "deny", reason: "denegado desde fuera del terminal (Nod Control)" };
    }
    return verdict;
  }).catch((_$, e, next) => next(e));

  // Modo de permisos (para no retener en auto mode). Si la política de plugins salta los hooks clásicos, no
  // llega nunca y Nod lo lee de la transcripción.
  on("classic.UserPromptSubmit", async (_$, e, next) => {
    if (typeof e?.permission_mode === "string" && e.permission_mode !== "") hookMode = e.permission_mode;
    return next(e);
  }).catch((_$, e, next) => next(e));

  // La duración real de la ejecución: con ella, el instante en que el humano aprobó un permiso es exacto.
  // Si la organización desactiva los hooks clásicos, Nod marca la espera como aproximada (exact: false).
  on("classic.PostToolUse", async ($, e, next) => {
    if (typeof e?.tool_use_id === "string" && typeof e?.duration_ms === "number") void nod.toolExec(platform($), e.tool_use_id, e.duration_ms);
    return next(e);
  }).catch((_$, e, next) => next(e));

  on("agent.spawn", async ($, e, next) => {
    const out = await next(e);
    const agent = opt(out?.agentId);
    if (agent !== undefined) {
      void nod.agentSpawn(platform($), await currentSession($), {
        agent,
        type: opt(e?.subagentType) ?? "agent",
        description: opt(e?.description),
        background: e?.background === true,
        fork: typeof e?.fork === "boolean" ? e.fork : undefined,
        permissionMode: opt(e?.permissionMode),
        model: opt(out?.model),
        toolUseId: opt(e?.tool_use_id),
      });
    }
    return out;
  }).catch((_$, e, next) => next(e));

  on("session.end", async ($, e, next) => {
    await nod.sessionEnd(platform($), opt(e?.sessionId) ?? (await currentSession($)), opt(e?.reason) ?? "exit");
    // Tras /clear el proceso sigue con otra sesión y sin session.start: el id se vuelve a pedir al motor.
    sessionId = undefined;
    return next(e);
  }).catch((_$, e, next) => next(e));
}
