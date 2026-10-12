// Respuestas desde el reloj (SPEC §6.6, formato de say 2): texto (voz o respuesta rápida), "stop" o "recap"
// (detente y resume, 0.2.3), firmados por una llave del reloj emparejada. Funciones puras: el plugin hace el
// long-poll y aplica el plan ([sayPlan]).
//
//   say             = ["say", nonce:bstr16, ts:uint, instance_id, sid:bstr16, kind:"text"|"stop"|"recap", text(≤1000 B), kid:bstr8, sig:bstr64]
//   entrada firmada = CBOR determinista de ["orbit-say", 2, nonce, ts, instance_id, sid, kind, text]
//   sid             = SHA-256(CBOR determinista de ["orbit-sid", 1, instance_id, session_id])[0..16]
//
// El `sid` ata la respuesta a una sesión: el reloj firma el que le da el servidor y el mod lo compara con el
// que calcula desde SU session_id. El formato 1 (sin sid, 8 elementos) ya no se acepta (`malformed`).

import { decodeStrict, encode } from "../protocol/cbor.js";
import * as noble from "../vendor/noble-p256.js";
import type { PairedKey } from "./perm/verify.js";
import { verifySignature } from "./perm/verify.js";

const sha256 = noble.sha256 as unknown as (msg: Uint8Array) => Uint8Array;

export const SAY_FORMAT = 2;
export const SAY_MAX_TEXT_BYTES = 1000;
export const SID_BYTES = 16;
/** Antigüedad máxima de un say (s) y adelanto tolerado del reloj del Galaxy Watch (s). */
export const SAY_MAX_AGE_SEC = 120;
export const SAY_SKEW_SEC = 30;

export type SayKind = "text" | "stop" | "recap";

/** Kinds que entiende este mod (0.2.3 añade `recap`, SPEC §6.6). */
export const SAY_KINDS: readonly SayKind[] = ["text", "stop", "recap"];

/**
 * Prompt de "Detente y resume" cuando el reloj no manda texto propio (`recap` con `text` vacío). Lo escribe el
 * mod, no el servidor: el servidor solo puede repetir o retrasar un `say` firmado, nunca cambiar lo que pide.
 */
export const RECAP_PROMPT =
  "Detente aquí. Resume en pocas líneas en qué estabas, qué has hecho hasta ahora y qué te bloquea o qué necesitas de mí. No sigas trabajando hasta que te responda.";

export interface Say {
  nonce: Uint8Array;
  ts: number;
  instanceId: string;
  sid: Uint8Array;
  kind: SayKind;
  text: string;
  kid: Uint8Array;
  sig: Uint8Array;
}

export type SayResult =
  | { ok: true; kind: SayKind; text: string; nonceHex: string }
  | { ok: false; reason: "malformed" | "instance" | "session" | "kid" | "sig" | "expired" | "replay" };

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Identificador de sesión que firma el reloj (SPEC §6.6). */
export function sessionSid(instanceId: string, sessionId: string): Uint8Array {
  return sha256(encode(["orbit-sid", 1, instanceId, sessionId])).slice(0, SID_BYTES);
}

export function sayInput(s: Pick<Say, "nonce" | "ts" | "instanceId" | "sid" | "kind" | "text">): Uint8Array {
  return encode(["orbit-say", SAY_FORMAT, s.nonce, s.ts, s.instanceId, s.sid, s.kind, s.text]);
}

export function parseSay(bytes: Uint8Array): Say | undefined {
  try {
    const v = decodeStrict(bytes);
    if (!Array.isArray(v) || v.length !== 9 || v[0] !== "say") return undefined;
    const [, nonce, ts, instanceId, sid, kind, text, kid, sig] = v;
    if (!(nonce instanceof Uint8Array) || nonce.length !== 16) return undefined;
    if (typeof ts !== "number" || !Number.isInteger(ts) || ts < 0) return undefined;
    if (typeof instanceId !== "string" || !(sid instanceof Uint8Array) || sid.length !== SID_BYTES) return undefined;
    if (!SAY_KINDS.includes(kind as SayKind) || typeof text !== "string") return undefined;
    if (new TextEncoder().encode(text).length > SAY_MAX_TEXT_BYTES) return undefined;
    if (!(kid instanceof Uint8Array) || kid.length !== 8 || !(sig instanceof Uint8Array) || sig.length !== 64) return undefined;
    return { nonce, ts, instanceId, sid, kind: kind as SayKind, text, kid, sig };
  } catch {
    return undefined;
  }
}

/**
 * Las condiciones de §6.6, en orden: forma → instancia → sesión (sid) → kid emparejado → firma → ventana de
 * tiempo → nonce no visto. `now` en segundos; `sessionId` es el de la sesión de este mod. No marca el nonce:
 * lo hace quien lo aplica.
 */
export function verifySay(
  bytes: Uint8Array,
  keys: readonly PairedKey[],
  now: number,
  instanceId: string,
  sessionId: string,
  seen: ReadonlySet<string>,
): SayResult {
  const s = parseSay(bytes);
  if (s === undefined) return { ok: false, reason: "malformed" };
  if (s.instanceId !== instanceId) return { ok: false, reason: "instance" };
  if (hex(s.sid) !== hex(sessionSid(instanceId, sessionId))) return { ok: false, reason: "session" };
  const key = keys.find((k) => hex(k.kid) === hex(s.kid));
  if (key === undefined) return { ok: false, reason: "kid" };
  if (!verifySignature(key.spki, sayInput(s), s.sig)) return { ok: false, reason: "sig" };
  if (s.ts > now + SAY_SKEW_SEC || s.ts < now - SAY_MAX_AGE_SEC) return { ok: false, reason: "expired" };
  const nonceHex = hex(s.nonce);
  if (seen.has(nonceHex)) return { ok: false, reason: "replay" };
  return { ok: true, kind: s.kind, text: s.text, nonceHex };
}

/**
 * Qué hacer con un `say` ya verificado. `turnActive`: hay un turno de la sesión principal en curso.
 * - `text`: con turno, nota para el siguiente resultado de tool; sin turno, prompt propio.
 * - `stop`: corta el turno (el texto se ignora: "Detente" del reloj no es un prompt).
 * - `recap`: corta el turno y, cuando quede libre, pide el resumen (texto del reloj o [RECAP_PROMPT]); sin turno
 *   en curso, el resumen sale ya.
 */
export type SayPlan = { abort: boolean; note?: string; submitNow?: string; submitAfterTurn?: string };

export function sayPlan(kind: SayKind, text: string, turnActive: boolean): SayPlan {
  switch (kind) {
    case "text":
      return turnActive ? { abort: false, note: text } : { abort: false, submitNow: text };
    case "stop":
      return { abort: turnActive };
    case "recap": {
      const prompt = text.trim() === "" ? RECAP_PROMPT : text;
      return turnActive ? { abort: true, submitAfterTurn: prompt } : { abort: false, submitNow: prompt };
    }
  }
}
