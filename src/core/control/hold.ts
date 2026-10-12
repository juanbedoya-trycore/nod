// Retención de un permiso (docs/control-v1.md §4.1): el agente preguntaría al humano en su terminal; antes, Nod
// lo anuncia al controlador y espera una decisión firmada por un aprobador emparejado.
//
//   1. POST /v1/control/approvals con un id aleatorio de 16 bytes y `exp` = ahora + retención. Si falla, no
//      contesta en 3 s, contesta otra cosa que 2xx o el agente cancela, no se retiene: veredicto original.
//   2. Long-poll GET /v1/control/approvals/<id>?wait=… hasta `exp`. Cada decisión se verifica (verify.ts); una
//      inválida se descarta (se cuenta y se guarda el motivo) y se sigue esperando. 404/410: ya no existe.
//   3. Gana lo primero entre: una decisión válida, el plazo `exp` y la cancelación del agente (`next.signal`).
//      Lo que llegue después se ignora: una sola resolución por permiso.
//   4. POST /v1/control/approvals/<id>/resolved en segundo plano (no retrasa al agente), con reintentos hasta
//      poco después de `exp`, para que el aprobador deje de mostrarlo.
//
// Fail-open en todo: cualquier fallo devuelve "sin decisión remota" y el agente sigue como si el canal no
// existiera. Nod nunca devuelve algo más permisivo que el veredicto original salvo un `allow` verificado.
import { ID_LEN, b64u, hex, sessionSid } from "./crypto.js";
import type { ApprovalData, DecisionValue } from "./crypto.js";
import { CALL_TIMEOUT_MS, call, headers, parseJson } from "./io.js";
import type { ControlIo, Controller } from "./io.js";
import { verifyDecision } from "./verify.js";
import type { DecisionReject, PairedKey } from "./verify.js";

/** Lo que el motor pasa como `next.signal` (puede no ser un AbortSignal completo). */
export interface AbortLike {
  readonly aborted: boolean;
  addEventListener?: (type: "abort", cb: () => void) => void;
  removeEventListener?: (type: "abort", cb: () => void) => void;
}

export interface HoldRequest {
  instance: string;
  session: string;
  toolUseId: string;
  /** Nombre de la tool tal como sale (con `redactado`, el servidor MCP oculto). */
  tool: string;
  summary: string;
  wok: boolean;
  agent?: string | undefined;
  holdMs: number;
  signal?: AbortLike | undefined;
  /** Llaves emparejadas, leídas en cada decisión: una llave revocada deja de contar desde la siguiente. */
  keys: () => Promise<readonly PairedKey[]>;
}

export type ResolvedBy = "remote" | "timeout" | "abort" | "error";

export type HoldOutcome =
  /** No se llegó a retener (controlador caído, lento, respuesta rara, cancelado antes). */
  | { held: false; why: string }
  | { held: true; by: ResolvedBy; decision: DecisionValue | "none"; reject?: DecisionReject | undefined; rejected: number };

/** Pausa tras una vuelta rápida del long-poll (red caída, 5xx, decisión descartada): no gira en vacío. */
const RETRY_MS = 500;
/** `wait` máximo del long-poll: lo que quede hasta `exp`, como mucho esto. */
const POLL_WAIT_MS = 10_000;
/** /resolved se reintenta hasta `exp` más este margen (lo que tarda un aprobador en ver que ya venció). */
const RESOLVED_GRACE_MS = 30_000;
const RESOLVED_MAX_DELAY_MS = 8_000;
const TOOL_USE_ID_MAX = 128;
/** Ids de permisos ya resueltos que se recuerdan (para `replay`). */
const RESOLVED_MEMORY = 256;

interface Race {
  done: Promise<{ by: ResolvedBy; decision: DecisionValue | "none" }>;
  settled: boolean;
  settle: (by: ResolvedBy, decision?: DecisionValue) => void;
  wakers: Set<() => void>;
}

function newRace(): Race {
  let resolve!: (o: { by: ResolvedBy; decision: DecisionValue | "none" }) => void;
  const race: Race = {
    done: new Promise((r) => (resolve = r)),
    settled: false,
    wakers: new Set(),
    settle(by, decision) {
      if (race.settled) return;
      race.settled = true;
      resolve({ by, decision: decision ?? "none" });
      for (const w of [...race.wakers]) w();
      race.wakers.clear();
    },
  };
  return race;
}

/**
 * Las retenciones de este proceso: una a la vez por tool_use_id, y memoria de los permisos ya resueltos. Cada
 * retención usa el `io` de su llamada (en Claude, el `$` del hook en curso).
 */
export class Holder {
  /** Permisos retenidos ahora, por tool_use_id. */
  private readonly active = new Set<string>();
  private readonly resolved: string[] = [];
  /** Última resolución (para /nod). */
  last: (HoldOutcome & { toolUseId: string }) | undefined;

  get holding(): number {
    return this.active.size;
  }

  isResolved(idHex: string): boolean {
    return this.resolved.includes(idHex);
  }

  remember(idHex: string): void {
    this.resolved.push(idHex);
    if (this.resolved.length > RESOLVED_MEMORY) this.resolved.shift();
  }

  /** Retiene un permiso preguntado. Nunca lanza. */
  async hold(req: HoldRequest, controller: Controller, io: ControlIo): Promise<HoldOutcome> {
    if (req.toolUseId === "" || req.toolUseId.length > TOOL_USE_ID_MAX) return { held: false, why: "tool_use_id inválido" };
    if (req.signal?.aborted === true) return { held: false, why: "cancelado" };
    if (this.active.has(req.toolUseId)) return { held: false, why: "ya retenido" };
    this.active.add(req.toolUseId);
    const run = new Retention(controller, io, this);
    try {
      const out = await run.run(req);
      this.last = { ...out, toolUseId: req.toolUseId };
      return out;
    } catch (err) {
      run.log(`retención falló (${String(err)}): veredicto original`);
      return { held: false, why: String(err) };
    } finally {
      this.active.delete(req.toolUseId);
    }
  }
}

class Retention {
  constructor(
    private readonly controller: Controller,
    private readonly io: ControlIo,
    private readonly holder: Holder,
  ) {}

  log(m: string): void {
    try {
      this.io.log(`nod control: ${m}`);
    } catch {
      // el registro nunca rompe la retención
    }
  }

  async run(req: HoldRequest): Promise<HoldOutcome> {
    const { io, controller } = this;
    const id = await io.random(ID_LEN);
    if (!(id instanceof Uint8Array) || id.length !== ID_LEN) throw new Error("sin 16 bytes aleatorios");
    const start = await io.now();
    const deadline = start + req.holdMs;
    const pending: ApprovalData = { instance: req.instance, id, toolUseId: req.toolUseId, tool: req.tool, summary: req.summary, wok: req.wok, exp: Math.floor(deadline / 1000) };
    const idText = b64u(id);
    const base = `${controller.url}/v1/control/approvals/${idText}`;
    const body: Record<string, unknown> = {
      id: idText,
      instance: req.instance,
      session: req.session,
      sid: b64u(sessionSid(req.instance, req.session)),
      tool_use_id: req.toolUseId,
      tool: req.tool,
      summary: req.summary,
      wok: req.wok,
      exp: pending.exp,
    };
    if (req.agent !== undefined) body.agent = req.agent;

    // 1. Anunciar, con plazo y atento a la cancelación. Si contesta tarde, el controlador tiene un permiso que
    // nadie espera: se cierra con /resolved para que el aprobador no lo vea.
    const post = io.fetch(`${controller.url}/v1/control/approvals`, { method: "POST", headers: headers(controller, true), body: JSON.stringify(body) }).catch(() => undefined);
    const first = await this.firstOf(post, CALL_TIMEOUT_MS, req.signal);
    if (first === "late" || first === "abort") {
      void post.then((late) => {
        if (late !== undefined && late.status >= 200 && late.status < 300) this.resolveLater(base, { by: first === "abort" ? "abort" : "error", decision: "none" }, deadline);
      });
      return { held: false, why: first === "abort" ? "cancelado" : `el controlador no contestó en ${CALL_TIMEOUT_MS / 1000} s` };
    }
    const r = first.value;
    if (r === undefined) return { held: false, why: "controlador inalcanzable" };
    if (r.status < 200 || r.status >= 300) return { held: false, why: `el controlador respondió ${r.status}` };

    // 2. La carrera: plazo, cancelación y decisiones.
    const race = newRace();
    const timer = io.after(Math.max(0, deadline - (await io.now())), () => race.settle("timeout"));
    const onAbort = (): void => race.settle("abort");
    const unlisten = listen(req.signal, onAbort);
    if (req.signal?.aborted === true) onAbort();
    const state = { reject: undefined as DecisionReject | undefined, rejected: 0, gone: false };
    void this.poll(race, req, pending, base, deadline, state).catch((err: unknown) => {
      this.log(`long-poll falló (${String(err)})`);
      race.settle("error");
    });
    const outcome = await race.done;
    timer.cancel();
    unlisten();
    this.holder.remember(hex(id));

    // 3. Que el aprobador deje de mostrarlo. Si el controlador ya lo olvidó (404/410), no hay nada que cerrar.
    if (!state.gone) {
      const resolved: Record<string, unknown> = { by: outcome.by, decision: outcome.decision };
      if (state.reject !== undefined) resolved.reject = state.reject;
      this.resolveLater(base, resolved, deadline);
    }
    return { held: true, by: outcome.by, decision: outcome.decision, reject: state.reject, rejected: state.rejected };
  }

  /** La respuesta del POST si llega antes del plazo y de la cancelación. */
  private firstOf<T>(work: Promise<T>, ms: number, signal: AbortLike | undefined): Promise<{ value: T } | "late" | "abort"> {
    if (signal?.aborted === true) return Promise.resolve("abort");
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: { value: T } | "late" | "abort"): void => {
        if (done) return;
        done = true;
        timer.cancel();
        unlisten();
        resolve(v);
      };
      const timer = this.io.after(ms, () => finish("late"));
      const unlisten = listen(signal, () => finish("abort"));
      void work.then((value) => finish({ value }));
    });
  }

  private async poll(race: Race, req: HoldRequest, pending: ApprovalData, base: string, deadline: number, state: { reject: DecisionReject | undefined; rejected: number; gone: boolean }): Promise<void> {
    const { io, controller } = this;
    const seen = new Set<string>();
    while (!race.settled) {
      const t0 = await io.now();
      if (t0 >= deadline) return race.settle("timeout");
      const wait = Math.max(1, Math.min(POLL_WAIT_MS, deadline - t0));
      const r = await call(io, wait + CALL_TIMEOUT_MS, `${base}?wait=${wait}`, { method: "GET", headers: headers(controller, false) });
      if (race.settled) return;
      if (r?.status === 404 || r?.status === 410) {
        state.gone = true;
        return race.settle("error");
      }
      let fresh = false;
      if (r?.status === 200) {
        const raw = (parseJson(r.text) as { decision?: unknown } | undefined)?.decision;
        const key = JSON.stringify(raw ?? null);
        // El controlador puede devolver la misma decisión en cada vuelta: se comprueba una vez.
        if (!seen.has(key)) {
          seen.add(key);
          fresh = true;
          const v = verifyDecision(pending, raw, await req.keys(), (await io.now()) / 1000, this.holder.isResolved(hex(pending.id)));
          if (race.settled) return;
          if (v.ok) return race.settle("remote", v.decision);
          state.reject = v.reason;
          state.rejected++;
          this.log(`decisión descartada para ${req.toolUseId}: ${v.reason}`);
        }
      }
      // Un 204 ya esperó en el controlador. Cualquier vuelta rápida hace una pausa antes de volver a pedir.
      const t1 = await io.now();
      if (r === undefined || r.status !== 204 || fresh || t1 - t0 < Math.min(RETRY_MS, wait)) await this.pause(race, Math.max(1, Math.min(RETRY_MS, deadline - t1)));
    }
  }

  private pause(race: Race, ms: number): Promise<void> {
    if (race.settled) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = (): void => {
        t.cancel();
        race.wakers.delete(wake);
        resolve();
      };
      race.wakers.add(wake);
      const t = this.io.after(ms, wake);
    });
  }

  /** POST …/resolved en segundo plano; reintenta red caída, 429 y 5xx con espera creciente hasta exp + margen. */
  private resolveLater(base: string, body: Record<string, unknown>, deadline: number, attempt = 0): void {
    const { io, controller } = this;
    void call(io, CALL_TIMEOUT_MS, `${base}/resolved`, { method: "POST", headers: headers(controller, true), body: JSON.stringify(body) })
      .then(async (r) => {
        if (r !== undefined && (r.status < 500 && r.status !== 429)) return;
        const delay = Math.min(RESOLVED_MAX_DELAY_MS, 1000 * 2 ** attempt);
        if ((await io.now()) + delay > deadline + RESOLVED_GRACE_MS) {
          this.log(`/resolved sin entregar: el controlador lo cerrará por plazo`);
          return;
        }
        io.after(delay, () => this.resolveLater(base, body, deadline, attempt + 1));
      })
      .catch(() => undefined);
  }
}

function listen(signal: AbortLike | undefined, cb: () => void): () => void {
  if (signal === undefined || typeof signal.addEventListener !== "function") return () => undefined;
  try {
    signal.addEventListener("abort", cb);
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      signal.removeEventListener?.("abort", cb);
    } catch {
      // nada
    }
  };
}
