/** Forma JSON de las tramas (golden vectors): bytes como `{"$hex": "..."}`. */

import { type CborValue, ProtocolError } from "./cbor.js";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function hexEncode(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function hexDecode(s: string): Uint8Array {
  if (!/^([0-9a-f]{2})*$/.test(s)) throw new ProtocolError("json", `hex inválido: ${s}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function cborToJson(v: CborValue): Json {
  if (v instanceof Uint8Array) return { $hex: hexEncode(v) };
  if (Array.isArray(v)) return v.map(cborToJson);
  return v;
}

export function jsonToCbor(j: Json): CborValue {
  if (typeof j === "number") {
    if (!Number.isSafeInteger(j) || j < 0) throw new ProtocolError("json", `número no uint: ${j}`);
    return j;
  }
  if (typeof j === "string" || typeof j === "boolean") return j;
  if (Array.isArray(j)) return j.map(jsonToCbor);
  if (j !== null && typeof j === "object") {
    const keys = Object.keys(j);
    const hex = j["$hex"];
    if (keys.length === 1 && typeof hex === "string") return hexDecode(hex);
  }
  throw new ProtocolError("json", "valor JSON no admitido");
}
