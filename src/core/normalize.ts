// Del agente a Nod v1: el adaptador llama a estos métodos con lo que ve su motor (ya traducido a nombres
// neutros) y el normalizador devuelve los eventos (sin numerar). Aquí se derivan las señales que no da
// ningún hook: quién decidió cada permiso y cuánto se esperó al humano, si el prompt se reescribió o salió
// del historial, el costo acumulado de cada subagente.
import { addUsage, ZERO_USAGE } from "./events.js";
import { linksOf } from "./links.js";
import type { Draft, EventType, Usage } from "./events.js";

export interface SessionInfo {
  cwd?: string | undefined;
  repo?: { root?: string | null; remote?: string | null; name?: string | null; branch?: string | null } | undefined;
  model?: string | undefined;
  interactive?: boolean | undefined;
  surface?: string | undefined;
  /** Sesión de Remote Control de claude.ai, si la hay: deja abrir esta sesión en la app de Claude. */
  remoteSession?: string | undefined;
}

/** Una pulsación o pegado en el editor de prompts: texto previo, rango sustituido y lo insertado. */
export interface PromptEdit {
  before: string;
  start: number;
  end: number;
  inserted: string;
}

export interface StepInfo {
  turn: string;
  agent?: string | undefined;
  index: number;
  model?: string | undefined;
  effort?: string | undefined;
  stopReason?: string | undefined;
  tools: string[];
  usage?: Usage | undefined;
}

export interface TurnEndInfo {
  turn: string;
  agent?: string | undefined;
  durationMs?: number | undefined;
  outcome: string;
  usage?: Usage | undefined;
  answer?: string | undefined;
}

export interface ToolCallInfo {
  toolUseId: string;
  tool: string;
  input?: unknown;
  agent?: string | undefined;
}

export type CheckDecision = "allow" | "deny" | "ask";

export interface ToolResultInfo {
  toolUseId: string;
  tool: string;
  ok: boolean;
  /** El humano negó el permiso (el agente lo devuelve como resultado de la tool). */
  rejected: boolean;
  outputChars: number;
  /** Comienzo de la salida (no se emite): sirve para reconocer el commit de un `git commit` y los enlaces. */
  output?: string | undefined;
}

export interface UsageSnapshot {
  /** Sesión de Remote Control (puede conectarse a mitad de sesión). */
  remote_session?: string | undefined;
  context?: { tokens?: number; window?: number; percent?: number } | undefined;
  limits?: { kind: string; percent_used: number; resets_at?: string }[] | undefined;
  cost_usd?: number | undefined;
}

interface PendingTool {
  tool: string;
  /** Entrada de la tool (para reconocer un `git commit`). */
  input?: unknown;
  agent: string | undefined;
  turn: string | undefined;
  callTs: number;
  askTs?: number;
  decidedTs?: number;
  /** Duración de la ejecución según el agente (en Claude, el hook clásico PostToolUse). */
  execMs?: number;
}

interface AgentRun {
  spawnTs: number;
  usage: Usage;
}

/** Cuántos prompts recientes se recuerdan para reconocer uno sacado del historial. */
const RECALL_MEMORY = 50;
/** Tope de subagentes recordados (para su agent.end): una sesión larga no crece sin límite. */
const MAX_AGENTS = 256;

/**
 * Primera palabra de un comando de shell, sin asignaciones de variables ni envoltorios (`FOO=1 sudo npm test`
 * → `npm`). Solo si es un nombre de programa limpio: con comillas, subshell, variables o rutas raras devuelve
 * undefined (podría arrastrar un trozo de secreto o el nombre de un fichero del cliente).
 */
export function verbOf(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  for (const w of command.trim().split(/\s+/)) {
    if (w === "") continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      // Una asignación con comillas puede seguir en las palabras siguientes: no se adivina.
      if (/['"`$(]/.test(w)) return undefined;
      continue;
    }
    if (w === "sudo" || w === "env" || w === "exec" || w === "time" || w === "nohup") continue;
    const base = w.includes("/") ? w.slice(w.lastIndexOf("/") + 1) : w;
    // Un script propio (`deploy-acme.sh`) dice más de lo que debe: solo nombres de programa sin extensión de script.
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(base) || /\.(sh|py|rb|js|ts|pl|bash|zsh)$/i.test(base)) return undefined;
    return base;
  }
  return undefined;
}

/** Id de ticket en un nombre de rama (`feature/ABC-123-login` → `ABC-123`). */
export function taskFromBranch(branch: string | undefined | null): string | undefined {
  const m = branch ? /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]+-[0-9]+)(?![0-9])/.exec(branch) : null;
  return m?.[1];
}

/** Rama a partir del contenido de `.git/HEAD` (`ref: refs/heads/x`); undefined si HEAD está suelto. */
export function branchFromHead(head: string | undefined): string | undefined {
  const m = head ? /^ref: refs\/heads\/(.+)$/m.exec(head.trim()) : null;
  return m?.[1];
}

/**
 * El commit que creó un `git commit` lanzado por Bash, a partir de su salida (`[rama abc1234] mensaje` y
 * `N files changed`). Solo si el comando es un git commit: otro comando que imprima algo parecido no cuenta.
 */
export function commitOf(input: unknown, output: string | undefined): { sha: string; branch?: string; files?: number } | undefined {
  const command = (input as { command?: unknown } | undefined)?.command;
  if (typeof command !== "string" || !/(^|[;&|(\s])git(\s+-[cC]\s+\S+)*\s+commit(\s|$)/.test(command) || output === undefined) return undefined;
  const m = /^\[([^\s\]]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\]/m.exec(output);
  if (m === null) return undefined;
  const out: { sha: string; branch?: string; files?: number } = { sha: m[2]! };
  if (m[1] !== "detached") out.branch = m[1]!;
  const f = /(\d+) files? changed/.exec(output);
  if (f !== null) out.files = Number(f[1]);
  return out;
}

function linksField(tool: string, input: unknown, r: ToolResultInfo, cwd: string | undefined): Record<string, unknown> {
  if (!r.ok || r.rejected) return {};
  const links = linksOf(tool, input, r.output, false, cwd);
  return links.length === 0 ? {} : { links };
}

export class Normalizer {
  /** Tarea en curso (§5): va en todos los eventos. */
  task: string | undefined;
  private sessionStartTs: number | undefined;
  /** Nombre del repo de la sesión (va en vcs.commit). */
  private repoName: string | undefined;
  /** Directorio de la sesión: resuelve las rutas relativas de los ficheros que genera Bash. */
  private cwd: string | undefined;
  private readonly tools = new Map<string, PendingTool>();
  private readonly agents = new Map<string, AgentRun>();
  private readonly turnSteps = new Map<string, number>();
  /** Turno en curso de la sesión principal (clave "") y de cada subagente. */
  private readonly current = new Map<string, string>();
  private edit: { first: number; events: number; recalled: boolean; revised: boolean } | undefined;
  private readonly recent: string[] = [];

  private draft(ts: number, type: EventType, session: string, data: Record<string, unknown>, at: { turn?: string | undefined; agent?: string | undefined } = {}): Draft {
    const d: Draft = { ts, type, session, data };
    if (at.turn !== undefined) d.turn = at.turn;
    if (at.agent !== undefined) d.agent = at.agent;
    if (this.task !== undefined) d.task = this.task;
    return d;
  }

  /** Olvida lo propio de la sesión anterior (tools, turnos, subagentes, lo tecleado). La tarea sigue. */
  resetSession(): void {
    this.tools.clear();
    this.agents.clear();
    this.turnSteps.clear();
    this.current.clear();
    this.edit = undefined;
    this.sessionStartTs = undefined;
  }

  sessionStart(ts: number, session: string, info: SessionInfo): Draft[] {
    this.resetSession();
    this.sessionStartTs = ts;
    this.repoName = info.repo?.name ?? undefined;
    this.cwd = info.cwd;
    const data: Record<string, unknown> = { interactive: info.interactive === true };
    if (info.cwd !== undefined) data.cwd = info.cwd;
    if (info.repo !== undefined) {
      const repo: Record<string, unknown> = {};
      if (info.repo.root) repo.root = info.repo.root;
      if (info.repo.remote) repo.remote = info.repo.remote;
      if (info.repo.name) repo.name = info.repo.name;
      if (info.repo.branch) repo.branch = info.repo.branch;
      if (Object.keys(repo).length > 0) data.repo = repo;
    }
    if (info.model !== undefined) data.model = info.model;
    if (info.surface !== undefined) data.surface = info.surface;
    if (info.remoteSession !== undefined) data.remote_session = info.remoteSession;
    return [this.draft(ts, "session.start", session, data)];
  }

  /** Cada cambio en el editor de prompts. No emite: se resume en el siguiente `prompt.submit`. */
  promptEdit(ts: number, e: PromptEdit): void {
    if (this.edit === undefined) {
      // La primera edición parte de un texto previo igual a un prompt ya enviado: salió del historial.
      const recalled = e.before.trim() !== "" && this.recent.includes(e.before.trim());
      this.edit = { first: ts, events: 0, recalled, revised: false };
    }
    this.edit.events++;
    if (e.end > e.start) this.edit.revised = true;
  }

  promptSubmit(ts: number, session: string, p: { text: string; origin: string }): Draft[] {
    const data: Record<string, unknown> = { origin: p.origin, chars: p.text.length, text: p.text };
    // Solo un prompt del humano (el editor) se lleva lo que se tecleó; los que mete el agente no lo tocan.
    if (p.origin === "composer") {
      if (this.edit !== undefined) {
        data.edit = { events: this.edit.events, typing_ms: Math.max(0, ts - this.edit.first), recalled: this.edit.recalled, revised: this.edit.revised };
      }
      this.edit = undefined;
    }
    const t = p.text.trim();
    if (t !== "") {
      const i = this.recent.indexOf(t);
      if (i >= 0) this.recent.splice(i, 1);
      this.recent.push(t);
      if (this.recent.length > RECALL_MEMORY) this.recent.shift();
    }
    return [this.draft(ts, "prompt.submit", session, data)];
  }

  turnStart(ts: number, session: string, turn: string, agent?: string): Draft[] {
    this.turnSteps.set(turn, 0);
    this.current.set(agent ?? "", turn);
    return [this.draft(ts, "turn.start", session, {}, { turn, agent })];
  }

  /**
   * Empieza una llamada al modelo. Los subagentes no tienen turn.start: su turno se conoce aquí, antes de las
   * tools que pida esta llamada.
   */
  stepBegin(turn: string, agent: string | undefined): void {
    this.current.set(agent ?? "", turn);
  }

  step(ts: number, session: string, s: StepInfo): Draft[] {
    this.turnSteps.set(s.turn, (this.turnSteps.get(s.turn) ?? 0) + 1);
    this.current.set(s.agent ?? "", s.turn);
    if (s.agent !== undefined) {
      const run = this.agents.get(s.agent);
      if (run !== undefined) run.usage = addUsage(run.usage, s.usage);
    }
    const data: Record<string, unknown> = { index: s.index, tools: s.tools, usage: s.usage ?? ZERO_USAGE };
    if (s.model !== undefined) data.model = s.model;
    if (s.effort !== undefined) data.effort = s.effort;
    if (s.stopReason !== undefined) data.stop_reason = s.stopReason;
    // Sin motivo de parada la llamada se cortó (Esc): el agente solo cuenta lo que llegó a generar.
    else data.partial = true;
    return [this.draft(ts, "turn.step", session, data, { turn: s.turn, agent: s.agent })];
  }

  turnEnd(ts: number, session: string, t: TurnEndInfo): Draft[] {
    const out: Draft[] = [];
    // Permisos que quedaron preguntados al cerrar el turno (Esc en el diálogo, turno cortado): los negó el humano.
    for (const [id, p] of this.tools) {
      if (p.turn === t.turn && p.askTs !== undefined && p.decidedTs === undefined) {
        out.push(this.decision(ts, session, id, p, "deny", "user"));
        this.tools.delete(id);
      }
    }
    const data: Record<string, unknown> = {
      outcome: t.outcome,
      usage: t.usage ?? ZERO_USAGE,
      steps: this.turnSteps.get(t.turn) ?? 0,
      answer_chars: t.answer?.length ?? 0,
    };
    if (t.durationMs !== undefined) data.duration_ms = t.durationMs;
    if (t.answer !== undefined && t.answer !== "") data.answer = t.answer;
    this.turnSteps.delete(t.turn);
    // Tools del turno que no llegaron a terminar (turno cortado): ya no van a cerrar.
    for (const [id, p] of this.tools) if (p.turn === t.turn) this.tools.delete(id);
    if (this.current.get(t.agent ?? "") === t.turn) this.current.delete(t.agent ?? "");
    out.push(this.draft(ts, "turn.end", session, data, { turn: t.turn, agent: t.agent }));
    if (t.agent !== undefined) {
      const run = this.agents.get(t.agent);
      if (run !== undefined) {
        // Un subagente suele tener un solo turno; si tiene más, cada agent.end lleva el acumulado (vale el último).
        out.push(this.draft(ts, "agent.end", session, { agent: t.agent, duration_ms: Math.max(0, ts - run.spawnTs), usage: run.usage }, { agent: t.agent }));
      }
    }
    return out;
  }

  toolCall(ts: number, session: string, c: ToolCallInfo): Draft[] {
    const turn = this.current.get(c.agent ?? "");
    this.tools.set(c.toolUseId, { tool: c.tool, input: c.input, agent: c.agent, turn, callTs: ts });
    const data: Record<string, unknown> = { tool_use_id: c.toolUseId, tool: c.tool };
    const input = c.input as Record<string, unknown> | undefined;
    const verb = verbOf(input?.command);
    if (verb !== undefined) data.verb = verb;
    if (input !== undefined) data.input = input;
    return [this.draft(ts, "tool.call", session, data, { turn, agent: c.agent })];
  }

  /**
   * Lo que decidió el agente sobre el permiso de una tool (antes de preguntar a nadie). `checkMs`: cuánto tardó
   * en decidir (normalmente nada; mucho si otro mod retuvo el permiso).
   */
  toolCheck(ts: number, session: string, id: string, tool: string, decision: CheckDecision, reason?: string, checkMs?: number): Draft[] {
    let p = this.tools.get(id);
    if (p === undefined) {
      p = { tool, agent: undefined, turn: undefined, callTs: ts };
      this.tools.set(id, p);
    }
    if (decision === "ask") {
      p.askTs = ts;
      const data: Record<string, unknown> = { tool_use_id: id, tool };
      if (reason !== undefined && reason !== "") data.reason = reason;
      if (checkMs !== undefined) data.check_ms = checkMs;
      return [this.draft(ts, "permission.request", session, data, { turn: p.turn, agent: p.agent })];
    }
    const d = this.decision(ts, session, id, p, decision, "policy");
    if (checkMs !== undefined) d.data.check_ms = checkMs;
    return [d];
  }

  /** El agente dice cuánto tardó la ejecución de la tool (llega antes que su resultado). */
  toolExec(id: string, ms: number): void {
    const p = this.tools.get(id);
    if (p !== undefined && Number.isFinite(ms) && ms >= 0) p.execMs = ms;
  }

  /** Un aprobador remoto (canal de control) decidió un permiso preguntado. */
  remoteDecision(ts: number, session: string, id: string, decision: "allow" | "deny"): Draft[] {
    const p = this.tools.get(id);
    if (p === undefined || p.askTs === undefined || p.decidedTs !== undefined) return [];
    return [this.decision(ts, session, id, p, decision, "remote")];
  }

  /**
   * El agente avisa de quién decidió un permiso y en qué instante (OpenCode publica la respuesta). Con eso no hace
   * falta deducirla del resultado de la tool: la espera es exacta. Si ya estaba decidido (p. ej. por un aprobador
   * remoto, cuya respuesta vuelve luego como la de cualquiera), no emite nada.
   */
  decided(ts: number, session: string, id: string, tool: string, decision: "allow" | "deny", by: "user" | "policy"): Draft[] {
    let p = this.tools.get(id);
    if (p === undefined) {
      p = { tool, agent: undefined, turn: undefined, callTs: ts };
      this.tools.set(id, p);
    }
    if (p.decidedTs !== undefined) return [];
    return [this.decision(ts, session, id, p, decision, by)];
  }

  /** `exact` = false: el instante de la respuesta no se vio y `wait_ms` es una cota superior. */
  private decision(ts: number, session: string, id: string, p: PendingTool, decision: "allow" | "deny", by: string, exact = true): Draft {
    p.decidedTs = ts;
    const wait = p.askTs === undefined ? 0 : Math.max(0, ts - p.askTs);
    return this.draft(ts, "permission.decision", session, { tool_use_id: id, tool: p.tool, decision, by, wait_ms: wait, exact }, { turn: p.turn, agent: p.agent });
  }

  toolResult(ts: number, session: string, r: ToolResultInfo): Draft[] {
    const out: Draft[] = [];
    const p = this.tools.get(r.toolUseId) ?? { tool: r.tool, agent: undefined, turn: undefined, callTs: ts };
    // Preguntado y sin decisión registrada: la tool llegó a su fin, así que contestó el humano. El instante de su
    // respuesta es el fin menos lo que tardó la ejecución; si el agente no lo dice, el fin (cota superior).
    if (p.askTs !== undefined && p.decidedTs === undefined) {
      const exact = r.rejected || p.execMs !== undefined;
      const at = r.rejected || p.execMs === undefined ? ts : Math.max(p.askTs, ts - p.execMs);
      out.push(this.decision(at, session, r.toolUseId, p, r.rejected ? "deny" : "allow", "user", exact));
    }
    const began = Math.max(p.callTs, p.decidedTs ?? p.callTs);
    out.push(this.draft(ts, "tool.result", session, {
      tool_use_id: r.toolUseId,
      tool: r.tool,
      duration_ms: r.rejected ? 0 : p.execMs ?? Math.max(0, ts - began),
      ok: r.ok && !r.rejected,
      rejected: r.rejected,
      output_chars: r.outputChars,
      ...linksField(p.tool, p.input, r, this.cwd),
    }, { turn: p.turn, agent: p.agent }));
    const commit = r.ok && !r.rejected ? commitOf(p.input, r.output) : undefined;
    if (commit !== undefined) {
      const data: Record<string, unknown> = { sha: commit.sha, tool_use_id: r.toolUseId };
      if (commit.branch !== undefined) data.branch = commit.branch;
      if (commit.files !== undefined) data.files = commit.files;
      if (this.repoName !== undefined) data.repo = this.repoName;
      out.push(this.draft(ts, "vcs.commit", session, data, { turn: p.turn, agent: p.agent }));
    }
    this.tools.delete(r.toolUseId);
    return out;
  }

  agentSpawn(ts: number, session: string, a: { agent: string; type?: string | undefined; description?: string | undefined; background?: boolean | undefined; fork?: boolean | undefined; permissionMode?: string | undefined; model?: string | undefined; toolUseId?: string | undefined }): Draft[] {
    this.agents.set(a.agent, { spawnTs: ts, usage: ZERO_USAGE });
    if (this.agents.size > MAX_AGENTS) this.agents.delete(this.agents.keys().next().value!);
    const data: Record<string, unknown> = { agent: a.agent, type: a.type ?? "agent", background: a.background === true };
    if (a.fork !== undefined) data.fork = a.fork;
    if (a.permissionMode !== undefined) data.permission_mode = a.permissionMode;
    if (a.description !== undefined) data.description = a.description;
    if (a.model !== undefined) data.model = a.model;
    if (a.toolUseId !== undefined) data.tool_use_id = a.toolUseId;
    // `turn`: el turno de la sesión principal que lanzó el subagente.
    return [this.draft(ts, "agent.spawn", session, data, { agent: a.agent, turn: this.current.get("") })];
  }

  usage(ts: number, session: string, u: UsageSnapshot): Draft[] {
    const data: Record<string, unknown> = {};
    if (u.context !== undefined) data.context = u.context;
    if (u.limits !== undefined) data.limits = u.limits;
    if (u.cost_usd !== undefined) data.cost_usd = u.cost_usd;
    if (u.remote_session !== undefined) data.remote_session = u.remote_session;
    return Object.keys(data).length === 0 ? [] : [this.draft(ts, "usage", session, data)];
  }

  command(ts: number, session: string, name: string): Draft[] {
    // Lo tecleado era el comando, no el siguiente prompt.
    this.edit = undefined;
    return [this.draft(ts, "command", session, { name })];
  }

  setTask(ts: number, session: string, task: string | undefined, title: string | undefined, source: string): Draft[] {
    this.task = task;
    const data: Record<string, unknown> = { task: task ?? null, source };
    if (title !== undefined) data.title = title;
    return [this.draft(ts, "task.set", session, data)];
  }

  sessionEnd(ts: number, session: string, reason: string): Draft[] {
    const duration = this.sessionStartTs === undefined ? 0 : Math.max(0, ts - this.sessionStartTs);
    return [this.draft(ts, "session.end", session, { reason, duration_ms: duration })];
  }
}
