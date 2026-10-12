/**
 * Vectores de firma compartidos (protocol/vectors/sig/, SPEC §6.3). Las firmas válidas las generó
 * android/shared (DecisionSigner + SoftwareSigner, JCA): aquí el mod las verifica con verifyDecision.
 * Kotlin pasa exactamente los mismos casos en SigVectorsTest.kt.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { derToRaw, kidOf, rawToDer, spkiPoint, verifyDecision, REJECT_WIRE } from "../src/core/perm/verify.js";
import type { PairedKey } from "../src/core/perm/verify.js";
import { WORDS, fingerprint } from "../src/core/pairing.js";
import { hexDecode, hexEncode } from "../src/protocol/index.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../protocol/vectors/sig");
const load = (f: string) => JSON.parse(readFileSync(join(DIR, f), "utf8"));

interface DecCase {
  name: string;
  pending: { nonce: string; tool_use_id: string; exp: number; wok: boolean; resolved: boolean; instance_id: string; tool: string; sum: string };
  now: number;
  dec: string;
  expect: "accept" | "reject";
  reject?: string;
  cause?: string;
}

describe("protocol/vectors/sig/decisions.json", () => {
  const v = load("decisions.json");
  const paired: PairedKey[] = v.paired.map((p: { kid: string; spki: string }) => ({ kid: hexDecode(p.kid), spki: hexDecode(p.spki) }));
  const cases: DecCase[] = v.cases;

  it("tiene todos los resultados posibles", () => {
    const seen = new Set(cases.map((c) => c.cause ?? "accept"));
    for (const k of ["accept", ...Object.keys(REJECT_WIRE)]) expect(seen, k).toContain(k);
  });

  for (const c of cases) {
    it(`${c.name} -> ${c.expect === "accept" ? "aceptar" : c.cause}`, () => {
      const pending = {
        nonce: hexDecode(c.pending.nonce),
        toolUseId: c.pending.tool_use_id,
        exp: c.pending.exp,
        wok: c.pending.wok,
        resolved: c.pending.resolved,
        instanceId: c.pending.instance_id,
        tool: c.pending.tool,
        sum: c.pending.sum,
      };
      const r = verifyDecision(pending, hexDecode(c.dec), paired, c.now);
      if (c.expect === "accept") {
        expect(r.ok, JSON.stringify(r)).toBe(true);
      } else {
        expect(r).toEqual({ ok: false, cause: c.cause, reject: c.reject });
      }
    });
  }

  it("sin llaves emparejadas no se acepta ninguna", () => {
    for (const c of cases) {
      const p = {
        nonce: hexDecode(c.pending.nonce),
        toolUseId: c.pending.tool_use_id,
        exp: c.pending.exp,
        wok: c.pending.wok,
        resolved: c.pending.resolved,
        instanceId: c.pending.instance_id,
        tool: c.pending.tool,
        sum: c.pending.sum,
      };
      expect(verifyDecision(p, hexDecode(c.dec), [], c.now).ok).toBe(false);
    }
  });
});

describe("protocol/vectors/sig/der.json", () => {
  const v = load("der.json");
  for (const c of v.valid) {
    it(`válido ${c.name}`, () => {
      expect(hexEncode(derToRaw(hexDecode(c.der)))).toBe(c.raw);
      expect(hexEncode(derToRaw(hexDecode(c.der), true))).toBe(c.raw_low_s);
      expect(hexEncode(rawToDer(hexDecode(c.raw)))).toBe(c.der_min);
    });
  }
  for (const c of v.invalid) {
    it(`inválido ${c.name}`, () => {
      expect(() => derToRaw(hexDecode(c.der))).toThrow(/DER inválido/);
    });
  }
});

describe("protocol/vectors/sig/fingerprint.json y key.json", () => {
  const v = load("fingerprint.json");
  it("misma lista de palabras que Kotlin", () => {
    expect([...WORDS]).toEqual(v.words);
    expect(new Set(WORDS.map((w) => w.slice(0, 4))).size).toBe(256);
  });
  for (const c of v.cases) {
    it(`huella ${c.name}`, () => {
      const kid = hexDecode(c.kid);
      if (c.spki !== null) expect(hexEncode(kidOf(hexDecode(c.spki)))).toBe(c.kid);
      expect(fingerprint(kid)).toEqual({ hex: c.hex, words: c.words });
    });
  }
  for (const c of v.bad_spki) {
    it(`SPKI inválido ${c.name}`, () => {
      expect(() => spkiPoint(hexDecode(c.spki))).toThrow();
    });
  }
  it("llaves de prueba: kid = SHA-256(SPKI)[0..8]", () => {
    for (const k of load("key.json").keys) {
      expect(hexEncode(kidOf(hexDecode(k.spki)))).toBe(k.kid);
      expect(hexEncode(spkiPoint(hexDecode(k.spki)))).toBe(`04${k.x}${k.y}`);
    }
  });
});
