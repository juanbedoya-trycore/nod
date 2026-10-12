import { describe, expect, it } from "vitest";
import { mergeStoredKeys, readSharedKeys, writeSharedKeys } from "../src/core/pairing.js";
import type { StoredKey } from "../src/core/pairing.js";
import { b64uEncode, hexOf } from "../src/core/pairing.js";
import { kidOf } from "../src/core/perm/verify.js";
import { p256 } from "../src/vendor/noble-p256.js";

function key(seed: number, at: number): StoredKey {
  const priv = new Uint8Array(32).fill(seed);
  const pub = p256.getPublicKey(priv, false);
  const spki = new Uint8Array([
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, ...pub,
  ]);
  return { kid: hexOf(kidOf(spki)), spki: b64uEncode(spki), label: `reloj ${seed}`, paired_at: at };
}

describe("llaves compartidas entre perfiles (paired-keys.json)", () => {
  it("un fichero ausente o corrupto cuenta como vacío", () => {
    expect(readSharedKeys(undefined).instances).toEqual({});
    expect(readSharedKeys("{no es json").instances).toEqual({});
    expect(readSharedKeys(JSON.stringify({ v: 2, instances: {} })).instances).toEqual({});
  });

  it("guarda y relee las llaves de una instancia sin tocar las de otra", () => {
    const a = key(1, 10);
    const b = key(2, 20);
    let text = writeSharedKeys(readSharedKeys(undefined), "mac-personal", { v: 1, keys: [a] });
    text = writeSharedKeys(readSharedKeys(text), "mac-otro", { v: 1, keys: [b] });
    const r = readSharedKeys(text);
    expect(r.instances["mac-personal"]!.map((k) => k.kid)).toEqual([a.kid]);
    expect(r.instances["mac-otro"]!.map((k) => k.kid)).toEqual([b.kid]);
    const sinA = readSharedKeys(writeSharedKeys(r, "mac-personal", null));
    expect(sinA.instances["mac-personal"]).toBeUndefined();
    expect(sinA.instances["mac-otro"]).toHaveLength(1);
  });

  it("una entrada manipulada (kid que no corresponde a la SPKI) se descarta al leer", () => {
    const a = key(3, 10);
    const bad = { ...key(4, 11), kid: a.kid };
    const text = JSON.stringify({ v: 1, instances: { "mac-personal": [bad, a] } });
    expect(readSharedKeys(text).instances["mac-personal"]!.map((k) => k.kid)).toEqual([a.kid]);
  });

  it("la migración une sin duplicar y se queda con las más recientes", () => {
    const a = key(5, 10);
    const b = key(6, 30);
    const m = mergeStoredKeys([a], [a, b]);
    expect(m.map((k) => k.kid)).toEqual([b.kid, a.kid]);
  });
});
