// Verificación de decisiones firmadas del reloj (SPEC §6.3). Lógica pura: sin `$`, sin Node, sin DOM.
//
// La criptografía es @noble/curves (P-256) y @noble/hashes (SHA-256), empaquetadas en
// ../../vendor/noble-p256.ts por scripts/vendor-noble.mjs: el sandbox de mods no deja importar paquetes
// (solo ficheros propios por ruta relativa), y su `crypto.subtle` solo trae `digest` (U8, ver
// protocol/docs/pairing.md). Esta es LA verificación que cuenta: ni el servidor ni el teléfono son de
// confianza para aprobar.
import { decodeFrame, encode, permHashInputToCbor, signingInputToCbor } from "../../protocol/index.js";
import type { Decision } from "../../protocol/index.js";
import * as noble from "../../vendor/noble-p256.js";

interface Curve {
  verify(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array, opts: { lowS: boolean; prehash: boolean; format: "compact" }): boolean;
  Point: { fromBytes(b: Uint8Array): { is0(): boolean; toBytes(compressed?: boolean): Uint8Array } };
}
const curve = noble.p256 as unknown as Curve;
const sha256 = noble.sha256 as unknown as (msg: Uint8Array) => Uint8Array;

/** Orden del grupo de P-256. */
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** Prefijo del único SPKI que acepta Orbit: id-ecPublicKey + prime256v1, punto sin comprimir (91 bytes). */
export const SPKI_PREFIX = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d,
  0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);
export const SPKI_LEN = 91;

/** Margen de deriva para un reloj adelantado: se acepta `ts <= exp + TS_SKEW_SEC` (SPEC §6.3). */
export const TS_SKEW_SEC = 30;

/**
 * Permiso pendiente de este mod, lo mínimo que hace falta para verificar. `exp` en segundos Unix.
 * Es un subconjunto estructural del `PendingPerm` de hold.ts (K2), que se puede pasar tal cual.
 * `instanceId`, `tool`, `sum`, `wok` y `exp` son los que el propio mod envió en /v0/perm/pending:
 * de ellos sale el `ph` que se recalcula (formato de firma 2), nunca del servidor ni de la `dec`.
 */
export interface PendingDecision {
  nonce: Uint8Array;
  toolUseId: string;
  exp: number;
  wok: boolean;
  instanceId: string;
  tool: string;
  sum: string;
  /** Ya resuelto (ganó alguien): una `dec` posterior es un replay (§10). Por defecto, no. */
  resolved?: boolean | undefined;
}

/** Llave emparejada (confirmada por el usuario con `/nod pair`). */
export interface PairedKey {
  kid: Uint8Array;
  spki: Uint8Array;
}

/** Valor de `permResolved.reject` (http-api.schema.json, 0.2). */
export type RejectWire = "sig" | "nonce" | "expired" | "replay" | "forbidden" | "kid" | "malformed" | "tool_use_id" | "ph";

/** Motivo fino (el que comparan los vectores de protocol/vectors/sig/ en Kotlin y aquí). */
export type RejectCause =
  | "malformed"
  | "nonce"
  | "tool_use_id"
  | "ph"
  | "replay"
  | "kid"
  | "sig"
  | "expired-ts"
  | "expired-now"
  | "forbidden";

/** Motivo fino -> `permResolved.reject`. Desde 0.2 cada motivo tiene su valor salvo los dos `expired`. */
export const REJECT_WIRE: Readonly<Record<RejectCause, RejectWire>> = {
  malformed: "malformed",
  nonce: "nonce",
  tool_use_id: "tool_use_id",
  ph: "ph",
  replay: "replay",
  kid: "kid",
  sig: "sig",
  "expired-ts": "expired",
  "expired-now": "expired",
  forbidden: "forbidden",
};

export type DecisionCheck =
  | { ok: true; decision: Decision; ts: number; kid: Uint8Array }
  | { ok: false; cause: RejectCause; reject: RejectWire };

function reject(cause: RejectCause): DecisionCheck {
  return { ok: false, cause, reject: REJECT_WIRE[cause] };
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

function bigOf(b: Uint8Array): bigint {
  let x = 0n;
  for (const v of b) x = (x << 8n) | BigInt(v);
  return x;
}

function fixed32(x: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  if (x !== 0n) throw new Error("entero de más de 32 bytes");
  return out;
}

/** `kid` = primeros 8 bytes de SHA-256 del SPKI DER. */
export function kidOf(spki: Uint8Array): Uint8Array {
  return sha256(spki).slice(0, 8);
}

/**
 * Comprueba que `spki` es un SPKI P-256 sin comprimir con un punto válido de la curva y devuelve el
 * punto (65 bytes). Lanza `Error` si no.
 */
export function spkiPoint(spki: Uint8Array): Uint8Array {
  if (spki.length !== SPKI_LEN) throw new Error(`SPKI de ${spki.length} bytes (se esperaban ${SPKI_LEN})`);
  if (!eq(spki.subarray(0, SPKI_PREFIX.length), SPKI_PREFIX)) throw new Error("SPKI que no es P-256 sin comprimir");
  const point = spki.slice(SPKI_PREFIX.length);
  if (point[0] !== 0x04) throw new Error("punto comprimido o inválido");
  let p;
  try {
    p = curve.Point.fromBytes(point);
  } catch (err) {
    throw new Error(`el punto no está en P-256 (${String(err)})`);
  }
  if (p.is0()) throw new Error("punto en el infinito");
  return point;
}

/** ECDSA P-256/SHA-256 sobre `msg` con firma `r‖s` de 64 bytes. Acepta `s` alta. Nunca lanza. */
export function verifySignature(spki: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  try {
    if (sig.length !== 64) return false;
    const r = bigOf(sig.subarray(0, 32));
    const s = bigOf(sig.subarray(32));
    if (r === 0n || s === 0n || r >= P256_N || s >= P256_N) return false;
    return curve.verify(sig, msg, spkiPoint(spki), { lowS: false, prehash: true, format: "compact" }) === true;
  } catch {
    return false;
  }
}

/**
 * `ph` de un pendiente (SPEC §6.3, formato de firma 2): SHA-256 del CBOR determinista de
 * `["orbit-perm", 1, instance_id, nonce, tool_use_id, tool, sum, wok, exp]`.
 */
export function permHash(p: Pick<PendingDecision, "instanceId" | "nonce" | "toolUseId" | "tool" | "sum" | "wok" | "exp">): Uint8Array {
  return sha256(encode(permHashInputToCbor({ instanceId: p.instanceId, nonce: p.nonce, toolUseId: p.toolUseId, tool: p.tool, sum: p.sum, wok: p.wok, exp: p.exp })));
}

/** Bytes exactos que firma el reloj: CBOR determinista de `["orbit-dec", 2, nonce, tool_use_id, decision, ts, ph]`. */
export function signingInput(nonce: Uint8Array, toolUseId: string, decision: Decision, ts: number, ph: Uint8Array): Uint8Array {
  return encode(signingInputToCbor({ nonce, toolUseId, decision, ts, ph }));
}

/**
 * Las condiciones de SPEC §6.3, en este orden (el mismo que `DecisionVerifier.kt` y check.mjs):
 *   0. forma (trama `dec` determinista) → 1. nonce del pendiente → 1. no usado → 2. tool_use_id →
 *   3. ph recibido = ph recalculado desde el pendiente → 4. kid emparejado → 5. firma sobre el ph
 *   RECALCULADO → 6. ts ≤ exp + 30 → 6. ahora ≤ exp → 7. allow ⇒ wok.
 *
 * `now` en segundos Unix (puede tener decimales: `$.clock.now() / 1000`). Función pura: no marca el
 * nonce como usado; quien resuelve el permiso (K2) lo hace al aceptar.
 */
export function verifyDecision(
  pending: PendingDecision,
  decBytes: Uint8Array,
  pairedKeys: readonly PairedKey[],
  now: number,
): DecisionCheck {
  let frame;
  try {
    frame = decodeFrame(decBytes);
  } catch {
    return reject("malformed");
  }
  if (frame.type !== "dec") return reject("malformed");
  if (!eq(frame.nonce, pending.nonce)) return reject("nonce");
  if (pending.resolved === true) return reject("replay");
  if (frame.toolUseId !== pending.toolUseId) return reject("tool_use_id");
  // El ph que cuenta es el del pendiente propio (lo que este mod anunció); el recibido solo se compara.
  let ph: Uint8Array;
  try {
    ph = permHash(pending);
  } catch {
    return reject("ph");
  }
  if (!eq(frame.ph, ph)) return reject("ph");
  // El kid de la lista solo cuenta si de verdad es el de su SPKI.
  const key = pairedKeys.find((k) => eq(k.kid, frame.kid) && eq(kidOf(k.spki), frame.kid));
  if (key === undefined) return reject("kid");
  const msg = signingInput(frame.nonce, pending.toolUseId, frame.decision, frame.ts, ph);
  if (!verifySignature(key.spki, msg, frame.sig)) return reject("sig");
  if (frame.ts > pending.exp + TS_SKEW_SEC) return reject("expired-ts");
  if (!(now <= pending.exp)) return reject("expired-now");
  if (frame.decision === "allow" && !pending.wok) return reject("forbidden");
  return { ok: true, decision: frame.decision, ts: frame.ts, kid: frame.kid };
}

/**
 * Adaptador al `DecisionVerifier` que inyecta hold.ts (K2): `(pending, decBytes, nowMs)` con `nowMs` en
 * milisegundos y resultado `{ ok }` / `{ ok: false, reason }` (reason = valor de `permResolved.reject`).
 * Las llaves se leen en cada llamada, así que un `/nod unpair` surte efecto en la siguiente `dec`.
 */
export function makeDecisionVerifier(
  pairedKeys: () => readonly PairedKey[] | Promise<readonly PairedKey[]>,
): (pending: PendingDecision, decBytes: Uint8Array, nowMs: number) => Promise<{ ok: true } | { ok: false; reason: RejectWire }> {
  return async (pending, decBytes, nowMs) => {
    const r = verifyDecision(pending, decBytes, await pairedKeys(), nowMs / 1000);
    return r.ok ? { ok: true } : { ok: false, reason: r.reject };
  };
}

// ---------------------------------------------------------------- DER (paridad con Kotlin)

/**
 * DER → `r‖s` (64 bytes). Estricto como `EcdsaDer.derToRaw` de Kotlin (mismos vectores en
 * protocol/vectors/sig/der.json). El mod no recibe DER en el cable; existe para herramientas y para
 * garantizar que las dos implementaciones aceptan y rechazan exactamente lo mismo.
 */
export function derToRaw(der: Uint8Array, lowS = false): Uint8Array {
  let i = 0;
  const bad = (m: string): never => {
    throw new Error(`DER inválido: ${m}`);
  };
  const next = (): number => (i < der.length ? der[i++]! : bad("truncado"));
  if (next() !== 0x30) bad("se esperaba SEQUENCE (0x30)");
  const seqLen = next();
  if (seqLen >= 0x80) bad("longitud de SEQUENCE en forma larga");
  if (seqLen !== der.length - 2) bad("longitud de SEQUENCE distinta del resto");
  const integer = (name: string): bigint => {
    if (next() !== 0x02) bad(`se esperaba INTEGER para ${name}`);
    const len = next();
    if (len >= 0x80) bad(`longitud de ${name} en forma larga`);
    if (len === 0) bad(`${name} vacío`);
    if (len > 33) bad(`${name} demasiado largo`);
    if (i + len > der.length) bad(`${name} truncado`);
    const v = der.subarray(i, i + len);
    i += len;
    if (v[0]! & 0x80) bad(`${name} negativo`);
    if (len > 1 && v[0] === 0 && !(v[1]! & 0x80)) bad(`${name} no mínimo`);
    const x = bigOf(v);
    if (x === 0n || x >= P256_N) bad(`${name} fuera de [1, n-1]`);
    return x;
  };
  const r = integer("r");
  let s = integer("s");
  if (i !== der.length) bad("bytes de más");
  if (lowS && s > P256_N >> 1n) s = P256_N - s;
  const out = new Uint8Array(64);
  out.set(fixed32(r), 0);
  out.set(fixed32(s), 32);
  return out;
}

/** `r‖s` → DER mínimo. */
export function rawToDer(raw: Uint8Array): Uint8Array {
  if (raw.length !== 64) throw new Error(`firma de ${raw.length} bytes (se esperaban 64)`);
  const int = (b: Uint8Array): number[] => {
    const x = bigOf(b);
    if (x === 0n || x >= P256_N) throw new Error("entero fuera de [1, n-1]");
    let k = 0;
    while (k < b.length - 1 && b[k] === 0) k++;
    const t = Array.from(b.subarray(k));
    return t[0]! & 0x80 ? [0, ...t] : t;
  };
  const r = int(raw.subarray(0, 32));
  const s = int(raw.subarray(32));
  const body = [0x02, r.length, ...r, 0x02, s.length, ...s];
  return Uint8Array.from([0x30, body.length, ...body]);
}
