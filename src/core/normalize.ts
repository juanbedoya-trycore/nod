// Del agente a Nod v1: el adaptador llama a estos métodos con lo que ve su motor (ya traducido a nombres
// neutros) y el normalizador devuelve los eventos (sin numerar). Aquí se derivan las señales que no da
// ningún hook: quién decidió cada permiso y cuánto se esperó al humano, si el prompt se reescribió o salió
// del historial, el costo acumulado de cada subagente.
import { addUsage, ZERO_USAGE } from "./events.js";
import type { Draft, EventType, Usage } from "./events.js";

export interface SessionInfo {
  cwd?: string | undefined;
  repo?: { root?: string | null; remote?: string | null; name?: string | null } | undefined;
  model?: string | undefined;
  interactive?: boolean | undefined;
  surface?: string | undefined;
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
}

export interface UsageSnapshot {
  context?: { tokens?: number; window?: number; percent?: number } | undefined;
  limits?: { kind: string; percent_used: number; resets_at?: string }[] | undefined;
  cost_usd?: number | undefined;
}

interface PendingTool {
  tool: string;
  agent: string | undefined;
  turn: string | undefined;
  callTs: number;
  askTs?: number;
  decidedTs?: number;
}

interface AgentRun {
  spawnTs: number;
  usage: Usage;
}

/** Cuántos prompts recientes se recuerdan para reconocer uno sacado del historial. */
const RECALL_MEMORY = 50;

/** Primera palabra de un comando de shell, sin asignaciones de variables delante (`FOO=1 npm test` → `npm`). */
export function verbOf(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  for (const w of command.trim().split(/\s+/)) {
    if (w === "" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
    if (w === "sudo" || w === "env" || w === "exec" || w === "time") continue;
    const base = w.split("/").pop() ?? w;
    return base.slice(0, 40);
  }
  return undefined;
}

export class Normalizer {
  /** Tarea en curso (§5): va en todos los eventos. */
  task: string | undefined;
  private sessionStartTs: number | undefined;
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

  sessionStart(ts: number, session: string, info: SessionInfo): Draft[] {
    this.sessionStartTs = ts;
    const data: Record<string, unknown> = { interactive: info.interactive === true };
    if (info.cwd !== undefined) data.cwd = info.cwd;
    if (info.repo !== undefined) {
      const repo: Record<string, unknown> = {};
      if (info.repo.root) repo.root = info.repo.root;
      if (info.repo.remote) repo.remote = info.repo.remote;
      if (info.repo.name) repo.name = info.repo.name;
      if (Object.keys(repo).length > 0) data.repo = repo;
    }
    if (info.model !== undefined) data.model = info.model;
    if (info.surface !== undefined) data.surface = info.surface;
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
    if (this.edit !== undefined) {
      data.edit = { events: this.edit.events, typing_ms: Math.max(0, ts - this.edit.first), recalled: this.edit.recalled, revised: this.edit.revised };
    }
    this.edit = undefined;
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
    this.tools.set(c.toolUseId, { tool: c.tool, agent: c.agent, turn, callTs: ts });
    const data: Record<string, unknown> = { tool_use_id: c.toolUseId, tool: c.tool };
    const input = c.input as Record<string, unknown> | undefined;
    const verb = verbOf(input?.command);
    if (verb !== undefined) data.verb = verb;
    if (input !== undefined) data.input = input;
    return [this.draft(ts, "tool.call", session, data, { turn, agent: c.agent })];
  }

  /** Lo que decidió el agente sobre el permiso de una tool (antes de preguntar a nadie). */
  toolCheck(ts: number, session: string, id: string, tool: string, decision: CheckDecision, reason?: string): Draft[] {
    let p = this.tools.get(id);
    if (p === undefined) {
      p = { tool, agent: undefined, turn: undefined, callTs: ts };
      this.tools.set(id, p);
    }
    if (decision === "ask") {
      p.askTs = ts;
      const data: Record<string, unknown> = { tool_use_id: id, tool };
      if (reason !== undefined && reason !== "") data.reason = reason;
      return [this.draft(ts, "permission.request", session, data, { turn: p.turn, agent: p.agent })];
    }
    return [this.decision(ts, session, id, p, decision, "policy")];
  }

  /** Un aprobador remoto (canal de control) decidió un permiso preguntado. */
  remoteDecision(ts: number, session: string, id: string, decision: "allow" | "deny"): Draft[] {
    const p = this.tools.get(id);
    if (p === undefined || p.askTs === undefined || p.decidedTs !== undefined) return [];
    return [this.decision(ts, session, id, p, decision, "remote")];
  }

  private decision(ts: number, session: string, id: string, p: PendingTool, decision: "allow" | "deny", by: string): Draft {
    p.decidedTs = ts;
    const wait = p.askTs === undefined ? 0 : Math.max(0, ts - p.askTs);
    return this.draft(ts, "permission.decision", session, { tool_use_id: id, tool: p.tool, decision, by, wait_ms: wait }, { turn: p.turn, agent: p.agent });
  }

  toolResult(ts: number, session: string, r: ToolResultInfo): Draft[] {
    const out: Draft[] = [];
    const p = this.tools.get(r.toolUseId) ?? { tool: r.tool, agent: undefined, turn: undefined, callTs: ts };
    // Preguntado y sin decisión registrada: la tool llegó a su fin, así que contestó el humano.
    if (p.askTs !== undefined && p.decidedTs === undefined) out.push(this.decision(ts, session, r.toolUseId, p, r.rejected ? "deny" : "allow", "user"));
    const began = Math.max(p.callTs, p.decidedTs ?? p.callTs);
    out.push(this.draft(ts, "tool.result", session, {
      tool_use_id: r.toolUseId,
      tool: r.tool,
      duration_ms: r.rejected ? 0 : Math.max(0, ts - began),
      ok: r.ok && !r.rejected,
      rejected: r.rejected,
      output_chars: r.outputChars,
    }, { turn: p.turn, agent: p.agent }));
    this.tools.delete(r.toolUseId);
    return out;
  }

  agentSpawn(ts: number, session: string, a: { agent: string; type?: string | undefined; description?: string | undefined; background?: boolean | undefined; model?: string | undefined; toolUseId?: string | undefined }): Draft[] {
    this.agents.set(a.agent, { spawnTs: ts, usage: ZERO_USAGE });
    const data: Record<string, unknown> = { agent: a.agent, type: a.type ?? "agent", background: a.background === true };
    if (a.description !== undefined) data.description = a.description;
    if (a.model !== undefined) data.model = a.model;
    if (a.toolUseId !== undefined) data.tool_use_id = a.toolUseId;
    return [this.draft(ts, "agent.spawn", session, data, { agent: a.agent })];
  }

  usage(ts: number, session: string, u: UsageSnapshot): Draft[] {
    const data: Record<string, unknown> = {};
    if (u.context !== undefined) data.context = u.context;
    if (u.limits !== undefined) data.limits = u.limits;
    if (u.cost_usd !== undefined) data.cost_usd = u.cost_usd;
    return Object.keys(data).length === 0 ? [] : [this.draft(ts, "usage", session, data)];
  }

  command(ts: number, session: string, name: string): Draft[] {
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
