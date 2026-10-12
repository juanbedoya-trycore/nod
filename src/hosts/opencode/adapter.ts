// Adaptador de OpenCode (API de plugins, opencode >= 1.18): traduce lo que da OpenCode a NodEngine
// (../../core/engine.ts). Los nombres y campos están comprobados con tools/probe-opencode en opencode 1.18.34:
//
//   - bus de eventos (hook `event`, OpenCode no lo espera): session.created/updated/deleted/error/idle,
//     message.updated (asistente: modelo, tokens, error, finish), message.part.updated (step-start, step-finish
//     con tokens y costo, tool con su estado pending → running → completed | error, text), permission.asked,
//     permission.replied, vcs.branch.updated;
//   - hooks que OpenCode espera: chat.message (prompt), chat.params (ventana de contexto del modelo),
//     tool.execute.before (entrada de la tool), tool.execute.after (solo si terminó bien), command.execute.before,
//     config (para registrar /nod) y dispose (fin del proceso).
//
// Lo que OpenCode no da, no sale: no hay hook de decisión de permisos (`permission.ask` está en los tipos pero
// 1.18 no lo llama), así que las decisiones por política (reglas `allow`/`deny`) no se ven; no hay edición del
// prompt ni límites de uso. Un subagente es una sesión hija (la tool `task`): su id es el `agent` de Nod.
//
// Nunca lanza: un fallo de Nod no puede romper la sesión. El trabajo del motor va en su fila; aquí solo se
// traduce, en el orden en que llegan los eventos.
import { COMMAND_DESCRIPTION } from "../../core/engine.js";
import type { NodEngine } from "../../core/engine.js";
import { addUsage, ZERO_USAGE } from "../../core/events.js";
import type { Usage } from "../../core/events.js";
import type { SessionInfo, UsageSnapshot } from "../../core/normalize.js";
import type { Platform } from "../../core/platform.js";
import type { AbortLike } from "../../core/control/hold.js";

/** Cómo se lanzó OpenCode: la TUI (un humano delante), `opencode run` (contesta solo) o un servidor. */
export type RunMode = "tui" | "run" | "serve";

export interface RepoInfo {
  root?: string | undefined;
  remote?: string | undefined;
  name?: string | undefined;
  branch?: string | undefined;
}

/** Lo que el adaptador usa del cliente del SDK (`input.client`). Todo opcional: se comprueba al usarlo. */
export interface ClientLike {
  postSessionIdPermissionsPermissionId?: (o: { path: { id: string; permissionID: string }; body: { response: "once" | "always" | "reject" } }) => Promise<unknown>;
  session?: {
    abort?: (o: { path: { id: string } }) => Promise<unknown>;
    promptAsync?: (o: { path: { id: string }; body: { parts: { type: "text"; text: string }[] } }) => Promise<unknown>;
    get?: (o: { path: { id: string } }) => Promise<{ data?: { version?: unknown } | undefined } | undefined>;
  };
}

export interface AdapterDeps {
  engine: NodEngine;
  /** Platform sin `session` ni `info().hostVersion` (los pone el adaptador). */
  platform: Platform;
  /** Reloj del evento (milisegundos Unix). */
  clock: () => number;
  client: ClientLike;
  mode: RunMode;
  /** Directorio de la instancia de OpenCode (el del proyecto). */
  directory: string;
  repo?: RepoInfo | undefined;
}

/** Los hooks de OpenCode que usa Nod (`Hooks` de @opencode-ai/plugin). */
export interface NodHooks {
  event: (input: { event: { type: string; properties?: any } }) => Promise<void>;
  config: (cfg: any) => Promise<void>;
  "chat.message": (input: any, output: any) => Promise<void>;
  "chat.params": (input: any, output: any) => Promise<void>;
  "tool.execute.before": (input: any, output: any) => Promise<void>;
  "tool.execute.after": (input: any, output: any) => Promise<void>;
  "command.execute.before": (input: any, output: any) => Promise<void>;
  dispose: () => Promise<void>;
}

/** Agentes internos de OpenCode que llaman al modelo sin ser un paso de la sesión. */
const INTERNAL_AGENTS = new Set(["title", "summary", "compaction"]);
/** Lo que OpenCode pone como error de la tool cuando se niega su permiso. */
const REJECTED_RE = /^The user rejected permission to use this specific tool call/;
/** Topes de lo que se recuerda: una sesión larga no crece sin límite. */
const MAX_TRACKED = 512;

interface Sess {
  id: string;
  parent?: string | undefined;
  directory?: string | undefined;
  model?: string | undefined;
  version?: string | undefined;
  started: boolean;
  /** Turno en curso: el id del mensaje del usuario que lo abrió. */
  turn?: string | undefined;
  turnTs: number;
  turnUsage: Usage;
  stepIndex: number;
  /** Paso abierto (step-start sin step-finish): su mensaje. */
  stepMessage?: string | undefined;
  answer?: string | undefined;
  error?: string | undefined;
  finish?: string | undefined;
  /** Tokens del último paso (para el contexto) y ventana del modelo. */
  context?: number | undefined;
  window?: number | undefined;
  /** Costo de los pasos vistos en este proceso (la sesión y sus subagentes). */
  cost: number;
  /**
   * La sesión quedó inactiva con tools sin terminar (un turno cortado con Esc: OpenCode cierra la tool justo
   * después). El turno se cierra cuando acaban, o con lo siguiente que pase en la sesión.
   */
  closing: boolean;
}

interface ToolState {
  session: string;
  tool: string;
  input?: unknown;
  /** Hubo pregunta de permiso: su ejecución (time.start → end) incluye la espera. */
  asked: boolean;
  denied?: "user" | "policy" | undefined;
  done: boolean;
}

interface Perm {
  callID: string;
  session: string;
  tool: string;
  replied: boolean;
  abort: () => void;
}

const opt = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Tokens de OpenCode ({input, output, reasoning, cache: {read, write}}) en Nod: el razonamiento cuenta como salida. */
export function usageOfTokens(t: any, model?: string): Usage {
  const u: Usage = { input: num(t?.input), output: num(t?.output) + num(t?.reasoning), cache_read: num(t?.cache?.read), cache_write: num(t?.cache?.write) };
  if (model !== undefined) u.model = model;
  return u;
}

/** Tokens en el contexto tras un paso (como lo cuenta la TUI de OpenCode). */
function contextOf(t: any): number {
  return num(t?.input) + num(t?.output) + num(t?.reasoning) + num(t?.cache?.read) + num(t?.cache?.write);
}

function bound<K, V>(m: Map<K, V>): void {
  while (m.size > MAX_TRACKED) m.delete(m.keys().next().value as K);
}

class Signal implements AbortLike {
  aborted = false;
  private readonly cbs = new Set<() => void>();
  addEventListener(_t: "abort", cb: () => void): void {
    this.cbs.add(cb);
  }
  removeEventListener(_t: "abort", cb: () => void): void {
    this.cbs.delete(cb);
  }
  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const cb of [...this.cbs]) cb();
  }
}

export function createAdapter(deps: AdapterDeps): NodHooks {
  const { engine: nod, client, mode } = deps;
  const sessions = new Map<string, Sess>();
  const tools = new Map<string, ToolState>();
  const perms = new Map<string, Perm>();
  /** Las tools que pidió cada mensaje del asistente, por callID (para turn.step). */
  const messageTools = new Map<string, Map<string, string>>();
  const toolNames = (msg: string | undefined): string[] => [...((msg !== undefined ? messageTools.get(msg) : undefined)?.values() ?? [])];
  /** Modelo y tokens de cada mensaje del asistente. */
  const messages = new Map<string, { model?: string | undefined; tokens?: unknown }>();
  /** La última tool `task` de cada sesión: el subagente que crea es su sesión hija. */
  const pendingTask = new Map<string, { callID: string; description?: string | undefined; type?: string | undefined }>();
  /** Sesiones cuyo siguiente prompt sale de un comando. */
  const fromCommand = new Set<string>();
  let version: string | undefined;
  let repo: RepoInfo | undefined = deps.repo;
  /** Sesión principal más reciente (a la que Nod Control manda los mensajes). */
  let current: string | undefined;

  const p: Platform = {
    ...deps.platform,
    now: async () => deps.clock(),
    info: async () => {
      const base = await deps.platform.info();
      if (version === undefined && current !== undefined) {
        const r = await Promise.resolve().then(() => client.session?.get?.({ path: { id: current! } })).catch(() => undefined);
        version = opt(r?.data?.version);
      }
      return version === undefined ? base : { ...base, hostVersion: version };
    },
    session: {
      abortTurn: async (turnId) => {
        const s = [...sessions.values()].find((x) => x.turn === turnId) ?? (current !== undefined ? sessions.get(current) : undefined);
        if (s !== undefined) await client.session?.abort?.({ path: { id: s.id } });
      },
      submitPrompt: async (text) => {
        if (current !== undefined) await client.session?.promptAsync?.({ path: { id: current }, body: { parts: [{ type: "text", text }] } });
      },
    },
  };

  const log = (m: string) => {
    try {
      deps.platform.log(m);
    } catch {
      // sin registro
    }
  };

  function sess(id: string): Sess {
    let s = sessions.get(id);
    if (s === undefined) {
      s = { id, started: false, turnTs: 0, turnUsage: ZERO_USAGE, stepIndex: 0, cost: 0, closing: false };
      sessions.set(id, s);
      bound(sessions);
    }
    return s;
  }

  /** La sesión principal de la que cuelga (un subagente de un subagente sigue siendo de la misma). */
  function rootOf(id: string): string {
    let s = sessions.get(id);
    for (let i = 0; s?.parent !== undefined && i < 16; i++) {
      const up = sessions.get(s.parent);
      if (up === undefined) return s.parent;
      s = up;
    }
    return s?.id ?? id;
  }

  /** `agent` de Nod: el id de la sesión hija, o nada en la principal. */
  const agentOf = (id: string): string | undefined => (sessions.get(id)?.parent !== undefined ? id : undefined);

  function sessionInfo(s: Sess): SessionInfo {
    const info: SessionInfo = { interactive: mode === "tui", surface: mode === "tui" ? "terminal" : mode === "run" ? "cli" : "server" };
    const cwd = s.directory ?? deps.directory;
    if (cwd !== "") info.cwd = cwd;
    if (s.model !== undefined) info.model = s.model;
    if (repo !== undefined && (repo.root || repo.name)) {
      info.repo = { root: repo.root ?? null, remote: repo.remote ?? null, name: repo.name ?? null, branch: repo.branch ?? null };
    }
    return info;
  }

  /** Abre la sesión principal la primera vez que hace algo (así ya se sabe su modelo). */
  function ensure(id: string): string {
    const root = rootOf(id);
    const s = sess(root);
    if (!s.started) {
      s.started = true;
      current = root;
      void nod.sessionStart(p, root, sessionInfo(s));
    }
    return root;
  }

  function remember(info: any): void {
    const id = opt(info?.id);
    if (id === undefined) return;
    const s = sess(id);
    if (opt(info.parentID) !== undefined) s.parent = info.parentID;
    if (opt(info.directory) !== undefined) s.directory = info.directory;
    if (opt(info.model?.id) !== undefined) s.model = info.model.id;
    if (opt(info.version) !== undefined) version = info.version;
  }

  /** Tools de la sesión que empezaron y aún no terminaron. */
  const running = (sid: string) => [...tools.values()].some((t) => t.session === sid && !t.done);

  /** Fin del turno al quedar inactiva la sesión; si le quedan tools por cerrar, cuando acaben. */
  function idle(s: Sess): void {
    if (s.turn === undefined) return;
    if (running(s.id)) s.closing = true;
    else endTurn(s);
  }

  function endTurn(s: Sess): void {
    s.closing = false;
    const turn = s.turn;
    if (turn === undefined) return;
    // Lo que no terminó ya no va a cerrar en este turno: no retiene el fin de los siguientes.
    for (const t of tools.values()) if (t.session === s.id) t.done = true;
    const root = rootOf(s.id);
    const agent = agentOf(s.id);
    // Paso cortado (Esc, error): sin step-finish. Sale sin motivo de parada, con lo que contó el mensaje.
    if (s.stepMessage !== undefined) {
      const m = messages.get(s.stepMessage);
      const usage = usageOfTokens(m?.tokens, m?.model ?? s.model);
      void nod.step(p, root, { turn, agent, index: s.stepIndex++, model: m?.model ?? s.model, tools: toolNames(s.stepMessage), usage });
      s.turnUsage = addUsage(s.turnUsage, usage);
      s.stepMessage = undefined;
    }
    const outcome = s.error === "MessageAbortedError" ? "aborted" : s.error !== undefined ? "error" : s.finish === undefined || s.finish === "stop" ? "answer" : s.finish;
    const snapshot = (): Promise<UsageSnapshot | undefined> => {
      const out: UsageSnapshot = { cost_usd: s.cost };
      if (s.context !== undefined && s.window !== undefined && s.window > 0) {
        out.context = { tokens: s.context, window: s.window, percent: Math.round((s.context / s.window) * 100) };
      }
      return Promise.resolve(out);
    };
    void nod.turnEnd(p, root, { turn, agent, durationMs: Math.max(0, deps.clock() - s.turnTs), outcome, usage: s.turnUsage, answer: s.answer }, agent === undefined ? snapshot : undefined);
    s.turn = undefined;
    s.turnUsage = ZERO_USAGE;
    s.stepIndex = 0;
    s.answer = undefined;
    s.error = undefined;
    s.finish = undefined;
  }

  function onPart(sid: string, part: any): void {
    const s = sess(sid);
    const msg = opt(part?.messageID);
    switch (part?.type) {
      case "step-start":
        if (s.turn === undefined || msg === undefined) return;
        ensure(sid);
        s.stepMessage = msg;
        void nod.stepBegin(p, s.turn, agentOf(sid));
        return;
      case "step-finish": {
        if (s.turn === undefined) return;
        const root = ensure(sid);
        const model = (msg !== undefined ? messages.get(msg)?.model : undefined) ?? s.model;
        const usage = usageOfTokens(part.tokens, model);
        s.turnUsage = addUsage(s.turnUsage, usage);
        s.context = contextOf(part.tokens);
        sess(root).cost += num(part.cost);
        if (agentOf(sid) === undefined) sess(root).context = s.context;
        void nod.step(p, root, { turn: s.turn, agent: agentOf(sid), index: s.stepIndex++, model, stopReason: opt(part.reason) ?? "unknown", tools: toolNames(msg), usage });
        s.stepMessage = undefined;
        return;
      }
      case "text":
        if (part.synthetic !== true && typeof part.text === "string" && msg !== undefined && messages.has(msg)) s.answer = part.text;
        return;
      case "tool":
        onToolPart(sid, msg, part);
        return;
      default:
        return;
    }
  }

  function onToolPart(sid: string, msg: string | undefined, part: any): void {
    const callID = opt(part.callID);
    const name = opt(part.tool) ?? "?";
    if (callID === undefined) return;
    if (msg !== undefined) {
      const calls = messageTools.get(msg) ?? new Map<string, string>();
      calls.set(callID, name);
      messageTools.set(msg, calls);
      bound(messageTools);
    }
    const st = part.state ?? {};
    let t = tools.get(callID);
    if (t === undefined && (st.status === "running" || st.status === "completed" || st.status === "error")) {
      // Sin tool.execute.before (otro plugin falló antes, o una tool que no pasa por él): se abre aquí.
      t = { session: sid, tool: name, input: st.input, asked: false, done: false };
      tools.set(callID, t);
      bound(tools);
      void nod.toolCall(p, ensure(sid), { toolUseId: callID, tool: name, input: st.input, agent: agentOf(sid) });
    }
    if (t === undefined || t.done || (st.status !== "completed" && st.status !== "error")) return;
    t.done = true;
    const root = ensure(sid);
    const ok = st.status === "completed";
    const text = ok ? (typeof st.output === "string" ? st.output : "") : typeof st.error === "string" ? st.error : "";
    // Negado por el humano: lo dice su respuesta; si se perdió, el error que OpenCode da a la tool.
    const rejected = !ok && (t.denied === "user" || (t.denied === undefined && mode !== "run" && REJECTED_RE.test(text)));
    const start = num(st.time?.start);
    const end = num(st.time?.end);
    // Sin pregunta de permiso, la ejecución es la que mide OpenCode; con pregunta, incluye la espera.
    if (!t.asked && start > 0 && end >= start) void nod.toolExec(p, callID, end - start);
    void nod.toolResult(p, root, { toolUseId: callID, tool: t.tool, ok, rejected, outputChars: text.length, output: t.tool === "bash" ? text.slice(0, 2000) : undefined });
    const s = sessions.get(t.session);
    if (s?.closing === true && !running(s.id)) endTurn(s);
  }

  function onAsked(props: any): void {
    const id = opt(props?.id);
    const sid = opt(props?.sessionID);
    const callID = opt(props?.tool?.callID);
    // Un permiso que no es de una tool (no tiene callID) no tiene a qué asociarse en Nod v1.
    if (id === undefined || sid === undefined || callID === undefined) return;
    const t = tools.get(callID);
    if (t !== undefined) t.asked = true;
    const tool = t?.tool ?? opt(props.permission) ?? "?";
    const signal = new Signal();
    const perm: Perm = { callID, session: sid, tool, replied: false, abort: () => signal.abort() };
    perms.set(id, perm);
    bound(perms);
    // `opencode run` contesta él mismo al instante (rechaza, o aprueba con --auto): nadie llega a ver la pregunta.
    if (mode === "run") return;
    const root = ensure(sid);
    void nod.toolCheck(p, root, callID, tool, "ask");
    // Nod Control: mientras el humano no conteste, un aprobador remoto puede decidir. Lo primero que llegue gana.
    void (async () => {
      const d = await nod.checkPermission(p, root, { toolUseId: callID, tool, input: t?.input, agent: agentOf(sid) }, signal, async () => undefined);
      if (d === undefined || perm.replied) return;
      if (d === "deny" && t !== undefined) t.denied = "user";
      await client.postSessionIdPermissionsPermissionId?.({ path: { id: sid, permissionID: id }, body: { response: d === "allow" ? "once" : "reject" } });
    })().catch((err) => log(`nod: respuesta al permiso falló (${String(err)})`));
  }

  function onReplied(props: any): void {
    const perm = perms.get(opt(props?.requestID) ?? "");
    if (perm === undefined) return;
    perm.replied = true;
    perm.abort();
    perms.delete(opt(props.requestID)!);
    const decision = props.reply === "reject" ? "deny" : "allow";
    const by = mode === "run" ? "policy" : "user";
    const t = tools.get(perm.callID);
    if (decision === "deny" && t !== undefined) t.denied ??= by;
    void nod.permissionDecided(p, ensure(perm.session), perm.callID, perm.tool, decision, by);
  }

  function onEvent(type: string, props: any): void {
    switch (type) {
      case "session.created":
      case "session.updated": {
        const info = props?.info;
        const known = sessions.has(opt(info?.id) ?? "");
        remember(info);
        const id = opt(info?.id);
        if (type === "session.created" && id !== undefined && !known && opt(info.parentID) !== undefined) {
          const pt = pendingTask.get(info.parentID);
          pendingTask.delete(info.parentID);
          void nod.agentSpawn(p, ensure(info.parentID), { agent: id, type: opt(info.agent) ?? pt?.type ?? "agent", description: pt?.description, background: false, toolUseId: pt?.callID });
        }
        return;
      }
      case "session.deleted": {
        const id = opt(props?.info?.id) ?? opt(props?.sessionID);
        const s = id !== undefined ? sessions.get(id) : undefined;
        if (s?.started === true) {
          s.started = false;
          void nod.sessionEnd(p, s.id, "deleted");
        }
        return;
      }
      case "session.error": {
        const sid = opt(props?.sessionID);
        if (sid !== undefined && sessions.get(sid)?.turn !== undefined) sess(sid).error = opt(props?.error?.name) ?? "error";
        return;
      }
      case "session.idle": {
        const sid = opt(props?.sessionID);
        if (sid !== undefined && sessions.has(sid)) idle(sess(sid));
        return;
      }
      case "message.updated": {
        const info = props?.info;
        if (info?.role !== "assistant" || opt(info.id) === undefined) return;
        messages.set(info.id, { model: opt(info.modelID), tokens: info.tokens });
        bound(messages);
        if (opt(info.sessionID) === undefined) return;
        const s = sess(info.sessionID);
        if (opt(info.modelID) !== undefined && s.parent === undefined) s.model = info.modelID;
        if (opt(info.error?.name) !== undefined) s.error = info.error.name;
        if (opt(info.finish) !== undefined) s.finish = info.finish;
        return;
      }
      case "message.part.updated": {
        const sid = opt(props?.part?.sessionID) ?? opt(props?.sessionID);
        if (sid !== undefined) onPart(sid, props.part);
        return;
      }
      case "permission.asked":
        onAsked(props);
        return;
      case "permission.replied":
        onReplied(props);
        return;
      case "vcs.branch.updated":
        if (repo !== undefined && opt(props?.branch) !== undefined) repo = { ...repo, branch: props.branch };
        return;
      default:
        return;
    }
  }

  /** Cada hook, envuelto: nunca lanza ni rompe la sesión. */
  const safe = <A extends unknown[]>(label: string, f: (...a: A) => void | Promise<void>) => async (...a: A): Promise<void> => {
    try {
      await f(...a);
    } catch (err) {
      log(`nod: ${label} falló (${String(err)})`);
    }
  };

  return {
    event: safe("event", ({ event }) => onEvent(String(event?.type), event?.properties)),

    // /nod: OpenCode no deja que un comando conteste sin el modelo. Se registra un comando cuyo prompt se
    // sustituye (command.execute.before) por la respuesta de Nod, con la orden de mostrarla tal cual.
    config: safe("config", (cfg: any) => {
      if (cfg === null || typeof cfg !== "object") return;
      cfg.command ??= {};
      cfg.command.nod ??= { template: "$ARGUMENTS", description: COMMAND_DESCRIPTION };
    }),

    "chat.message": safe("chat.message", (input, output) => {
      const sid = opt(input?.sessionID) ?? opt(output?.message?.sessionID);
      const id = opt(output?.message?.id) ?? opt(input?.messageID);
      if (sid === undefined || id === undefined) return;
      const s = sess(sid);
      if (s.closing) endTurn(s);
      if (opt(input?.model?.modelID) !== undefined && s.parent === undefined) s.model = input.model.modelID;
      if (s.parent !== undefined) {
        // El prompt de un subagente lo escribe el agente: no es del humano. Solo abre su turno.
        if (s.turn === undefined) {
          s.turn = id;
          s.turnTs = deps.clock();
        }
        return;
      }
      const root = ensure(sid);
      const parts: any[] = Array.isArray(output?.parts) ? output.parts : [];
      const text = parts.filter((x) => x?.type === "text" && x.synthetic !== true && typeof x.text === "string").map((x) => x.text as string).join("\n");
      const origin = fromCommand.delete(sid) ? "command" : mode === "run" ? "cli" : mode === "serve" ? "api" : "composer";
      void nod.promptSubmit(p, root, text, origin);
      // Un prompt que llega con el turno en marcha entra en el mismo bucle del agente.
      if (s.turn === undefined) {
        s.turn = id;
        s.turnTs = deps.clock();
        void nod.turnStart(p, root, id);
      }
    }),

    "chat.params": safe("chat.params", (input) => {
      const sid = opt(input?.sessionID);
      const window = input?.model?.limit?.context;
      // La ventana del modelo de la sesión principal (no la del modelo pequeño que pone títulos).
      if (sid !== undefined && typeof window === "number" && window > 0 && !INTERNAL_AGENTS.has(String(input?.agent)) && sessions.get(sid)?.parent === undefined) sess(sid).window = window;
    }),

    "tool.execute.before": safe("tool.execute.before", (input, output) => {
      const sid = opt(input?.sessionID);
      const callID = opt(input?.callID);
      const tool = opt(input?.tool) ?? "?";
      if (sid === undefined || callID === undefined || tools.has(callID)) return;
      const args = output?.args;
      tools.set(callID, { session: sid, tool, input: args, asked: false, done: false });
      bound(tools);
      if (tool === "task") pendingTask.set(sid, { callID, description: opt(args?.description), type: opt(args?.subagent_type) });
      void nod.toolCall(p, ensure(sid), { toolUseId: callID, tool, input: args, agent: agentOf(sid) });
    }),

    // Un mensaje de un aprobador llegado a mitad de turno: el modelo lo lee con este resultado, sin esperar.
    "tool.execute.after": safe("tool.execute.after", (input, output) => {
      const sid = opt(input?.sessionID);
      if (sid === undefined || output === null || typeof output !== "object") return;
      const note = nod.takeNote(agentOf(sid));
      if (note !== undefined) output.output = `${typeof output.output === "string" ? output.output : ""}\n\n${note}`;
    }),

    "command.execute.before": safe("command.execute.before", async (input, output) => {
      const sid = opt(input?.sessionID);
      const name = opt(input?.command);
      if (sid === undefined || name === undefined) return;
      fromCommand.add(sid);
      if (name !== "nod") {
        void nod.command(p, ensure(sid), name);
        return;
      }
      const text = await nod.runCommand(p, rootOf(sid), String(input?.arguments ?? ""));
      // OpenCode usa el mismo array después del hook: se cambia su contenido, no la referencia.
      if (Array.isArray(output?.parts)) {
        output.parts.splice(0, output.parts.length, {
          type: "text",
          text: `Muestra al usuario este texto de Nod exactamente como está, dentro de un bloque de código y sin añadir nada más:\n\n${text}`,
        });
      }
    }),

    // Fin del proceso (o de la instancia del proyecto): se cierran sus sesiones y se entrega lo pendiente.
    dispose: safe("dispose", async () => {
      const open = [...sessions.values()].filter((s) => s.started && s.parent === undefined && (s.directory === undefined || s.directory === deps.directory));
      for (const s of open) {
        s.started = false;
        if (s.turn !== undefined) {
          s.error ??= "MessageAbortedError";
          endTurn(s);
        }
        await nod.sessionEnd(p, s.id, "exit");
      }
    }),
  };
}
