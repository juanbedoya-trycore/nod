import type { HookPayload } from "./types.js";

/** Lo que el mod sabe de un agente por `$.agent.list()`. */
export interface AgentHint {
  id: string;
  type?: string | undefined;
  description?: string | undefined;
}

interface PendingSpawn {
  tool_use_id: string;
  subagentType: string;
  description: string;
  background: boolean;
}

type Obj = Record<string, unknown>;

/** Claves que el motor añade al lado de los argumentos del tool y que no son argumentos. */
const TOOL_CALL_RESERVED = new Set(["tool", "tool_use_id", "agentId", "requestMeta", "consent"]);

const AGENT_ID_IN_TEXT = /(?:^|\n)\s*agentId:\s*([A-Za-z0-9_-]+)/;

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** Quita las claves reservadas y devuelve los argumentos aplanados del tool (SPEC §3.3). */
export function toolInputOf(e: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(e)) if (!TOOL_CALL_RESERVED.has(k)) out[k] = v;
  return out;
}

/** Texto `agentId: <id>` del resultado del tool Agent. */
export function agentIdFromText(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  return AGENT_ID_IN_TEXT.exec(text)?.[1];
}

/**
 * Traduce los eventos del motor a la forma canónica de SPEC §3.3. Es puro: no toca `$`; quien lo
 * usa le pasa los datos que obtuvo de `$` (session id, agente de `$.agent.list()`).
 * Cada método devuelve la lista de payloads a emitir, en orden.
 *
 * Emparejamiento tardío: `agent.spawn` no trae `agentId`, así que queda pendiente y
 * `SubagentStart` sale cuando aparece el primer `agentId` (de un tool.call posterior, del
 * `agentId:` del resultado del tool Agent o del único pendiente en un `turn.complete`).
 */
export class Translator {
  private pending: PendingSpawn[] = [];
  private started = new Set<string>();
  private types = new Map<string, string>();

  /** ¿Hace falta consultar `$.agent.list()` para este agente? */
  needsAgentLookup(agentId: string | undefined): boolean {
    return agentId !== undefined && !this.types.has(agentId);
  }

  get pendingSpawns(): number {
    return this.pending.length;
  }

  sessionStart(sid: string, e: Obj): HookPayload[] {
    const ev: HookPayload = { session_id: sid, hook_event_name: "SessionStart", source: "mod" };
    const cwd = str(e.cwd);
    if (cwd !== undefined) ev.cwd = cwd;
    return [ev];
  }

  turnStart(sid: string, e: Obj): HookPayload[] {
    const ev: HookPayload = { session_id: sid, hook_event_name: "UserPromptSubmit" };
    if (typeof e.text === "string") ev.prompt = e.text;
    const turn = str(e.turnId);
    if (turn !== undefined) ev.turn_id = turn;
    return [ev];
  }

  toolCall(sid: string, e: Obj, agent?: AgentHint): HookPayload[] {
    const out: HookPayload[] = [];
    const agentId = str(e.agentId);
    if (agentId !== undefined) {
      if (agent !== undefined && agent.id === agentId && agent.type !== undefined) this.types.set(agentId, agent.type);
      out.push(...this.tryStart(sid, agentId, { type: agent?.type, description: agent?.description }));
    }
    const ev: HookPayload = {
      session_id: sid,
      hook_event_name: "PreToolUse",
      tool_name: String(e.tool),
      tool_use_id: String(e.tool_use_id),
      tool_input: toolInputOf(e),
    };
    this.addAgent(ev, agentId);
    out.push(ev);
    return out;
  }

  /** `tool.check` con veredicto `ask`. allow/deny no emiten nada. */
  toolCheck(sid: string, e: Obj, verdict: Obj | undefined): HookPayload[] {
    if (verdict?.decision !== "ask") return [];
    const ev: HookPayload = {
      session_id: sid,
      hook_event_name: "PermissionRequest",
      tool_name: String(e.tool),
    };
    if (e.input !== undefined && e.input !== null && typeof e.input === "object") ev.tool_input = e.input;
    const id = str(e.tool_use_id);
    if (id !== undefined) ev.tool_use_id = id;
    this.addAgent(ev, str(e.agentId));
    const reason = str(verdict.reason);
    if (reason !== undefined) ev.permission_reason = reason;
    return [ev];
  }

  /** Resultado de `tool.call` (lo que devuelve `next(e)`). El texto del resultado NO se copia. */
  toolResult(sid: string, e: Obj, result: Obj | undefined): HookPayload[] {
    const out: HookPayload[] = [];
    const toolUseId = String(e.tool_use_id);
    const isAgent = e.tool === "Agent";
    let boundAgentId: string | undefined;
    if (isAgent) {
      boundAgentId = agentIdFromText(result?.text);
      if (boundAgentId !== undefined) out.push(...this.tryStart(sid, boundAgentId, { toolUseId }));
    }
    const ev: HookPayload = {
      session_id: sid,
      hook_event_name: "PostToolUse",
      tool_name: String(e.tool),
      tool_use_id: toolUseId,
      is_error: result?.isError === true || typeof result?.deny === "string",
    };
    this.addAgent(ev, str(e.agentId));
    // Solo el id, nunca el texto: el servidor lo usa para vincular el nodo agente (SPEC §4.2).
    if (boundAgentId !== undefined) ev.tool_response = { agentId: boundAgentId };
    out.push(ev);
    return out;
  }

  agentSpawn(e: Obj): HookPayload[] {
    const id = str(e.tool_use_id);
    if (id === undefined) return [];
    this.pending.push({
      tool_use_id: id,
      subagentType: str(e.subagentType) ?? "unknown",
      description: typeof e.description === "string" ? e.description : "",
      background: e.background === true,
    });
    return [];
  }

  turnComplete(sid: string, e: Obj): HookPayload[] {
    const out: HookPayload[] = [];
    const agentId = str(e.agentId);
    const isAborted = e.isAborted === true;
    if (agentId !== undefined) {
      // Un subagente que termina sin haber arrancado: solo si hay un único pendiente es seguro.
      if (!this.started.has(agentId) && this.pending.length === 1) out.push(...this.tryStart(sid, agentId, {}));
      const stop: HookPayload = { session_id: sid, hook_event_name: "SubagentStop", agent_id: agentId, is_aborted: isAborted };
      // SPEC §3.3: usage va también en SubagentStop (el motor lo suma a meta).
      if (e.usage !== undefined && e.usage !== null && typeof e.usage === "object") stop.usage = e.usage;
      out.push(stop);
      this.started.delete(agentId);
      this.types.delete(agentId);
      return out;
    }
    const ev: HookPayload = { session_id: sid, hook_event_name: "Stop", is_aborted: isAborted };
    const turn = str(e.turnId);
    if (turn !== undefined) ev.turn_id = turn;
    if (typeof e.answer === "string") ev.last_assistant_message = e.answer;
    if (e.usage !== undefined && e.usage !== null && typeof e.usage === "object") ev.usage = e.usage;
    out.push(ev);
    return out;
  }

  sessionEnd(sid: string, e: Obj): HookPayload[] {
    const ev: HookPayload = { session_id: sid, hook_event_name: "SessionEnd", reason: str(e.reason) ?? "other" };
    this.pending = [];
    this.started.clear();
    this.types.clear();
    return [ev];
  }

  private addAgent(ev: HookPayload, agentId: string | undefined): void {
    if (agentId === undefined) return;
    ev.agent_id = agentId;
    const type = this.types.get(agentId);
    if (type !== undefined) ev.agent_type = type;
  }

  /**
   * Intenta emitir SubagentStart para `agentId`. Elige el spawn pendiente por tool_use_id exacto
   * (resultado del tool Agent), o el más antiguo con el mismo tipo (y descripción, si coincide
   * alguno), o el único pendiente si no hay pistas. Sin spawn pendiente no emite nada.
   */
  private tryStart(sid: string, agentId: string, hint: { toolUseId?: string; type?: string | undefined; description?: string | undefined }): HookPayload[] {
    if (this.started.has(agentId) || this.pending.length === 0) return [];
    let idx = -1;
    if (hint.toolUseId !== undefined) {
      idx = this.pending.findIndex((p) => p.tool_use_id === hint.toolUseId);
    } else if (hint.type !== undefined) {
      const sameType = this.pending.filter((p) => p.subagentType === hint.type);
      const best = sameType.find((p) => hint.description !== undefined && p.description === hint.description) ?? sameType[0];
      idx = best === undefined ? -1 : this.pending.indexOf(best);
    } else if (this.pending.length === 1) {
      idx = 0;
    }
    if (idx < 0) return [];
    const spawn = this.pending.splice(idx, 1)[0]!;
    this.started.add(agentId);
    this.types.set(agentId, spawn.subagentType);
    return [
      {
        session_id: sid,
        hook_event_name: "SubagentStart",
        agent_id: agentId,
        agent_type: spawn.subagentType,
        parent_tool_use_id: spawn.tool_use_id,
        background: spawn.background,
      },
    ];
  }
}
