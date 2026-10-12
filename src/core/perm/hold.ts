// Retención de un permiso y carrera reloj / terminal / timeout / abort (SPEC §6.1, §6.4, §6.5).
//
// Flujo (§6.1): `v = await next(e)`; si `v.decision !== 'ask'` se devuelve `v`. Si es `ask`:
//   1. wok (§6.4), sum (§6.2), nonce de 16 bytes, exp = ahora + 90 s -> POST /v0/perm/pending.
//      Si falla, no responde en `pendingTimeoutMs` o llega un abort, se devuelve `v` (fail-open al
//      flujo normal del terminal): un servidor colgado nunca bloquea la sesión (§10).
//   2. Long-poll GET /v0/perm/decision?tool_use_id=..&wait=2000 en bucle hasta exp. Cada `dec` se
//      verifica (verificador inyectado, §6.3); una inválida se descarta y se sigue esperando; un
//      `allow` con wok=false se rechaza (`forbidden`) y se sigue esperando.
//   3. Gana el primero, una sola resolución por tool_use_id:
//        watch     dec válida            -> {decision: allow|deny}
//        terminal  terminal(id) externo  -> v (el diálogo del terminal ya decidió)
//        timeout   vence la espera       -> v (en -p eso es denegar con "needs approval")
//        abort     next.signal abortado  -> v
//        error     fallo interno del mod -> v (0.2: by=error)
//      Lo que llegue después se ignora. Siempre se hace POST /v0/perm/resolved con quién ganó; si no
//      llega (red caída, 5xx, servidor reiniciando) se reintenta en segundo plano hasta exp + 6 s,
//      para que el servidor no vuelva a ofrecer al reloj un permiso ya resuelto.
//   4. Cualquier excepción devuelve `v`: Orbit nunca bloquea ni aprueba por error.
//
// U1 (sesión interactiva, sin verificar): si el diálogo del terminal y la retención coexisten, la
// primera respuesta gana. El plugin llama a `terminal(id)` cuando sabe que el terminal respondió
// (p. ej. llega `tool.call` del mismo tool_use_id); si el motor solo aborta `next.signal`, la
// resolución es `abort` (§6.1). En ambos casos se devuelve `v` y la otra vía queda ignorada.
//
// Sin Node ni DOM (sandbox del mod): el tiempo, el HTTP, los temporizadores y la entropía llegan por
// `PermIo`, lo que además hace los tests deterministas.
import { decodeFrame } from "../../protocol/index.js";
import type { PermConfig } from "../config.js";
import type { Config } from "../types.js";
import { ORBIT_VERSION, effectiveCtx } from "../types.js";
import { watchOk } from "./forbidden.js";
import { summarizeExact, toolLabel } from "./summary.js";
import { TS_SKEW_SEC, kidOf, permHash, spkiPoint, verifyDecision } from "./verify.js";
import type { PairedKey } from "./verify.js";

export interface Verdict {
  decision: string;
  reason?: string;
  [k: string]: unknown;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  text: string;
}

export interface HttpInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface PermIo {
  /** Milisegundos Unix. */
  now(): number | Promise<number>;
  fetch(url: string, init: HttpInit): Promise<HttpResponse>;
  /** Temporizador cancelable (en el plugin, `$.clock.after`). */
  after(ms: number, cb: () => void): { cancel(): void };
  /** n bytes de un CSPRNG. Si no hay CSPRNG debe lanzar: sin nonce no se retiene. */
  random(n: number): Uint8Array | Promise<Uint8Array>;
  log(message: string): void;
}

/** Lo que el motor pasa como `next.signal` (se usa con cuidado: puede no ser un AbortSignal completo). */
export interface AbortLike {
  readonly aborted: boolean;
  addEventListener?: (type: "abort", cb: () => void) => void;
  removeEventListener?: (type: "abort", cb: () => void) => void;
}

/**
 * Un permiso retenido, tal como se anunció en /v0/perm/pending. Es lo que recibe el verificador:
 * `instanceId`, `tool`, `sum`, `wok` y `exp` son la fuente del `ph` que se recalcula (SPEC §6.3).
 */
export interface PendingPerm {
  instanceId: string;
  nonce: Uint8Array;
  /** `nonce` en base64url sin relleno (22 caracteres). */
  nonceB64: string;
  toolUseId: string;
  /** Segundos Unix. */
  exp: number;
  wok: boolean;
  tool: string;
  sum: string;
  sessionId: string;
  agentId?: string;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Verificación de §6.3 (la escribe K1 en verify.ts; aquí se inyecta). Recibe los bytes CBOR exactos de
 * la `dec` y la hora actual en milisegundos. Debe comprobar nonce, tool_use_id, ph (recalculado desde el
 * pendiente: formato de firma 2), kid emparejado, firma, `ts <= exp + 30` y `ahora <= exp`. Que no se haya
 * usado el nonce, el ph y `wok` los vuelve a comprobar el holder.
 */
export type DecisionVerifier = (pending: PendingPerm, decBytes: Uint8Array, nowMs: number) => VerifyResult | Promise<VerifyResult>;

export type ResolvedBy = "watch" | "terminal" | "timeout" | "rule" | "abort" | "error";
export type ResolvedDecision = "allow" | "deny" | "none";
export const REJECT_REASONS = ["sig", "nonce", "expired", "replay", "forbidden", "kid", "malformed", "tool_use_id", "ph"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export interface Outcome {
  by: ResolvedBy;
  decision: ResolvedDecision;
}

/** Lo que el plugin sabe del `tool.check` (SPEC §3.3: tool, input, tool_use_id, agentId). */
export interface CheckEvent {
  tool?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  agentId?: unknown;
}

export interface HoldContext {
  sessionId: string;
  signal?: AbortLike | undefined;
  /** Io de esta llamada (en el plugin, el `$` del hook actual). Por defecto, el de `HolderDeps`. */
  io?: PermIo | undefined;
  /** Retención de esta llamada (p. ej. 90 s con `/nod away`); por defecto `perm.holdMs`. */
  holdMs?: number | undefined;
}

export interface HolderDeps {
  config: Config;
  perm: PermConfig;
  io: PermIo;
  verify: DecisionVerifier;
  /** `wait` del long-poll (SPEC §6.1: 2000). */
  pollWaitMs?: number;
  /** Pausa antes de reintentar tras un error de red, un 5xx o una respuesta inmediata. */
  retryMs?: number;
  /** Tope de espera del POST /v0/perm/resolved antes de devolver el veredicto. */
  resolvedTimeoutMs?: number;
  /** Tope de espera del POST /v0/perm/pending: si el servidor no responde, fail-open (`v`). */
  pendingTimeoutMs?: number;
}

/** Tras exp, el servidor cierra solo por timeout a los 5 s (margen); reintentar más allá no sirve. */
const RESOLVED_RETRY_AFTER_EXP_MS = 6000;
const RESOLVED_RETRY_MAX_DELAY_MS = 8000;

/** Notificación de una resolución (para el registro del plugin y los tests). */
export interface HoldReport {
  toolUseId: string;
  outcome: Outcome;
  reject?: RejectReason;
  rejected: number;
}

// ---------- verificador real (K1, verify.ts) ----------

/**
 * `kid` de las llaves de PRUEBA de protocol/vectors/sig/key.json: su escalar `d` es público (SHA-256 de
 * una cadena conocida), así que cualquiera puede firmar con ellas. Nunca cuentan como emparejadas.
 */
export const TEST_KIDS: readonly string[] = ["058f0152861814b2", "c5ce142e84259e6f"];

function kidHex(kid: Uint8Array): string {
  return Array.from(kid, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isTestKey(kid: Uint8Array): boolean {
  return TEST_KIDS.includes(kidHex(kid));
}

/** Quita las llaves de prueba (TEST_KIDS). Devuelve las que quedan y cuántas se quitaron. */
export function dropTestKeys(keys: readonly PairedKey[]): { keys: PairedKey[]; dropped: number } {
  const kept = keys.filter((k) => !isTestKey(k.kid));
  return { keys: kept, dropped: keys.length - kept.length };
}

/**
 * Adapta `verifyDecision(pending, decBytes, pairedKeys, now)` de K1 (now en segundos) a la interfaz que
 * inyecta el holder (now en milisegundos). `keys` puede ser una función: se lee en cada dec, así una
 * llave emparejada o revocada después de arrancar cuenta sin reiniciar. `resolved` es siempre false: el holder deja de considerar
 * decs en cuanto una gana, así que nunca pregunta por un pendiente ya resuelto.
 */
export function k1Verifier(keys: readonly PairedKey[] | (() => readonly PairedKey[])): DecisionVerifier {
  return (p, bytes, nowMs) => {
    const paired = typeof keys === "function" ? keys() : keys;
    const pending = { nonce: p.nonce, toolUseId: p.toolUseId, exp: p.exp, wok: p.wok, instanceId: p.instanceId, tool: p.tool, sum: p.sum, resolved: false };
    const r = verifyDecision(pending, bytes, paired, nowMs / 1000);
    return r.ok ? { ok: true } : { ok: false, reason: r.reject };
  };
}

export type WatchKeysResult = { ok: true; keys: PairedKey[] } | { ok: false; error: string };

/**
 * Llaves emparejadas desde texto: array JSON de SPKI DER en base64url (P-256 sin comprimir). Sin
 * llaves, ninguna dec del reloj se acepta (el permiso acaba en terminal o timeout).
 * Provisional hasta que el emparejamiento de K1 (`/nod pair`) guarde las llaves: ver blockers.
 */
export function parseWatchKeys(raw: string | undefined): WatchKeysResult {
  const text = (raw ?? "").trim();
  if (text === "") return { ok: true, keys: [] };
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    return { ok: false, error: "debe ser un array JSON de SPKI en base64url" };
  }
  if (!Array.isArray(list)) return { ok: false, error: "debe ser un array JSON de SPKI en base64url" };
  const keys: PairedKey[] = [];
  for (const item of list) {
    if (typeof item !== "string") return { ok: false, error: "cada llave debe ser un string base64url" };
    try {
      const spki = b64uDecode(item);
      spkiPoint(spki);
      const kid = kidOf(spki);
      if (isTestKey(kid)) return { ok: false, error: `llave de prueba ${kidHex(kid)} (su clave privada es pública): no se acepta` };
      keys.push({ kid, spki });
    } catch (err) {
      return { ok: false, error: `llave inválida (${String(err)})` };
    }
  }
  return { ok: true, keys };
}

// ---------- base64url sin relleno ----------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function b64uEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]!;
  }
  return out;
}

/** Decodifica base64url sin relleno. Lanza ante caracteres o longitudes inválidas. */
export function b64uDecode(s: string): Uint8Array {
  if (s.length % 4 === 1) throw new Error("base64url: longitud inválida");
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error("base64url: carácter inválido");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function asRejectReason(reason: string): RejectReason | undefined {
  return (REJECT_REASONS as readonly string[]).includes(reason) ? (reason as RejectReason) : undefined;
}

// ---------- una retención ----------

interface Active {
  settled: Outcome | undefined;
  settle(o: Outcome): boolean;
  done: Promise<Outcome>;
  wakers: Set<() => void>;
}

function newActive(): Active {
  let resolve!: (o: Outcome) => void;
  const done = new Promise<Outcome>((r) => (resolve = r));
  const a: Active = {
    settled: undefined,
    done,
    wakers: new Set(),
    settle(o) {
      if (a.settled !== undefined) return false;
      a.settled = o;
      resolve(o);
      for (const w of [...a.wakers]) w();
      a.wakers.clear();
      return true;
    },
  };
  return a;
}

const TOOL_USE_ID_MAX = 64;

/**
 * Retiene los `ask` de `tool.check` hasta que gane el reloj, el terminal, el timeout o un abort.
 * Una instancia por proceso: `active` garantiza una sola retención (y una sola resolución) por
 * tool_use_id, y permisos simultáneos de tools distintas no comparten estado.
 */
export class PermHolder {
  private readonly active = new Map<string, Active>();
  private readonly pollWaitMs: number;
  private readonly retryMs: number;
  private readonly resolvedTimeoutMs: number;
  private readonly pendingTimeoutMs: number;
  /** Últimas resoluciones (para /nod y los tests). */
  readonly reports: HoldReport[] = [];

  constructor(private readonly deps: HolderDeps) {
    this.pollWaitMs = deps.pollWaitMs ?? 2000;
    this.retryMs = deps.retryMs ?? 500;
    this.resolvedTimeoutMs = deps.resolvedTimeoutMs ?? 3000;
    this.pendingTimeoutMs = deps.pendingTimeoutMs ?? 5000;
  }

  /** Número de permisos retenidos ahora mismo. */
  pendingCount(): number {
    return this.active.size;
  }

  /**
   * El terminal respondió para `toolUseId` (U1). Devuelve true si esta llamada ganó la carrera.
   * `decision` es la del terminal si se conoce; si no, "none".
   */
  terminal(toolUseId: string, decision: ResolvedDecision = "none"): boolean {
    const a = this.active.get(toolUseId);
    return a === undefined ? false : a.settle({ by: "terminal", decision });
  }

  /**
   * §6.1 a partir del veredicto ya calculado (`v = await next(e)`). Nunca lanza y nunca devuelve algo
   * más permisivo que `v` salvo un `allow` del reloj verificado.
   */
  async hold(e: CheckEvent, v: Verdict, ctx: HoldContext): Promise<Verdict> {
    if (v === null || typeof v !== "object" || v.decision !== "ask") return v;
    try {
      return await this.holdAsk(e, v, ctx);
    } catch (err) {
      this.log(`retención falló, se devuelve el veredicto original (${String(err)})`, ctx.io);
      return v;
    }
  }

  private log(message: string, io: PermIo = this.deps.io): void {
    try {
      io.log(`orbit perm: ${message}`);
    } catch {
      // el registro nunca rompe la retención
    }
  }

  private async holdAsk(e: CheckEvent, v: Verdict, ctx: HoldContext): Promise<Verdict> {
    if (!this.deps.perm.enabled) return v;
    const toolUseId = typeof e.tool_use_id === "string" ? e.tool_use_id : "";
    if (toolUseId === "" || Array.from(toolUseId).length > TOOL_USE_ID_MAX) return v;
    const tool = typeof e.tool === "string" ? e.tool : "";
    if (tool === "" || ctx.sessionId === "") return v;
    if (ctx.signal?.aborted === true) return v;
    // Una sola retención por tool_use_id: un segundo tool.check del mismo id sigue el flujo normal.
    if (this.active.has(toolUseId)) return v;

    const a = newActive();
    this.active.set(toolUseId, a);
    try {
      return await this.race(a, e, v, ctx, ctx.io ?? this.deps.io, toolUseId, tool);
    } finally {
      // Ya resuelto (o abandonado por un error): una dec o un terminal() posteriores no encuentran nada.
      if (a.settled === undefined) a.settle({ by: "error", decision: "none" });
      if (this.active.get(toolUseId) === a) this.active.delete(toolUseId);
    }
  }

  private async race(a: Active, e: CheckEvent, v: Verdict, ctx: HoldContext, io: PermIo, toolUseId: string, tool: string): Promise<Verdict> {
    const { config, perm } = this.deps;
    const nonce = await io.random(16);
    if (!(nonce instanceof Uint8Array) || nonce.length !== 16) throw new Error("nonce: el CSPRNG no devolvió 16 bytes");
    const start = await io.now();
    const deadline = start + (ctx.holdMs ?? perm.holdMs);
    // wok=false también si el `sum` no es el texto completo (redactado, truncado o con invisibles): el
    // reloj firmaría algo distinto de lo que se ejecuta (SPEC §6.2, §6.4).
    const summary = summarizeExact(effectiveCtx(config), tool, e.input);
    const pending: PendingPerm = {
      instanceId: config.instanceId,
      nonce,
      nonceB64: b64uEncode(nonce),
      toolUseId,
      exp: Math.floor(deadline / 1000),
      wok: summary.exact && watchOk(tool, e.input, perm.forbidden),
      tool: toolLabel(tool),
      sum: summary.sum,
      sessionId: ctx.sessionId,
    };
    if (typeof e.agentId === "string" && e.agentId !== "") pending.agentId = e.agentId;

    const body: Record<string, unknown> = {
      orbit: ORBIT_VERSION,
      instance_id: config.instanceId,
      session_id: pending.sessionId,
      tool_use_id: toolUseId,
      nonce: pending.nonceB64,
      exp: pending.exp,
      tool: pending.tool,
      sum: pending.sum,
      wok: pending.wok,
    };
    if (pending.agentId !== undefined) body.agent_id = pending.agentId;

    // 1. Anunciar. Si falla, fail-open al flujo normal (sin /resolved: el servidor no tiene nada). Con
    // tope de tiempo y atento al abort: un servidor que acepta la conexión y no responde no puede
    // dejar la sesión esperando (§10). Si el POST llega a responder tarde, el servidor ya tiene un
    // pendiente que nadie espera: se cierra con /resolved para que no se ofrezca al reloj.
    const request = io
      .fetch(`${config.url}/v0/perm/pending`, { method: "POST", headers: this.headers(true), body: JSON.stringify(body) })
      .catch((err: unknown) => {
        this.log(`POST /v0/perm/pending falló (${String(err)})`, io);
        return undefined;
      });
    const gave = await this.capPending(io, request, ctx.signal);
    if (gave !== undefined) {
      this.log(`POST /v0/perm/pending sin respuesta (${gave}): se devuelve el veredicto original`, io);
      void request.then((late) => {
        if (late?.ok !== true) return;
        const orphan = { tool_use_id: toolUseId, nonce: pending.nonceB64, by: gave === "abort" ? "abort" : "timeout", decision: "none" };
        void this.postResolved(io, orphan, pending.exp * 1000 + RESOLVED_RETRY_AFTER_EXP_MS);
      });
      return v;
    }
    const posted = await request;
    if (posted === undefined || !posted.ok) {
      if (posted !== undefined) this.log(`POST /v0/perm/pending respondió ${posted.status}`, io);
      return v;
    }

    // 2. Fuentes de la carrera: timeout, abort, reloj (y terminal(), que llama a settle desde fuera).
    const remaining = Math.max(0, deadline - (await io.now()));
    const timer = io.after(remaining, () => a.settle({ by: "timeout", decision: "none" }));
    const signal = ctx.signal;
    const onAbort = (): void => {
      a.settle({ by: "abort", decision: "none" });
    };
    let listening = false;
    if (signal !== undefined && typeof signal.addEventListener === "function") {
      try {
        signal.addEventListener("abort", onAbort);
        listening = true;
      } catch {
        listening = false;
      }
    }
    if (signal?.aborted === true) onAbort();

    const state = { reject: undefined as RejectReason | undefined, rejected: 0 };
    const loop = this.pollLoop(a, io, pending, deadline, signal, state).catch((err: unknown) => {
      // Un fallo inesperado del bucle no puede dejar la sesión esperando 90 s: se abandona ya (by=error,
      // el servidor envía pclose y el reloj retira la solicitud).
      this.log(`bucle de long-poll falló (${String(err)})`, io);
      a.settle({ by: "error", decision: "none" });
    });

    const outcome = await a.done;
    timer.cancel();
    if (listening) {
      try {
        signal?.removeEventListener?.("abort", onAbort);
      } catch {
        // nada
      }
    }
    void loop;
    this.active.delete(toolUseId);

    // 3. Informar quién ganó (siempre), con un tope para no retrasar la respuesta al motor.
    const resolved: Record<string, unknown> = {
      tool_use_id: toolUseId,
      nonce: pending.nonceB64,
      by: outcome.by,
      decision: outcome.decision,
    };
    if (state.reject !== undefined) resolved.reject = state.reject;
    await this.postResolved(io, resolved, pending.exp * 1000 + RESOLVED_RETRY_AFTER_EXP_MS);
    const report: HoldReport = { toolUseId, outcome, rejected: state.rejected };
    if (state.reject !== undefined) report.reject = state.reject;
    this.reports.push(report);
    if (this.reports.length > 20) this.reports.shift();

    if (outcome.by === "watch" && outcome.decision === "allow") return { decision: "allow", reason: "aprobado desde el reloj (Orbit)" };
    if (outcome.by === "watch" && outcome.decision === "deny") return { decision: "deny", reason: "denegado desde el reloj (Orbit)" };
    return v;
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { authorization: `Bearer ${this.deps.config.token}` };
    if (json) h["content-type"] = "application/json";
    return h;
  }

  /**
   * Espera la respuesta de POST /v0/perm/pending como mucho `pendingTimeoutMs` y hasta un abort.
   * Devuelve undefined si respondió (bien o mal) a tiempo, o el motivo por el que se dejó de esperar.
   */
  private capPending(io: PermIo, request: Promise<unknown>, signal: AbortLike | undefined): Promise<"timeout" | "abort" | undefined> {
    if (signal?.aborted === true) return Promise.resolve("abort");
    return new Promise((resolve) => {
      let done = false;
      let listening = false;
      const finish = (r: "timeout" | "abort" | undefined): void => {
        if (done) return;
        done = true;
        timer.cancel();
        if (listening) {
          try {
            signal?.removeEventListener?.("abort", onAbort);
          } catch {
            // nada
          }
        }
        resolve(r);
      };
      const onAbort = (): void => finish("abort");
      const timer = io.after(this.pendingTimeoutMs, () => finish("timeout"));
      if (signal !== undefined && typeof signal.addEventListener === "function") {
        try {
          signal.addEventListener("abort", onAbort);
          listening = true;
        } catch {
          listening = false;
        }
      }
      void request.then(() => finish(undefined));
    });
  }

  /**
   * POST /v0/perm/resolved. Espera como mucho `resolvedTimeoutMs` (no retrasa la respuesta al motor);
   * si falla por red, 429 o 5xx, se reintenta en segundo plano con espera creciente hasta `untilMs`.
   * Un 4xx (p. ej. 404: el servidor ya lo olvidó) es definitivo.
   */
  private async postResolved(io: PermIo, body: Record<string, unknown>, untilMs: number): Promise<void> {
    let timer: { cancel(): void } | undefined;
    const cap = new Promise<void>((r) => {
      timer = io.after(this.resolvedTimeoutMs, r);
    });
    const post = this.sendResolved(io, body).then((done) => {
      if (!done) this.retryResolved(io, body, untilMs, 0);
    });
    await Promise.race([post, cap]);
    timer?.cancel();
  }

  /** Un intento. true = terminado (aceptado o rechazo definitivo); false = hay que reintentar. */
  private sendResolved(io: PermIo, body: Record<string, unknown>): Promise<boolean> {
    const { config } = this.deps;
    return io
      .fetch(`${config.url}/v0/perm/resolved`, { method: "POST", headers: this.headers(true), body: JSON.stringify(body) })
      .then(
        (r) => {
          if (r.ok) return true;
          this.log(`POST /v0/perm/resolved respondió ${r.status}`, io);
          return !(r.status === 429 || r.status >= 500);
        },
        (err: unknown) => {
          this.log(`POST /v0/perm/resolved falló (${String(err)})`, io);
          return false;
        },
      );
  }

  private retryResolved(io: PermIo, body: Record<string, unknown>, untilMs: number, attempt: number): void {
    const delay = Math.min(RESOLVED_RETRY_MAX_DELAY_MS, 1000 * 2 ** attempt);
    void Promise.resolve()
      .then(() => io.now())
      .then((now) => {
        if (now + delay > untilMs) {
          this.log(`POST /v0/perm/resolved sin entregar para ${String(body.tool_use_id)}: el servidor lo cerrará por timeout`, io);
          return;
        }
        io.after(delay, () => {
          void this.sendResolved(io, body).then((done) => {
            if (!done) this.retryResolved(io, body, untilMs, attempt + 1);
          });
        });
      })
      .catch(() => undefined);
  }

  /** Espera `ms` o hasta que la retención se resuelva, lo que ocurra antes. */
  private pause(a: Active, io: PermIo, ms: number): Promise<void> {
    if (a.settled !== undefined) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let t: { cancel(): void } | undefined;
      const wake = (): void => {
        t?.cancel();
        a.wakers.delete(wake);
        resolve();
      };
      a.wakers.add(wake);
      t = io.after(ms, wake);
    });
  }

  private async pollLoop(
    a: Active,
    io: PermIo,
    pending: PendingPerm,
    deadline: number,
    signal: AbortLike | undefined,
    state: { reject: RejectReason | undefined; rejected: number },
  ): Promise<void> {
    const { config } = this.deps;
    const seen = new Set<string>();
    while (a.settled === undefined) {
      if (signal?.aborted === true) {
        a.settle({ by: "abort", decision: "none" });
        return;
      }
      const t0 = await io.now();
      if (t0 >= deadline) {
        a.settle({ by: "timeout", decision: "none" });
        return;
      }
      const wait = Math.max(1, Math.min(this.pollWaitMs, deadline - t0));
      const url = `${config.url}/v0/perm/decision?tool_use_id=${encodeURIComponent(pending.toolUseId)}&wait=${wait}`;
      const r = await io.fetch(url, { method: "GET", headers: this.headers(false) }).catch(() => undefined);
      if (a.settled !== undefined) return;

      let decB64: string | undefined;
      if (r !== undefined && r.status === 200) {
        try {
          const j = JSON.parse(r.text) as unknown;
          if (j !== null && typeof j === "object" && typeof (j as { dec?: unknown }).dec === "string") decB64 = (j as { dec: string }).dec;
        } catch {
          decB64 = undefined;
        }
      }
      if (decB64 !== undefined) {
        const verdict = await this.consider(io, pending, decB64, seen);
        if (a.settled !== undefined) return;
        if (verdict.ok) {
          a.settle({ by: "watch", decision: verdict.decision });
          return;
        }
        if (verdict.reason !== undefined) {
          // El servidor entrega la misma dec en cada long-poll: la repetición (replay) no tapa la causa real.
          if (!(verdict.reason === "replay" && state.reject !== undefined)) state.reject = verdict.reason;
          state.rejected++;
          this.log(`dec descartada para ${pending.toolUseId}: ${verdict.reason}`, io);
        }
      }
      // Sin decisión: un 204 normal ya esperó en el servidor. Cualquier vuelta rápida (red caída, 5xx,
      // dec descartada, servidor que no espera) hace una pausa para no girar en vacío.
      const t1 = await io.now();
      const quick = t1 - t0 < Math.min(this.retryMs, wait);
      if (r === undefined || r.status >= 300 || decB64 !== undefined || quick) {
        await this.pause(a, io, Math.max(1, Math.min(this.retryMs, deadline - t1)));
      }
    }
  }

  /** Verifica una `dec` (§6.3) y aplica las reglas propias del holder (nonce sin usar, wok). */
  private async consider(
    io: PermIo,
    pending: PendingPerm,
    decB64: string,
    seen: Set<string>,
  ): Promise<{ ok: true; decision: "allow" | "deny" } | { ok: false; reason: RejectReason | undefined }> {
    if (seen.has(decB64)) return { ok: false, reason: "replay" };
    seen.add(decB64);
    let bytes: Uint8Array;
    try {
      bytes = b64uDecode(decB64);
    } catch {
      return { ok: false, reason: "malformed" };
    }
    const now = await io.now();
    let vr: VerifyResult;
    try {
      vr = await this.deps.verify(pending, bytes, now);
    } catch (err) {
      this.log(`el verificador lanzó (${String(err)})`, io);
      vr = { ok: false, reason: "sig" };
    }
    if (!vr.ok) return { ok: false, reason: asRejectReason(vr.reason) ?? "sig" };
    // Defensa en profundidad: el verificador ya lo comprobó, pero el holder no aprueba nada que no
    // sea exactamente la dec de este pendiente.
    let frame;
    try {
      frame = decodeFrame(bytes);
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (frame.type !== "dec") return { ok: false, reason: "malformed" };
    if (!sameBytes(frame.nonce, pending.nonce)) return { ok: false, reason: "nonce" };
    if (frame.toolUseId !== pending.toolUseId) return { ok: false, reason: "tool_use_id" };
    if (!sameBytes(frame.ph, permHash(pending))) return { ok: false, reason: "ph" };
    if (frame.ts > pending.exp + TS_SKEW_SEC || Math.floor(now / 1000) > pending.exp) return { ok: false, reason: "expired" };
    if (frame.decision === "allow" && !pending.wok) return { ok: false, reason: "forbidden" };
    return { ok: true, decision: frame.decision };
  }
}
