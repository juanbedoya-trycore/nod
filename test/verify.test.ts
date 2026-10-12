/** verifyDecision (SPEC §6.3) con llaves generadas en el test, más el empaquetado de noble. */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as noble from "../src/vendor/noble-p256.js";
import {
  SPKI_PREFIX,
  kidOf,
  makeDecisionVerifier,
  permHash,
  signingInput,
  verifyDecision,
  verifySignature,
} from "../src/core/perm/verify.js";
import { encode, encodeFrame, hexEncode } from "../src/protocol/index.js";
import type { Decision } from "../src/protocol/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const p256 = (noble as any).p256;

function keypair(seed: number) {
  const sk = new Uint8Array(32);
  sk[31] = seed;
  sk[0] = 0x11;
  const pub: Uint8Array = p256.getPublicKey(sk, false);
  const spki = new Uint8Array(91);
  spki.set(SPKI_PREFIX, 0);
  spki.set(pub, 26);
  return { sk, spki, kid: kidOf(spki) };
}

const nonce = Uint8Array.from({ length: 16 }, (_, i) => i);
const tuid = "toolu_test";
const pending = { nonce, toolUseId: tuid, exp: 1000, wok: true, instanceId: "mac-personal", tool: "Bash", sum: "touch x" };
type Shown = Partial<{ instanceId: string; tool: string; sum: string; wok: boolean; exp: number }>;

/** dec firmada como el reloj: ph de lo que muestra (el pendiente con `shown` encima) y formato 2. */
function dec(k: ReturnType<typeof keypair>, decision: Decision, ts: number, over?: Partial<{ nonce: Uint8Array; toolUseId: string }>, shown: Shown = {}) {
  const n = over?.nonce ?? nonce;
  const t = over?.toolUseId ?? tuid;
  const ph = permHash({ ...pending, ...shown, nonce: n, toolUseId: t });
  const sig: Uint8Array = p256.sign(signingInput(n, t, decision, ts, ph), k.sk, { lowS: false, prehash: true });
  return encodeFrame({ type: "dec", nonce: n, toolUseId: t, decision, ts, kid: k.kid, sig, ph });
}

describe("verifyDecision", () => {
  const k = keypair(1);
  const paired = [{ kid: k.kid, spki: k.spki }];

  it("acepta allow y deny firmadas por la llave emparejada (resolved es opcional)", () => {
    expect(verifyDecision(pending, dec(k, "allow", 990), paired, 995)).toEqual({ ok: true, decision: "allow", ts: 990, kid: k.kid });
    expect(verifyDecision(pending, dec(k, "deny", 990), paired, 995)).toMatchObject({ ok: true, decision: "deny" });
  });

  it("formato 2: lo que el reloj muestra (instance_id, tool, sum, wok, exp) cambiado -> ph", () => {
    for (const shown of [{ sum: "rm -rf ~" }, { tool: "Write" }, { instanceId: "mac-work" }, { wok: false }, { exp: 1001 }] as Shown[]) {
      expect(verifyDecision(pending, dec(k, "allow", 990, undefined, shown), paired, 995), JSON.stringify(shown)).toMatchObject({ ok: false, cause: "ph", reject: "ph" });
    }
  });

  it("formato 2: el mod no se fía del ph recibido; ph correcto con firma sobre otro -> sig", () => {
    const lying = dec(k, "allow", 990, undefined, { sum: "ls" });
    const f = lying.slice();
    // Sustituye el ph de la trama por el correcto: la firma (hecha sobre otro ph) ya no verifica.
    f.set(permHash(pending), f.length - 32);
    expect(verifyDecision(pending, f, paired, 995)).toMatchObject({ ok: false, cause: "sig" });
  });

  it("formato 1 (sin ph) ya no se acepta", () => {
    const v1sig: Uint8Array = p256.sign(encode(["orbit-dec", 1, nonce, tuid, "allow", 990]), k.sk, { lowS: false, prehash: true });
    const v1frame = encode(["dec", nonce, tuid, "allow", 990, k.kid, v1sig]);
    expect(verifyDecision(pending, v1frame, paired, 995)).toMatchObject({ ok: false, cause: "malformed", reject: "malformed" });
    const v1sigWithPh = encodeFrame({ type: "dec", nonce, toolUseId: tuid, decision: "allow", ts: 990, kid: k.kid, sig: v1sig, ph: permHash(pending) });
    expect(verifyDecision(pending, v1sigWithPh, paired, 995)).toMatchObject({ ok: false, cause: "sig" });
  });

  it("deriva de reloj: ts <= exp + 30 se acepta; exp + 31 no", () => {
    expect(verifyDecision(pending, dec(k, "allow", 1030), paired, 999)).toMatchObject({ ok: true });
    expect(verifyDecision(pending, dec(k, "allow", 1031), paired, 999)).toMatchObject({ ok: false, cause: "expired-ts", reject: "expired" });
  });

  it("ahora con decimales: exp + 0,5 s ya venció", () => {
    expect(verifyDecision(pending, dec(k, "allow", 1000), paired, 1000)).toMatchObject({ ok: true });
    expect(verifyDecision(pending, dec(k, "allow", 1000), paired, 1000.5)).toMatchObject({ ok: false, cause: "expired-now" });
  });

  it("una llave emparejada con un kid que no es el de su SPKI no cuenta", () => {
    const other = keypair(2);
    expect(verifyDecision(pending, dec(k, "allow", 990), [{ kid: k.kid, spki: other.spki }], 995)).toMatchObject({ cause: "kid" });
  });

  it("la firma cubre decision, ts, nonce y tool_use_id", () => {
    const good = dec(k, "allow", 990);
    // Sustituir campos en la trama tras firmar (re-codificando de forma determinista).
    const sig = good.slice(good.length - 64 - 2 - 32, good.length - 2 - 32);
    const forge = (f: Partial<{ decision: Decision; ts: number }>) =>
      encodeFrame({ type: "dec", nonce, toolUseId: tuid, decision: f.decision ?? "allow", ts: f.ts ?? 990, kid: k.kid, sig, ph: permHash(pending) });
    expect(verifyDecision(pending, forge({}), paired, 995).ok).toBe(true);
    expect(verifyDecision(pending, forge({ decision: "deny" }), paired, 995)).toMatchObject({ cause: "sig" });
    expect(verifyDecision(pending, forge({ ts: 991 }), paired, 995)).toMatchObject({ cause: "sig" });
  });

  it("verifySignature nunca lanza", () => {
    expect(verifySignature(new Uint8Array(3), new Uint8Array(1), new Uint8Array(64))).toBe(false);
    expect(verifySignature(k.spki, new Uint8Array(1), new Uint8Array(10))).toBe(false);
  });

  it("makeDecisionVerifier: adaptador de hold.ts (nowMs, reason) que relee las llaves", async () => {
    let keys = paired;
    const verify = makeDecisionVerifier(() => keys);
    const d = dec(k, "allow", 990);
    expect(await verify(pending, d, 995_000)).toEqual({ ok: true });
    expect(await verify(pending, d, 1_000_001)).toEqual({ ok: false, reason: "expired" });
    keys = [];
    expect(await verify(pending, d, 995_000)).toEqual({ ok: false, reason: "kid" });
    const dWokFalse = dec(k, "allow", 990, undefined, { wok: false });
    expect(await verify({ ...pending, wok: false }, dWokFalse, 995_000)).toEqual({ ok: false, reason: "kid" });
    keys = paired;
    expect(await verify({ ...pending, wok: false }, dWokFalse, 995_000)).toEqual({ ok: false, reason: "forbidden" });
    expect(await verify({ ...pending, wok: false }, d, 995_000)).toEqual({ ok: false, reason: "ph" });
    expect(await verify(pending, Uint8Array.of(0x80), 995_000)).toEqual({ ok: false, reason: "malformed" });
  });

  it("muchas firmas aleatorias: válidas pasan, con un bit cambiado no", () => {
    for (let i = 3; i < 23; i++) {
      const kk = keypair(i);
      const msg = Uint8Array.of(i, i + 1);
      const sig: Uint8Array = p256.sign(msg, kk.sk, { lowS: false, prehash: true });
      expect(verifySignature(kk.spki, msg, sig)).toBe(true);
      const bad = sig.slice();
      bad[i % 64]! ^= 1;
      expect(verifySignature(kk.spki, msg, bad)).toBe(false);
    }
  });
});

describe("noble empaquetado (sandbox: solo imports relativos)", () => {
  it("src/vendor/noble-p256.ts está al día y no tiene imports", () => {
    execFileSync(process.execPath, [join(ROOT, "scripts/vendor-noble.mjs"), "--check"], { stdio: "pipe" });
    const text = readFileSync(join(ROOT, "src/vendor/noble-p256.ts"), "utf8");
    expect(text).not.toMatch(/^\s*import\s/m);
    expect(text).not.toMatch(/\bimport\s*\(/);
    expect(text).not.toMatch(/\brequire\s*\(/);
  });

  it("el build deja dist/vendor/noble-p256.js y verify.js lo importa por ruta relativa", () => {
    const js = readFileSync(join(ROOT, "dist/core/perm/verify.js"), "utf8");
    expect(js).toMatch(/from "\.\.\/\.\.\/vendor\/noble-p256\.js"/);
    const imports = [...js.matchAll(/from "([^"]+)"/g)].map((m) => m[1]!);
    expect(imports.every((p) => p.startsWith("./") || p.startsWith("../"))).toBe(true);
    readFileSync(join(ROOT, "dist/vendor/noble-p256.js"), "utf8");
  });

  it("hexEncode de la llave de prueba", () => {
    expect(hexEncode(SPKI_PREFIX)).toBe("3059301306072a8648ce3d020106082a8648ce3d030107034200");
  });
});
