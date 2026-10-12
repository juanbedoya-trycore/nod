// Adaptador de Claude Code (API de mods, claude >= 2.1.296). Traduce los eventos del motor a
// NodEngine (../../core/engine.ts) y le da una Platform hecha con `$`. Lo propio de Claude vive aquí:
// el modo de permisos leído de la transcripción, las cifras de `$.session.usage` y el lugar de la sesión.
//
// Restricciones del sandbox (S1): sin Node ni DOM; `$` solo se pasa a funciones declaradas con
// `function` al tope del fichero; `$.env.get` con nombre literal; el mod es siempre cliente HTTP.
import { COMMAND_DESCRIPTION, NodEngine } from "../../core/engine.js";
import type { Extra } from "../../core/engine.js";
import type { OrbitEnv, Platform, SessionControl } from "../../core/platform.js";
import { profileOf } from "../../core/links.js";
import { holdsInMode, lastMode, modeGrepArgs, transcriptPath } from "../../core/perm/mode.js";

// Tipos mínimos de la parte de `$` y de `on` que usa el mod (el sandbox no necesita 'claude-code').
type Engine = any;
type Hook = ($: Engine, e: any, next: any) => any;
interface On {
  (event: string, hook: Hook): { catch: (handler: Hook) => unknown };
  (event: string, matcher: Record<string, unknown>, hook: Hook): { catch: (handler: Hook) => unknown };
}

const orbit = new NodEngine();
let env: Promise<OrbitEnv> | undefined;
let sessionId: string | undefined;
let hostName: string | undefined;

/** Las variables que lee Orbit, una vez por proceso. `$.env.get` exige nombres literales. */
async function readEnv($: Engine): Promise<OrbitEnv> {
  return {
    ORBIT_URL: await $.env.get("ORBIT_URL"),
    ORBIT_TOKEN: await $.env.get("ORBIT_TOKEN"),
    ORBIT_INSTANCE_ID: await $.env.get("ORBIT_INSTANCE_ID"),
    ORBIT_CTX: await $.env.get("ORBIT_CTX"),
    ORBIT_STATE_DIR: await $.env.get("ORBIT_STATE_DIR"),
    ORBIT_PHONE_URL: await $.env.get("ORBIT_PHONE_URL"),
    ORBIT_PERM: await $.env.get("ORBIT_PERM"),
    ORBIT_PERM_HOLD_MS: await $.env.get("ORBIT_PERM_HOLD_MS"),
    ORBIT_FORBIDDEN: await $.env.get("ORBIT_FORBIDDEN"),
    ORBIT_FORBIDDEN_ADD: await $.env.get("ORBIT_FORBIDDEN_ADD"),
    ORBIT_WATCH_KEYS: await $.env.get("ORBIT_WATCH_KEYS"),
    HOME: await $.env.get("HOME"),
    XDG_CONFIG_HOME: await $.env.get("XDG_CONFIG_HOME"),
  };
}

function platform($: Engine): Platform {
  const quiet = (f: () => void) => {
    try {
      f();
    } catch {
      // sin superficie (p. ej. -p)
    }
  };
  return {
    host: "claude",
    env: () => (env ??= readEnv($).catch((err) => {
      env = undefined;
      throw err;
    })),
    now: async () => Number(await $.clock.now()),
    after: (ms, cb) => $.clock.after(ms, cb),
    fetch: async (url, init) => {
      const r = await $.http.fetch(url, init);
      return { status: r.status, ok: r.ok, text: r.text };
    },
    store: {
      get: (key) => $.store.get(key),
      set: (key, value) => $.store.set(key, value),
      delete: (key) => $.store.delete(key),
    },
    read: async (path) => String(await $.fs.read(path)),
    write: (path, text) => $.fs.write(path, text),
    run: (argv) => $.process.run(argv),
    log: (message) => $.ui.log(message, { to: "debug" }),
    toast: (message) => quiet(() => $.ui.toast(message)),
    status: (text) => quiet(() => $.ui.status(text)),
    sessionId: async () => (sessionId ??= String(await $.session.id())),
  };
}

function control($: Engine): SessionControl {
  return {
    abortTurn: async (turnId) => {
      await $.turn.abort({ turnId });
    },
    submitPrompt: async (text) => {
      await $.prompt.submit({ text, asUser: true });
    },
  };
}

/**
 * Cifras de la sesión que añade el mod al `Stop` (no son de los hooks de Claude Code): ventana de contexto
 * usada, cuándo empezó la sesión y cuánto lleva costado. Solo números; en ctx=work no salen (§3.4).
 */
export function sessionFigures(u: any): Record<string, unknown> {
  if (u === undefined || u === null) return {};
  const out: Record<string, unknown> = {};
  const c = u.context;
  if (c && typeof c.window === "number") {
    out.context = {
      window: c.window,
      ...(typeof c.tokens === "number" ? { tokens: c.tokens } : {}),
      ...(typeof c.percent === "number" ? { percent: c.percent } : {}),
    };
  }
  if (typeof u.startedAt === "number") out.session_started_ms = u.startedAt;
  if (u.cost && typeof u.cost.usd === "number") out.cost_usd = u.cost.usd;
  return out;
}

/**
 * Perfil de Claude Code, máquina y sesión de Remote Control (si está conectada), para que el reloj diga
 * dónde corre cada sesión y la abra en la app de Claude del teléfono (SPEC §8.3). En ctx=work no sale.
 */
async function sessionPlace($: Engine): Promise<Extra> {
  if (hostName === undefined) {
    const r = await $.process.run(["hostname", "-s"]).catch(() => undefined);
    hostName = typeof r?.stdout === "string" ? r.stdout.trim() : "";
  }
  const out: Extra = {
    orbit_where: { profile: profileOf(await $.env.get("CLAUDE_CONFIG_DIR")), ...(hostName ? { host: hostName } : {}) },
  };
  const bridge = await $.env.get("CLAUDE_CODE_BRIDGE_SESSION_ID");
  if (typeof bridge === "string" && /^[A-Za-z0-9_-]{4,128}$/.test(bridge)) out.orbit_remote = bridge;
  return out;
}

async function stopExtra($: Engine): Promise<Extra> {
  // Sin `$.session.usage` (versión del motor sin esa API) el Stop sale igual, sin cifras.
  const usage = await Promise.resolve().then(() => $.session.usage()).catch(() => undefined);
  return { ...sessionFigures(usage), ...(await sessionPlace($)) };
}

let transcript: string | undefined;
let transcriptFound = false;
let modeCache: { at: number; mode: string | undefined } | undefined;

/**
 * Modo de permisos actual de la sesión, leído de su transcripción (ver core/perm/mode.ts). Se cachea 2 s
 * (un turno puede pedir varios permisos seguidos). undefined si no se encuentra: se retiene como siempre.
 */
async function sessionMode($: Engine): Promise<string | undefined> {
  try {
    const now = Number(await $.clock.now());
    if (modeCache !== undefined && now - modeCache.at < 2_000) return modeCache.mode;
    const sid = await platform($).sessionId();
    if (transcript === undefined) {
      const home = await $.env.get("HOME");
      const configDir = (await $.env.get("CLAUDE_CONFIG_DIR")) || (home ? `${home}/.claude` : undefined);
      const cwd = await $.session.cwd();
      if (configDir === undefined || typeof cwd !== "string") return undefined;
      transcript = transcriptPath(configDir, cwd, sid);
    }
    let r = await $.process.run(modeGrepArgs(transcript));
    if (lastMode(r?.stdout) === undefined && !transcriptFound) {
      // La carpeta sale de la ruta real (/tmp → /private/tmp): se busca la transcripción por su nombre.
      const projects = transcript.slice(0, transcript.lastIndexOf("/projects/") + "/projects".length);
      const f = await $.process.run(["/usr/bin/find", projects, "-maxdepth", "2", "-name", `${sid}.jsonl`]);
      const found = typeof f?.stdout === "string" ? f.stdout.split("\n").find((l: string) => l.endsWith(".jsonl")) : undefined;
      if (found !== undefined) {
        transcript = found;
        r = await $.process.run(modeGrepArgs(found));
      }
    }
    const mode = lastMode(r?.stdout);
    if (mode !== undefined) transcriptFound = true;
    modeCache = { at: now, mode };
    return mode;
  } catch {
    return undefined;
  }
}

async function agentOf($: Engine, agentId: string): Promise<{ id: string; type?: string; description?: string } | undefined> {
  const found = (await $.agent.list()).find((a: any) => a.id === agentId);
  return found === undefined ? undefined : { id: found.id, type: found.type, description: found.description };
}

async function bashCwd($: Engine, e: any): Promise<string | undefined> {
  if (e.tool !== "Bash") return undefined;
  const cwd = await Promise.resolve().then(() => $.session.cwd()).catch(() => undefined);
  return typeof cwd === "string" ? cwd : undefined;
}

export function register(on: On, _options?: unknown): void {
  on("session.start", async ($, e, next) => {
    try {
      await $.command.register({ name: "nod", description: COMMAND_DESCRIPTION });
      sessionId = String(await $.session.id());
      await orbit.sessionStart(platform($), e, control($), await sessionPlace($));
    } catch (err) {
      $.ui.log(`nod: session.start falló (${String(err)})`, { to: "debug" });
    }
    return next(e);
  }).catch((_$, e, next) => next(e));

  on("command.run", { command: "nod" }, async ($, e) => ({ text: await orbit.command(platform($), String(e.args ?? "")) }));

  on("turn.start", async ($, e, next) => {
    await orbit.turnStart(platform($), e);
    return next(e);
  }).catch((_$, e, next) => next(e));

  on("agent.spawn", async ($, e, next) => {
    await orbit.agentSpawn(platform($), e);
    return next(e);
  }).catch((_$, e, next) => next(e));

  on("tool.call", async ($, e, next) => {
    await orbit.toolCall(platform($), e, (id) => agentOf($, id));
    const result = await next(e);
    return orbit.toolResult(platform($), e, result, await bashCwd($, e));
  }).catch((_$, e, next) => next(e));

  // En auto mode no se retiene: lo decide el clasificador después (el reloj no se llena de avisos que no piden nada).
  on("tool.check", async ($, e, next) => {
    const verdict = await next(e);
    const holds = verdict?.decision !== "ask" || holdsInMode(await sessionMode($));
    return orbit.toolCheck(platform($), e, verdict, next.signal, holds);
  }).catch((_$, e, next) => next(e));

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    await orbit.turnComplete(platform($), e, control($), () => stopExtra($));
    return result;
  }).catch((_$, e, next) => next(e));

  on("session.end", async ($, e, next) => {
    await orbit.sessionEnd(platform($), e);
    return next(e);
  }).catch((_$, e, next) => next(e));
}
