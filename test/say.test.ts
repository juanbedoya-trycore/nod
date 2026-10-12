import { describe, expect, it } from "vitest";
import * as noble from "../src/vendor/noble-p256.js";
import { SPKI_PREFIX, kidOf } from "../src/core/perm/verify.js";
import { encode } from "../src/protocol/cbor.js";
import { RECAP_PROMPT, parseSay, sayInput, sayPlan, sessionSid, verifySay } from "../src/core/say.js";

const p256 = (noble as any).p256;

function keypair(seed: number) {
  const sk = new Uint8Array(32);
  sk[31] = seed;
  sk[0] = 0x22;
  const pub: Uint8Array = p256.getPublicKey(sk, false);
  const spki = new Uint8Array(91);
  spki.set(SPKI_PREFIX, 0);
  spki.set(pub, 26);
  return { sk, spki, kid: kidOf(spki) };
}

const K = keypair(1);
const NOW = 1_700_000_000;
const nonce = (b: number) => new Uint8Array(16).fill(b);

const SESSION = "s-1";

function say(o: { kind?: "text" | "stop" | "recap"; text?: string; ts?: number; inst?: string; session?: string; key?: ReturnType<typeof keypair>; n?: number } = {}) {
  const k = o.key ?? K;
  const instanceId = o.inst ?? "mac-personal";
  const sid = sessionSid(instanceId, o.session ?? SESSION);
  const s = { nonce: nonce(o.n ?? 1), ts: o.ts ?? NOW, instanceId, sid, kind: o.kind ?? "text", text: o.text ?? "Continúa" } as const;
  const sig: Uint8Array = p256.sign(sayInput(s), k.sk, { lowS: true, prehash: true });
  return encode(["say", s.nonce, s.ts, s.instanceId, s.sid, s.kind, s.text, k.kid.slice(0, 8), sig]);
}

const keys = [{ kid: K.kid, spki: K.spki }];

describe("respuestas desde el reloj (§6.6)", () => {
  it("acepta un say válido de una llave emparejada", () => {
    expect(verifySay(say(), keys, NOW, "mac-personal", SESSION, new Set())).toMatchObject({ ok: true, kind: "text", text: "Continúa" });
    expect(verifySay(say({ kind: "stop", text: "" }), keys, NOW, "mac-personal", SESSION, new Set())).toMatchObject({ ok: true, kind: "stop" });
    expect(verifySay(say({ kind: "recap", text: "" }), keys, NOW, "mac-personal", SESSION, new Set())).toMatchObject({ ok: true, kind: "recap" });
  });

  it("un kind desconocido no se acepta", () => {
    const sid = sessionSid("mac-personal", SESSION);
    const s = { nonce: nonce(9), ts: NOW, instanceId: "mac-personal", sid, kind: "borra", text: "" } as const;
    const sig: Uint8Array = p256.sign(sayInput(s as never), K.sk, { lowS: true, prehash: true });
    const b = encode(["say", s.nonce, s.ts, s.instanceId, s.sid, s.kind, s.text, K.kid.slice(0, 8), sig]);
    expect(parseSay(b)).toBeUndefined();
    expect(verifySay(b, keys, NOW, "mac-personal", SESSION, new Set())).toEqual({ ok: false, reason: "malformed" });
  });

  it("rechaza lo que no firmó el reloj emparejado o no es para esta instancia", () => {
    expect(verifySay(say({ key: keypair(2) }), keys, NOW, "mac-personal", SESSION, new Set())).toEqual({ ok: false, reason: "kid" });
    expect(verifySay(say({ inst: "mac-otro" }), keys, NOW, "mac-personal", SESSION, new Set())).toEqual({ ok: false, reason: "instance" });
    const b = say();
    const forged = b.slice();
    forged[Buffer.from(forged).indexOf(Buffer.from("Continúa")) + 1] ^= 1; // cambia una letra de "Continúa"
    expect(verifySay(forged, keys, NOW, "mac-personal", SESSION, new Set())).toMatchObject({ ok: false });
    expect(verifySay(new Uint8Array([1, 2, 3]), keys, NOW, "mac-personal", SESSION, new Set())).toEqual({ ok: false, reason: "malformed" });
  });

  it("rechaza lo firmado para otra sesión de la misma instancia (el sid va firmado)", () => {
    expect(verifySay(say({ session: "s-2" }), keys, NOW, "mac-personal", SESSION, new Set())).toEqual({ ok: false, reason: "session" });
    // El mismo say, válido en su sesión, no sirve en otra: un servidor que lo lleve a otra cola no consigue nada.
    const b = say();
    expect(verifySay(b, keys, NOW, "mac-personal", SESSION, new Set()).ok).toBe(true);
    expect(verifySay(b, keys, NOW, "mac-personal", "s-2", new Set())).toEqual({ ok: false, reason: "session" });
    // Cambiar el sid en los bytes (para que case con otra sesión) rompe la firma.
    const other = sessionSid("mac-personal", "s-2");
    const p = parseSay(b)!;
    const swapped = encode(["say", p.nonce, p.ts, p.instanceId, other, p.kind, p.text, p.kid, p.sig]);
    expect(verifySay(swapped, keys, NOW, "mac-personal", "s-2", new Set())).toEqual({ ok: false, reason: "sig" });
  });

  it("sid: 16 bytes, depende de instancia y sesión", () => {
    const a = sessionSid("mac-personal", "s-1");
    expect(a.length).toBe(16);
    expect(Buffer.from(sessionSid("mac-personal", "s-1")).equals(Buffer.from(a))).toBe(true);
    expect(Buffer.from(sessionSid("mac-personal", "s-2")).equals(Buffer.from(a))).toBe(false);
    expect(Buffer.from(sessionSid("mac-work", "s-1")).equals(Buffer.from(a))).toBe(false);
  });

  it("el formato 1 (sin sid) ya no se acepta, aunque la firma sea buena", () => {
    const s = { nonce: nonce(9), ts: NOW, instanceId: "mac-personal", kind: "text", text: "Sí" };
    const v1 = encode(["orbit-say", 1, s.nonce, s.ts, s.instanceId, s.kind, s.text]);
    const sig: Uint8Array = p256.sign(v1, K.sk, { lowS: true, prehash: true });
    const bytes = encode(["say", s.nonce, s.ts, s.instanceId, s.kind, s.text, K.kid.slice(0, 8), sig]);
    expect(parseSay(bytes)).toBeUndefined();
    expect(verifySay(bytes, keys, NOW, "mac-personal", SESSION, new Set())).toEqual({ ok: false, reason: "malformed" });
  });

  it("ventana de tiempo y nonce de un solo uso", () => {
    expect(verifySay(say({ ts: NOW - 121 }), keys, NOW, "mac-personal", SESSION, new Set())).toEqual({ ok: false, reason: "expired" });
    expect(verifySay(say({ ts: NOW + 31 }), keys, NOW, "mac-personal", SESSION, new Set())).toEqual({ ok: false, reason: "expired" });
    const r = verifySay(say(), keys, NOW, "mac-personal", SESSION, new Set());
    expect(r.ok).toBe(true);
    const seen = new Set([(r as any).nonceHex]);
    expect(verifySay(say(), keys, NOW, "mac-personal", SESSION, seen)).toEqual({ ok: false, reason: "replay" });
  });

  it("el texto tiene tope de 1000 bytes", () => {
    expect(parseSay(say({ text: "x".repeat(1001) }))).toBeUndefined();
  });
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

describe("vectores de say firmados en Kotlin (protocol/vectors/sig/say.json)", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../protocol/vectors/sig");
  const v = JSON.parse(readFileSync(join(dir, "say.json"), "utf8"));
  const keyFile = JSON.parse(readFileSync(join(dir, "key.json"), "utf8"));
  const hexToBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x: string) => parseInt(x, 16)));
  const k = keyFile.keys.find((x: any) => x.name === v.key);
  const paired = [{ kid: hexToBytes(k.kid), spki: hexToBytes(k.spki) }];
  it("sid del vector = el que calcula el mod", () => {
    expect(v.format).toBe(2);
    expect(Buffer.from(sessionSid(v.instance, v.session_id)).toString("hex")).toBe(v.sid);
  });
  for (const c of v.cases) {
    it(c.name, () => {
      const r = verifySay(hexToBytes(c.say), paired, v.now, v.instance, v.session_id, new Set());
      if (c.ok) expect(r.ok).toBe(true);
      else expect(r).toEqual({ ok: false, reason: c.reason });
    });
  }
});

describe("qué hace el mod con cada say (§6.6)", () => {
  it("text: prompt propio sin turno; nota con turno", () => {
    expect(sayPlan("text", "Sí", false)).toEqual({ abort: false, submitNow: "Sí" });
    expect(sayPlan("text", "Sí", true)).toEqual({ abort: false, note: "Sí" });
  });

  it("stop: corta el turno y nunca manda su texto como prompt", () => {
    expect(sayPlan("stop", "Detente", true)).toEqual({ abort: true });
    expect(sayPlan("stop", "Detente", false)).toEqual({ abort: false });
  });

  it("recap: corta y pide el resumen al quedar libre; sin turno lo pide ya", () => {
    expect(sayPlan("recap", "", true)).toEqual({ abort: true, submitAfterTurn: RECAP_PROMPT });
    expect(sayPlan("recap", "  ", false)).toEqual({ abort: false, submitNow: RECAP_PROMPT });
    expect(sayPlan("recap", "¿Qué falla?", true)).toEqual({ abort: true, submitAfterTurn: "¿Qué falla?" });
    expect(RECAP_PROMPT).toMatch(/bloquea/);
  });
});
