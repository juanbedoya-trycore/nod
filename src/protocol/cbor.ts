/**
 * CBOR determinista mínimo (SPEC §7): uint, tstr, bstr, bool y arrays definidos.
 * Sin dependencias: el mod corre en un sandbox sin Node ni DOM.
 */

export type CborValue = number | boolean | string | Uint8Array | CborValue[];

export type CborErrorKind = "parse" | "forbidden-type" | "noncanonical" | "schema" | "json";

export class ProtocolError extends Error {
  readonly kind: CborErrorKind;
  constructor(kind: CborErrorKind, message: string) {
    super(`${kind}: ${message}`);
    this.name = "ProtocolError";
    this.kind = kind;
  }
}

const MAX_UINT = Number.MAX_SAFE_INTEGER; // 2^53-1, tope de u53 (SPEC §2)
const utf8 = new TextEncoder();
const utf8Strict = new TextDecoder("utf-8", { fatal: true });

function header(major: number, n: number): number[] {
  const m = major << 5;
  if (n < 24) return [m | n];
  if (n < 0x100) return [m | 24, n];
  if (n < 0x10000) return [m | 25, n >> 8, n & 0xff];
  if (n < 0x100000000) return [m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const out = [m | 27];
  let big = BigInt(n);
  const tail: number[] = [];
  for (let i = 0; i < 8; i++) {
    tail.unshift(Number(big & 0xffn));
    big >>= 8n;
  }
  return out.concat(tail);
}

function encodeInto(v: CborValue, out: number[]): void {
  if (typeof v === "boolean") {
    out.push(v ? 0xf5 : 0xf4);
  } else if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new ProtocolError("forbidden-type", `número no uint seguro: ${v}`);
    }
    out.push(...header(0, v));
  } else if (typeof v === "string") {
    const b = utf8.encode(v);
    out.push(...header(3, b.length));
    for (const x of b) out.push(x);
  } else if (v instanceof Uint8Array) {
    out.push(...header(2, v.length));
    for (const x of v) out.push(x);
  } else if (Array.isArray(v)) {
    out.push(...header(4, v.length));
    for (const item of v) encodeInto(item, out);
  } else {
    throw new ProtocolError("forbidden-type", "tipo no representable en 0.2.0");
  }
}

/** Codifica a CBOR determinista (longitud mínima, solo longitudes definidas, sin mapas). */
export function encode(value: CborValue): Uint8Array {
  const out: number[] = [];
  encodeInto(value, out);
  return Uint8Array.from(out);
}

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}

  byte(): number {
    const b = this.buf[this.pos];
    if (b === undefined) throw new ProtocolError("parse", "fin de datos inesperado");
    this.pos++;
    return b;
  }

  take(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new ProtocolError("parse", "fin de datos inesperado");
    const s = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }

  /** Lee el argumento de un head y exige la codificación más corta. */
  arg(info: number): number {
    if (info < 24) return info;
    if (info === 31) throw new ProtocolError("noncanonical", "longitud indefinida");
    if (info > 27) throw new ProtocolError("parse", `info reservada ${info}`);
    const size = 1 << (info - 24);
    const raw = this.take(size);
    let n = 0n;
    for (const b of raw) n = (n << 8n) | BigInt(b);
    const min = info === 24 ? 24n : info === 25 ? 0x100n : info === 26 ? 0x10000n : 0x100000000n;
    if (n < min) throw new ProtocolError("noncanonical", "entero o longitud no mínimos");
    if (n > BigInt(MAX_UINT)) throw new ProtocolError("schema", "valor mayor que 2^53-1");
    return Number(n);
  }

  value(): CborValue {
    const ib = this.byte();
    const major = ib >> 5;
    const info = ib & 0x1f;
    switch (major) {
      case 0:
        return this.arg(info);
      case 1:
        throw new ProtocolError("forbidden-type", "entero negativo");
      case 2:
        return Uint8Array.from(this.take(this.arg(info)));
      case 3:
        try {
          return utf8Strict.decode(this.take(this.arg(info)));
        } catch (e) {
          if (e instanceof ProtocolError) throw e;
          throw new ProtocolError("parse", "UTF-8 inválido");
        }
      case 4: {
        const n = this.arg(info);
        const items: CborValue[] = [];
        for (let i = 0; i < n; i++) items.push(this.value());
        return items;
      }
      case 5:
        throw new ProtocolError("forbidden-type", "mapa");
      case 6:
        throw new ProtocolError("forbidden-type", "tag");
      default:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) throw new ProtocolError("forbidden-type", "null");
        if (info >= 25 && info <= 27) throw new ProtocolError("forbidden-type", "float");
        throw new ProtocolError("forbidden-type", `simple/float ${info}`);
    }
  }
}

/** Decodifica rechazando CBOR no determinista y los tipos que 0.2.0 prohíbe. */
export function decodeStrict(bytes: Uint8Array): CborValue {
  const r = new Reader(bytes);
  const v = r.value();
  if (r.pos !== bytes.length) throw new ProtocolError("parse", "bytes sobrantes tras el valor");
  return v;
}
