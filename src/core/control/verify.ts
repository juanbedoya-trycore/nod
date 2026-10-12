// Qué decisiones y mensajes acepta Nod (docs/control-v1.md §4.1 y §4.2). Esta es LA comprobación que cuenta:
// el controlador no es de confianza, así que la entrada firmada se reconstruye siempre con los datos que generó
// el propio Nod (instancia, id, tool_use_id, resumen, wok, exp, sesión), nunca con lo que diga el controlador.
import {
  ID_LEN,
  KID_LEN,
  SID_LEN,
  SIG_LEN,
  approvalHash,
  b64u,
  decisionInput,
  fromB64u,
  hex,
  kidOf,
  messageInput,
  sameBytes,
  utf8Len,
  verifySignature,
} from "./crypto.js";
import type { ApprovalData, DecisionValue } from "./crypto.js";

/** Llave emparejada (de approvers.json; las de prueba ya se quitaron al leerlo). */
export interface PairedKey {
  kid: Uint8Array;
  spki: Uint8Array;
  name?: string | undefined;
}

/** Adelanto tolerado del reloj del aprobador sobre `exp` (§4.1). */
export const DECISION_SKEW_SEC = 30;
/** Antigüedad máxima (y adelanto) de un mensaje (§4.2). */
export const MESSAGE_WINDOW_SEC = 120;
export const MESSAGE_MAX_TEXT_BYTES = 1000;

export type DecisionReject = "malformed" | "replay" | "kid" | "sig" | "expired" | "forbidden";
export type DecisionCheck = { ok: true; decision: DecisionValue; ts: number; kid: string } | { ok: false; reason: DecisionReject };

const isUint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function bytesOf(v: unknown, len: number): Uint8Array | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const b = fromB64u(v);
    return b.length === len ? b : undefined;
  } catch {
    return undefined;
  }
}

/** La llave de `kid`, solo si de verdad es la de su SPKI (una entrada manipulada del fichero no cuela). */
function keyFor(kid: Uint8Array, keys: readonly PairedKey[]): PairedKey | undefined {
  return keys.find((k) => sameBytes(k.kid, kid) && sameBytes(kidOf(k.spki), kid));
}

/**
 * Comprueba una decisión (`{"decision","ts","kid","sig"}` tal como la da el controlador) contra el permiso que
 * Nod retiene, en el orden de §4.1: malformed → replay → kid → sig → expired → forbidden. `now` en segundos.
 * `resolved`: el permiso ya se resolvió (cualquier decisión posterior es un replay).
 */
export function verifyDecision(pending: ApprovalData, raw: unknown, keys: readonly PairedKey[], now: number, resolved = false): DecisionCheck {
  const d = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  const decision = d?.decision;
  const ts = d?.ts;
  const kid = bytesOf(d?.kid, KID_LEN);
  const sig = bytesOf(d?.sig, SIG_LEN);
  if ((decision !== "allow" && decision !== "deny") || !isUint(ts) || kid === undefined || sig === undefined) return { ok: false, reason: "malformed" };
  if (resolved) return { ok: false, reason: "replay" };
  const key = keyFor(kid, keys);
  if (key === undefined) return { ok: false, reason: "kid" };
  const input = decisionInput(pending.id, pending.toolUseId, decision, ts, approvalHash(pending));
  if (!verifySignature(key.spki, input, sig)) return { ok: false, reason: "sig" };
  if (ts > pending.exp + DECISION_SKEW_SEC || now > pending.exp) return { ok: false, reason: "expired" };
  if (decision === "allow" && !pending.wok) return { ok: false, reason: "forbidden" };
  return { ok: true, decision, ts, kid: hex(kid) };
}

export type MessageKind = "text" | "stop" | "recap";
export const MESSAGE_KINDS: readonly MessageKind[] = ["text", "stop", "recap"];

export type MessageReject = "malformed" | "sid" | "kid" | "sig" | "expired" | "replay";
export type MessageCheck = { ok: true; id: string; kind: MessageKind; text: string; kid: string } | { ok: false; reason: MessageReject };

/** Lo que identifica la sesión de este Nod: con ello se reconstruye la entrada firmada. */
export interface MessageContext {
  instance: string;
  sid: Uint8Array;
}

/**
 * Comprueba un mensaje (`{"id","ts","sid","kind","text","kid","sig"}`): forma → sesión (`sid` de ESTA sesión)
 * → llave emparejada → firma (sobre la instancia y el sid de Nod) → ventana de ±120 s → id no visto. `seen` son
 * los ids (base64url) ya aplicados; esta función no lo modifica.
 */
export function verifyMessage(raw: unknown, ctx: MessageContext, keys: readonly PairedKey[], now: number, seen: ReadonlySet<string>): MessageCheck {
  const m = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  const id = bytesOf(m?.id, ID_LEN);
  const ts = m?.ts;
  const sid = bytesOf(m?.sid, SID_LEN);
  const kind = m?.kind;
  const text = m?.text;
  const kid = bytesOf(m?.kid, KID_LEN);
  const sig = bytesOf(m?.sig, SIG_LEN);
  if (id === undefined || !isUint(ts) || sid === undefined || kid === undefined || sig === undefined) return { ok: false, reason: "malformed" };
  if (!MESSAGE_KINDS.includes(kind as MessageKind) || typeof text !== "string" || utf8Len(text) > MESSAGE_MAX_TEXT_BYTES) return { ok: false, reason: "malformed" };
  if (!sameBytes(sid, ctx.sid)) return { ok: false, reason: "sid" };
  const key = keyFor(kid, keys);
  if (key === undefined) return { ok: false, reason: "kid" };
  if (!verifySignature(key.spki, messageInput(id, ts, ctx.instance, ctx.sid, kind as string, text), sig)) return { ok: false, reason: "sig" };
  if (Math.abs(now - ts) > MESSAGE_WINDOW_SEC) return { ok: false, reason: "expired" };
  const idText = b64u(id);
  if (seen.has(idText)) return { ok: false, reason: "replay" };
  return { ok: true, id: idText, kind: kind as MessageKind, text, kid: hex(kid) };
}
