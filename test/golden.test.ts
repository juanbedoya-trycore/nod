/**
 * Golden vectors de protocol/vectors/ (SPEC §7, protocol/vectors/INDEX.md).
 *
 * Positivos: decodifica el .cbor, compara con el .json, re-codifica y compara byte a
 * byte con el .cbor. Negativos: el decodificador estricto debe rechazarlos con el
 * motivo que declara el vector.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type CborValue,
  type Json,
  ProtocolError,
  cborToJson,
  decodeFrame,
  decodeStrict,
  encode,
  encodeFrame,
  frameToCbor,
  hexEncode,
  jsonToCbor,
  nodeToCbor,
  opToCbor,
  parseFrame,
  parseNode,
  parseOp,
  parsePermHashInput,
  parseSigningInput,
  permHashInputToCbor,
  signingInputToCbor,
} from "../src/protocol/index.js";
import { permHash } from "../src/core/perm/verify.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../protocol/vectors");

interface Meta {
  name: string;
  kind: string;
  expect: "accept" | "reject";
  check?: string;
  schema?: string | null;
  data?: Json;
  ph?: string;
}

interface Vector {
  name: string;
  meta: Meta;
  cbor: Uint8Array;
}

/** .json sin .cbor permitidos: la ingesta es JSON por contrato (SPEC §1, §3). */
const SOLO_JSON = ["ingest-evento-crudo"];

function loadVectors(): Vector[] {
  const names = readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length));
  for (const n of names) {
    if (!existsSync(join(DIR, `${n}.cbor`)) && !SOLO_JSON.includes(n)) {
      throw new Error(`${n}.json no tiene .cbor y no está en la lista de excepciones SOLO_JSON`);
    }
  }
  return names
    .filter((n) => existsSync(join(DIR, `${n}.cbor`)))
    .sort()
    .map((name) => {
      const meta = JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as Meta;
      const cbor = new Uint8Array(readFileSync(join(DIR, `${name}.cbor`)));
      const hex = readFileSync(join(DIR, `${name}.hex`), "utf8").trim();
      expect(hex, `${name}: .hex no coincide con .cbor`).toBe(hexEncode(cbor));
      expect(meta.name, `${name}: campo name distinto del fichero`).toBe(name);
      return { name, meta, cbor };
    });
}

/** Tipa según el `schema` del vector y devuelve el valor tipado y su vuelta a CBOR. */
function typed(schema: string | null | undefined, v: CborValue, kind?: string): { value: unknown; back: CborValue } {
  if ((schema === null || schema === undefined) && kind === "perm-hash") {
    const value = parsePermHashInput(v);
    return { value, back: permHashInputToCbor(value) };
  }
  if (schema === "frame") {
    const value = parseFrame(v);
    return { value, back: frameToCbor(value) };
  }
  if (schema === "frame#/$defs/node") {
    const value = parseNode(v);
    return { value, back: nodeToCbor(value) };
  }
  if (typeof schema === "string" && schema.startsWith("frame#/$defs/op")) {
    const value = parseOp(v);
    return { value, back: opToCbor(value) };
  }
  if (schema === null || schema === undefined) {
    const value = parseSigningInput(v);
    return { value, back: signingInputToCbor(value) };
  }
  throw new Error(`schema de vector no soportado: ${schema}`);
}

const vectors = loadVectors();
const positives = vectors.filter((v) => v.meta.expect === "accept");
const negatives = vectors.filter((v) => v.meta.expect === "reject");

function kindOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof ProtocolError) return e.kind;
    throw e;
  }
  return undefined;
}

describe("inventario de vectores", () => {
  it("hay 43 vectores con .cbor (44 menos la ingesta), 36 positivos y 7 negativos", () => {
    expect(vectors).toHaveLength(43);
    expect(positives).toHaveLength(36);
    expect(negatives).toHaveLength(7);
  });
});

describe("positivos: ida y vuelta byte a byte", () => {
  it.each(positives.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    const data = v.meta.data;
    expect(data, "el vector no trae data").toBeDefined();

    // 1. decodifica el .cbor (estricto) y compara con el .json
    const decoded = decodeStrict(v.cbor);
    expect(cborToJson(decoded)).toEqual(data);

    // 2. tipado desde el .cbor y desde el .json: mismo valor
    const fromCbor = typed(v.meta.schema, decoded, v.meta.kind);
    const fromJson = typed(v.meta.schema, jsonToCbor(data as Json), v.meta.kind);
    expect(fromJson.value).toEqual(fromCbor.value);

    // 3. re-codifica y compara byte a byte con el .cbor
    expect(hexEncode(encode(fromCbor.back))).toBe(hexEncode(v.cbor));
  });

  it("las tramas pasan por decodeFrame/encodeFrame", () => {
    for (const v of positives.filter((x) => x.meta.schema === "frame")) {
      expect(hexEncode(encodeFrame(decodeFrame(v.cbor))), v.name).toBe(hexEncode(v.cbor));
    }
  });
});

describe("formato de firma 2 (SPEC §6.3): ph", () => {
  it("perm-hash-entrada sale de frame-perm, su SHA-256 es ph y lo llevan dec-entrada-firmada y frame-dec", () => {
    const get = (n: string): Vector => vectors.find((x) => x.name === n)!;
    const phVec = get("perm-hash-entrada");
    const input = parsePermHashInput(decodeStrict(phVec.cbor));
    const perm = decodeFrame(get("frame-perm").cbor);
    if (perm.type !== "perm") throw new Error("frame-perm no es perm");
    expect(input).toEqual({ instanceId: perm.instanceId, nonce: perm.nonce, toolUseId: perm.toolUseId, tool: perm.tool, sum: perm.sum, wok: perm.wok, exp: perm.exp });
    expect(hexEncode(permHash(input))).toBe(phVec.meta.ph);
    expect(hexEncode(parseSigningInput(decodeStrict(get("dec-entrada-firmada").cbor)).ph)).toBe(phVec.meta.ph);
    const dec = decodeFrame(get("frame-dec").cbor);
    if (dec.type !== "dec") throw new Error("frame-dec no es dec");
    expect(hexEncode(dec.ph)).toBe(phVec.meta.ph);
  });

  it("la entrada firmada de formato 1 ya no se acepta", () => {
    const s = parseSigningInput(decodeStrict(vectors.find((x) => x.name === "dec-entrada-firmada")!.cbor));
    expect(kindOf(() => parseSigningInput(["orbit-dec", 1, s.nonce, s.toolUseId, s.decision, s.ts]))).toBe("schema");
    expect(kindOf(() => parseSigningInput(["orbit-dec", 1, s.nonce, s.toolUseId, s.decision, s.ts, s.ph]))).toBe("schema");
  });
});

describe("negativos: se rechazan por el motivo declarado", () => {
  it.each(negatives.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    switch (v.meta.check) {
      case "noncanonical":
        expect(kindOf(() => decodeStrict(v.cbor))).toBe("noncanonical");
        break;
      case "forbidden-type":
        expect(kindOf(() => decodeStrict(v.cbor))).toBe("forbidden-type");
        break;
      case "schema": {
        // CBOR canónico y bien formado, pero el schema lo rechaza.
        const decoded = decodeStrict(v.cbor);
        expect(cborToJson(decoded)).toEqual(v.meta.data);
        expect(kindOf(() => typed(v.meta.schema, decoded))).toBe("schema");
        expect(kindOf(() => typed(v.meta.schema, jsonToCbor(v.meta.data as Json)))).toBe("schema");
        break;
      }
      default:
        throw new Error(`check desconocido: ${v.meta.check}`);
    }
  });
});

describe("guarda del propio test", () => {
  it("alterar cualquier byte de un positivo rompe la comparación con el .json", () => {
    const v = vectors.find((x) => x.name === "frame-delta-add")!;
    for (let i = 0; i < v.cbor.length; i++) {
      const mutated = Uint8Array.from(v.cbor);
      mutated[i] = (mutated[i] ?? 0) ^ 0x01;
      let same = false;
      try {
        same = JSON.stringify(cborToJson(decodeStrict(mutated))) === JSON.stringify(v.meta.data);
      } catch {
        same = false;
      }
      expect(same, `byte ${i}`).toBe(false);
    }
  });
});
