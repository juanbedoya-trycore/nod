// Criptografía de Nod Control (docs/control-v1.md §3): kid, firmas P-256 compactas con s bajo, HMAC-SHA256 y
// las entradas firmadas en CBOR determinista. Lógica pura: sin `$`, sin Node, sin DOM.
//
// P-256 y SHA-256 vienen de @noble, empaquetados en ../../vendor/noble-p256.ts (el sandbox de mods no deja
// importar paquetes ni trae `crypto.subtle.verify`). HMAC no está empaquetado: se hace aquí sobre SHA-256
// (RFC 2104), que son diez líneas y se comprueban con los vectores de emparejamiento.
import * as noble from "../../vendor/noble-p256.js";
import { encode } from "./cbor.js";

interface Curve {
  verify(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array, opts: { lowS: boolean; prehash: boolean; format: "compact" }): boolean;
  Point: { fromBytes(b: Uint8Array): { is0(): boolean } };
}
const curve = noble.p256 as unknown as Curve;
export const sha256 = noble.sha256 as unknown as (msg: Uint8Array) => Uint8Array;

/** Orden del grupo de P-256. */
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** El único SPKI que se acepta: id-ecPublicKey + prime256v1 y punto sin comprimir (91 bytes). */
export const SPKI_PREFIX = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d,
  0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);
export const SPKI_LEN = 91;
export const KID_LEN = 8;
export const SIG_LEN = 64;
export const ID_LEN = 16;
export const SID_LEN = 16;
export const PAIR_K_LEN = 32;
export const TAG_LEN = 32;

const utf8 = new TextEncoder();

export function utf8Len(s: string): number {
  return utf8.encode(s).length;
}

// ---------- bytes ----------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url sin relleno (así van los binarios en JSON, §3). */
export function b64u(bytes: Uint8Array): string {
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

/**
 * base64url sin relleno, estricto: lanza ante caracteres ajenos, relleno, longitudes imposibles o bits
 * sobrantes distintos de cero (dos textos distintos no pueden dar los mismos bytes).
 */
export function fromB64u(s: string): Uint8Array {
  if (s.length % 4 === 1) throw new Error("base64url: longitud inválida");
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error("base64url: carácter inválido");
    acc = ((acc << 6) | v) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) throw new Error("base64url: bits sobrantes");
  return Uint8Array.from(out);
}

export function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(s: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(s)) throw new Error("hex inválido");
  return Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
}

/** Igualdad en tiempo constante para la misma longitud (no corta en el primer byte distinto). */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
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

// ---------- llaves y firmas ----------

/** `kid` = primeros 8 bytes de SHA-256(SPKI). */
export function kidOf(spki: Uint8Array): Uint8Array {
  return sha256(spki).slice(0, KID_LEN);
}

/** Comprueba que `spki` es P-256 sin comprimir con un punto de la curva y devuelve el punto. Lanza si no. */
export function spkiPoint(spki: Uint8Array): Uint8Array {
  if (spki.length !== SPKI_LEN) throw new Error(`SPKI de ${spki.length} bytes (se esperaban ${SPKI_LEN})`);
  if (!sameBytes(spki.subarray(0, SPKI_PREFIX.length), SPKI_PREFIX)) throw new Error("SPKI que no es P-256 sin comprimir");
  const point = spki.slice(SPKI_PREFIX.length);
  let p;
  try {
    p = curve.Point.fromBytes(point);
  } catch (err) {
    throw new Error(`el punto no está en P-256 (${String(err)})`);
  }
  if (p.is0()) throw new Error("punto en el infinito");
  return point;
}

/**
 * ECDSA P-256/SHA-256 de `msg` con firma compacta r‖s de 64 bytes. Exige s bajo (§3): la misma decisión no
 * puede tener dos firmas válidas. Nunca lanza.
 */
export function verifySignature(spki: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  try {
    if (sig.length !== SIG_LEN) return false;
    const r = bigOf(sig.subarray(0, 32));
    const s = bigOf(sig.subarray(32));
    if (r === 0n || s === 0n || r >= P256_N || s > P256_N >> 1n) return false;
    return curve.verify(sig, msg, spkiPoint(spki), { lowS: true, prehash: true, format: "compact" }) === true;
  } catch {
    return false;
  }
}

/** HMAC-SHA256 (RFC 2104, bloque de 64 bytes). */
export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const B = 64;
  const k = new Uint8Array(B);
  k.set(key.length > B ? sha256(key) : key);
  const inner = new Uint8Array(B + msg.length);
  const outer = new Uint8Array(B + 32);
  for (let i = 0; i < B; i++) {
    inner[i] = k[i]! ^ 0x36;
    outer[i] = k[i]! ^ 0x5c;
  }
  inner.set(msg, B);
  outer.set(sha256(inner), B);
  return sha256(outer);
}

// ---------- entradas firmadas (§3.1 a §3.3) ----------

/** Un permiso retenido, con los datos que generó el propio Nod (de ellos sale `ah`). `exp` en segundos Unix. */
export interface ApprovalData {
  instance: string;
  id: Uint8Array;
  toolUseId: string;
  tool: string;
  summary: string;
  wok: boolean;
  exp: number;
}

export type DecisionValue = "allow" | "deny";

export function approvalInput(a: ApprovalData): Uint8Array {
  return encode(["nod-approval", 1, a.instance, a.id, a.toolUseId, a.tool, a.summary, a.wok, a.exp]);
}

/** `ah`: lo que el aprobador vio. Lo firma dentro de la decisión, así el controlador no puede cambiarlo. */
export function approvalHash(a: ApprovalData): Uint8Array {
  return sha256(approvalInput(a));
}

export function decisionInput(id: Uint8Array, toolUseId: string, decision: string, ts: number, ah: Uint8Array): Uint8Array {
  return encode(["nod-decision", 1, id, toolUseId, decision, ts, ah]);
}

/** `sid`: ata un mensaje a una sesión sin revelar su id al aprobador. */
export function sessionSid(instance: string, session: string): Uint8Array {
  return sha256(encode(["nod-session", 1, instance, session])).slice(0, SID_LEN);
}

export function messageInput(id: Uint8Array, ts: number, instance: string, sid: Uint8Array, kind: string, text: string): Uint8Array {
  return encode(["nod-message", 1, id, ts, instance, sid, kind, text]);
}

export function pairInput(instance: string, spki: Uint8Array): Uint8Array {
  return encode(["nod-pair", 1, instance, spki]);
}

export function pairTag(k: Uint8Array, instance: string, spki: Uint8Array): Uint8Array {
  return hmacSha256(k, pairInput(instance, spki));
}

/** ¿`tag` es el de esta llave para esta instancia con este K? Comparación en tiempo constante. */
export function verifyPairTag(k: Uint8Array, instance: string, spki: Uint8Array, tag: Uint8Array): boolean {
  if (k.length !== PAIR_K_LEN || tag.length !== TAG_LEN) return false;
  return sameBytes(pairTag(k, instance, spki), tag);
}
