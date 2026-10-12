/**
 * vectors/control/ contra la implementación de Nod: kid, ah, sid, tag, entradas firmadas y cada caso que debe
 * fallar, con el motivo exacto del orden de docs/control-v1.md §4.1 y §4.2.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TEST_KIDS, isTestKid, parseApprovers } from "../src/core/control/approvers.js";
import {
  P256_N,
  approvalHash,
  b64u,
  decisionInput,
  fromB64u,
  fromHex,
  hex,
  hmacSha256,
  kidOf,
  messageInput,
  pairTag,
  sessionSid,
  verifyPairTag,
  verifySignature,
} from "../src/core/control/crypto.js";
import type { ApprovalData } from "../src/core/control/crypto.js";
import { verifyDecision, verifyMessage } from "../src/core/control/verify.js";
import type { PairedKey } from "../src/core/control/verify.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../vectors/control");
const load = (name: string) => JSON.parse(readFileSync(join(DIR, name), "utf8"));
const KEYS = load("key.json");
const APPROVAL = load("approval.json");
const MESSAGE = load("message.json");
const PAIRING = load("pairing.json");

/** En los vectores las llaves de prueba SÍ están emparejadas: aquí se pasan a mano, sin approvers.json. */
const paired = (kids: string[]): PairedKey[] =>
  KEYS.keys.filter((k: any) => kids.includes(k.kid)).map((k: any) => ({ kid: fromHex(k.kid), spki: fromHex(k.spki) }));

const pendingOf = (p: any): ApprovalData => ({ instance: p.instance, id: fromHex(p.id), toolUseId: p.tool_use_id, tool: p.tool, summary: p.summary, wok: p.wok, exp: p.exp });

describe("llaves", () => {
  it("kid = SHA-256(SPKI)[0..8] y las de prueba se reconocen", () => {
    for (const k of KEYS.keys) {
      expect(hex(kidOf(fromHex(k.spki)))).toBe(k.kid);
      expect(isTestKid(fromHex(k.kid))).toBe(true);
    }
    expect([...TEST_KIDS].sort()).toEqual(KEYS.keys.map((k: any) => k.kid).sort());
  });

  it("una llave de prueba en approvers.json nunca cuenta", () => {
    const k = KEYS.keys[0];
    const text = JSON.stringify({ v: 1, keys: [{ kid: b64u(fromHex(k.kid)), spki: b64u(fromHex(k.spki)), added_ms: 1 }] });
    const r = parseApprovers(text);
    expect(r.keys).toEqual([]);
    expect(r.ignored.join()).toContain("llave de prueba");
  });
});

describe("permisos (approval.json)", () => {
  for (const c of APPROVAL.cases) {
    it(`${c.name} → ${c.expect}`, () => {
      const pending = pendingOf(c.pending);
      expect(hex(approvalHash(pending))).toBe(c.ah);
      const r = verifyDecision(pending, c.decision, paired(APPROVAL.paired), c.now);
      expect(r.ok ? "ok" : r.reason).toBe(c.expect);
      if (c.expect === "ok") {
        // La entrada firmada es exactamente la del vector, reconstruida con los datos de Nod.
        expect(hex(decisionInput(pending.id, pending.toolUseId, c.decision.decision, c.decision.ts, approvalHash(pending)))).toBe(c.signing_input);
      }
    });
  }

  it("una decisión válida para un permiso ya resuelto es replay (antes que kid o firma)", () => {
    const c = APPROVAL.cases[0];
    const r = verifyDecision(pendingOf(c.pending), c.decision, paired(APPROVAL.paired), c.now, true);
    expect(r).toEqual({ ok: false, reason: "replay" });
  });

  it("ya pasado exp, una firma válida y con ts en plazo vence igual", () => {
    const c = APPROVAL.cases[0];
    expect(verifyDecision(pendingOf(c.pending), c.decision, paired(APPROVAL.paired), c.pending.exp + 1)).toEqual({ ok: false, reason: "expired" });
  });

  it("s alta (la otra firma válida de la misma decisión) se rechaza", () => {
    const c = APPROVAL.cases[0];
    const sig = fromB64u(c.decision.sig);
    let s = 0n;
    for (const b of sig.subarray(32)) s = (s << 8n) | BigInt(b);
    const high = P256_N - s;
    const hi = new Uint8Array(64);
    hi.set(sig.subarray(0, 32));
    for (let i = 63, x = high; i >= 32; i--, x >>= 8n) hi[i] = Number(x & 0xffn);
    const pending = pendingOf(c.pending);
    const input = decisionInput(pending.id, pending.toolUseId, "allow", c.decision.ts, approvalHash(pending));
    const spki = paired(APPROVAL.paired)[0]!.spki;
    expect(verifySignature(spki, input, sig)).toBe(true);
    expect(verifySignature(spki, input, hi)).toBe(false);
    expect(verifyDecision(pending, { ...c.decision, sig: b64u(hi) }, paired(APPROVAL.paired), c.now)).toEqual({ ok: false, reason: "sig" });
  });

  it("formas raras: kid corto, ts negativo o decimal, campos que faltan", () => {
    const c = APPROVAL.cases[0];
    const pending = pendingOf(c.pending);
    const keys = paired(APPROVAL.paired);
    for (const bad of [{ ...c.decision, kid: "AAAA" }, { ...c.decision, ts: -1 }, { ...c.decision, ts: 1.5 }, { decision: "allow" }, null, "allow", { ...c.decision, sig: c.decision.sig + "=" }]) {
      expect(verifyDecision(pending, bad, keys, c.now)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("un kid de la lista que no es el de su SPKI no cuenta", () => {
    const c = APPROVAL.cases[0];
    const [a] = paired(APPROVAL.paired);
    const other = paired(KEYS.keys.map((k: any) => k.kid))[1]!;
    // El fichero dice que el kid del aprobador es de la otra llave: la firma del aprobador no debe valer.
    expect(verifyDecision(pendingOf(c.pending), c.decision, [{ kid: a!.kid, spki: other.spki }], c.now)).toEqual({ ok: false, reason: "kid" });
  });
});

describe("mensajes (message.json)", () => {
  const ctx = { instance: MESSAGE.instance, sid: sessionSid(MESSAGE.instance, MESSAGE.session) };

  it("sid = SHA-256(CBOR [nod-session, 1, instance, session])[0..16]", () => {
    expect(hex(ctx.sid)).toBe(MESSAGE.sid);
  });

  for (const c of MESSAGE.cases) {
    it(`${c.name} → ${c.expect}`, () => {
      const r = verifyMessage(c.message, ctx, paired(MESSAGE.paired), MESSAGE.now, new Set());
      expect(r.ok ? "ok" : r.reason).toBe(c.expect);
      if (c.expect === "ok") {
        const m = c.message;
        expect(hex(messageInput(fromB64u(m.id), m.ts, MESSAGE.instance, fromB64u(m.sid), m.kind, m.text))).toBe(c.signing_input);
        expect(r).toMatchObject({ kind: m.kind, text: m.text, id: m.id });
      }
    });
  }

  it("un id ya visto es replay", () => {
    const c = MESSAGE.cases[0];
    expect(verifyMessage(c.message, ctx, paired(MESSAGE.paired), MESSAGE.now, new Set([c.message.id]))).toEqual({ ok: false, reason: "replay" });
  });

  it("firmado para otra instancia: la firma no vale con la de Nod", () => {
    const c = MESSAGE.cases[0];
    // El controlador no puede reenviar a esta instancia un mensaje firmado para otra con el mismo sid.
    const r = verifyMessage(c.message, { instance: "otra-0000", sid: ctx.sid }, paired(MESSAGE.paired), MESSAGE.now, new Set());
    expect(r).toEqual({ ok: false, reason: "sig" });
  });

  it("del futuro (> 120 s) también vence; texto de más de 1000 bytes es malformed", () => {
    const c = MESSAGE.cases[0];
    expect(verifyMessage(c.message, ctx, paired(MESSAGE.paired), c.message.ts - 121, new Set())).toEqual({ ok: false, reason: "expired" });
    expect(verifyMessage(c.message, ctx, paired(MESSAGE.paired), c.message.ts - 120, new Set()).ok).toBe(true);
    expect(verifyMessage({ ...c.message, text: "é".repeat(501) }, ctx, paired(MESSAGE.paired), MESSAGE.now, new Set())).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("emparejamiento (pairing.json)", () => {
  const k = fromB64u(PAIRING.k);
  for (const c of PAIRING.cases) {
    it(`${c.name} → ${c.expect}`, () => {
      expect(verifyPairTag(k, PAIRING.instance, fromB64u(c.spki), fromB64u(c.tag))).toBe(c.expect);
    });
  }

  it("el tag válido es el HMAC del vector", () => {
    const c = PAIRING.cases[0];
    expect(b64u(pairTag(k, PAIRING.instance, fromB64u(c.spki)))).toBe(c.tag);
  });

  it("HMAC-SHA256: RFC 4231, casos 1, 2 y 6 (llave más larga que el bloque)", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(hex(hmacSha256(new Uint8Array(20).fill(0x0b), enc("Hi There")))).toBe("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
    expect(hex(hmacSha256(enc("Jefe"), enc("what do ya want for nothing?")))).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    expect(hex(hmacSha256(new Uint8Array(131).fill(0xaa), enc("Test Using Larger Than Block-Size Key - Hash Key First")))).toBe(
      "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
    );
  });

  it("base64url estricto: sin relleno, sin caracteres ajenos ni bits sobrantes", () => {
    expect(() => fromB64u("AB==")).toThrow();
    expect(() => fromB64u("A+B/")).toThrow();
    expect(fromB64u("AQ")).toEqual(Uint8Array.of(1));
    expect(() => fromB64u("AR")).toThrow(); // 'R' deja un bit a 1 que no es de ningún byte
    expect(b64u(fromB64u(PAIRING.k))).toBe(PAIRING.k);
  });
});
