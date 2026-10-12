// Adaptador de Claude Code (API de mods, claude >= 2.1.296): traduce los eventos del motor a NodEngine
// (../../core/engine.ts) y le da una Platform hecha con `$`. Solo observa: nunca cambia lo que decide el motor.
// Los nombres y campos de los eventos están comprobados con tools/probe (docs/nod-v1.md).
//
// Restricciones del sandbox: sin Node ni DOM; `register` declarada con `function`; `$` se escribe siempre
// `$.noun.verb(...)` en la llamada; `$.env.get` con nombre literal.
import { COMMAND_DESCRIPTION, NodEngine } from "../../core/engine.js";
import type { NodEnv } from "../../core/config.js";
import type { HostInfo, Platform } from "../../core/platform.js";
import type { SessionInfo, UsageSnapshot } from "../../core/normalize.js";
import { usageOf } from "../../core/events.js";

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
const madeDirs = new Set<string>();

/** Lo que Claude Code devuelve al modelo cuando el humano niega un permiso. */
const REJECTED_RE = /doesn't want to proceed with this tool use|tool use was rejected/i;

async function readEnv($: Engine): Promise<NodEnv> {
  return {
    NOD_SINKS: await $.env.get("NOD_SINKS"),
    NOD_TOKEN: await $.env.get("NOD_TOKEN"),
    NOD_PRIVACY: await $.env.get("NOD_PRIVACY"),
    NOD_INSTANCE: await $.env.get("NOD_INSTANCE"),
    NOD_TASK: await $.env.get("NOD_TASK"),
    NOD_CONFIG: await $.env.get("NOD_CONFIG"),
    NOD_OFF: await $.env.get("NOD_OFF"),
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
      const dir = path.slice(0, path.lastIndexOf("/"));
      if (dir !== "" && !madeDirs.has(dir)) {
        await $.process.run(["mkdir", "-p", dir]);
        madeDirs.add(dir);
      }
      const r = await $.process.run(["tee", "-a", path], { stdin: text });
      const code = r?.exitCode ?? r?.code ?? 0;
      if (code !== 0) throw new Error(`tee salió con ${code}: ${String(r?.stderr ?? "").trim()}`);
    },
    log: (message) => $.ui.log(message, { to: "debug" }),
  };
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
      await nod.sessionStart(platform($), sessionId, await sessionInfo($, e));
    } catch (err) {
      $.ui.log(`nod: session.start falló (${String(err)})`, { to: "debug" });
    }
    return next(e);
  }).catch((_$, e, next) => next(e));

  on("command.run", { command: "nod" }, async ($, e) => ({ text: await nod.runCommand(platform($), await currentSession($), String(e.args ?? "")) }));

  on("command.run", async ($, e, next) => {
    if (typeof e?.command === "string" && e.command !== "nod") await nod.command(platform($), await currentSession($), e.command);
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
    await nod.promptSubmit(platform($), await currentSession($), String(e?.text ?? ""), opt(e?.origin?.kind) ?? "unknown");
    return next(e);
  }).catch((_$, e, next) => next(e));

  on("turn.start", async ($, e, next) => {
    if (typeof e?.turnId === "string") await nod.turnStart(platform($), await currentSession($), e.turnId, opt(e.agentId));
    return next(e);
  }).catch((_$, e, next) => next(e));

  // turn.step va en streaming: el hook es un generador que deja pasar los fragmentos y lee el resultado final.
  on("turn.step", async function* ($: Engine, e: any, next: any) {
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
    if (id !== undefined) await nod.toolCall(platform($), session, { toolUseId: id, tool, input: toolInput(e), agent: opt(e.agentId) });
    const out = await next(e);
    if (id !== undefined) {
      const text = typeof out?.text === "string" ? out.text : typeof out?.result === "string" ? out.result : "";
      const rejected = REJECTED_RE.test(typeof out?.result === "string" ? out.result : text);
      await nod.toolResult(platform($), session, { toolUseId: id, tool, ok: out?.isError !== true && !rejected, rejected, outputChars: text.length });
    }
    return out;
  }).catch((_$, e, next) => next(e));

  on("tool.check", async ($, e, next) => {
    const verdict = await next(e);
    const id = opt(e?.tool_use_id);
    const d = verdict?.decision;
    if (id !== undefined && (d === "allow" || d === "deny" || d === "ask")) {
      await nod.toolCheck(platform($), await currentSession($), id, String(e?.tool ?? "?"), d, opt(verdict?.reason));
    }
    return verdict;
  }).catch((_$, e, next) => next(e));

  on("agent.spawn", async ($, e, next) => {
    const out = await next(e);
    const agent = opt(out?.agentId);
    if (agent !== undefined) {
      await nod.agentSpawn(platform($), await currentSession($), {
        agent,
        type: opt(e?.subagentType) ?? "agent",
        description: opt(e?.description),
        background: e?.background === true,
        model: opt(out?.model),
        toolUseId: opt(e?.tool_use_id),
      });
    }
    return out;
  }).catch((_$, e, next) => next(e));

  on("session.end", async ($, e, next) => {
    await nod.sessionEnd(platform($), opt(e?.sessionId) ?? (await currentSession($)), opt(e?.reason) ?? "exit");
    return next(e);
  }).catch((_$, e, next) => next(e));
}
