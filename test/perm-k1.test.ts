// Integración del holder con el verificador real de K1 (verify.ts), con una llave P-256 de prueba.
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_FORBIDDEN } from "../src/core/perm/forbidden.js";
import { PermHolder, TEST_KIDS, b64uDecode, b64uEncode, dropTestKeys, isTestKey, k1Verifier, parseWatchKeys } from "../src/core/perm/hold.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { HttpInit, HttpResponse, PermIo } from "../src/core/perm/hold.js";
import { encode, encodeFrame } from "../src/protocol/index.js";

const T0S = Math.floor(1_791_683_886_000 / 1000);
/** Lo que el reloj ve en la trama perm de estos tests (coincide con los pendientes de abajo). */
interface Shown {
  instanceId: string;
  tool: string;
  sum: string;
  wok: boolean;
  exp: number;
}
const SHOWN: Shown = { instanceId: "mac-personal", tool: "Bash", sum: "x", wok: true, exp: T0S + 90 };

/** Firma como el reloj (formato 2, con node:crypto, independiente de verify.ts): ph de lo mostrado. */
function watchKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  const kid = new Uint8Array(crypto.createHash("sha256").update(spki).digest().subarray(0, 8));
  const sign = (nonce: Uint8Array, toolUseId: string, decision: "allow" | "deny", ts: number, shown: Partial<Shown> = {}): Uint8Array => {
    const s = { ...SHOWN, ...shown };
    const ph = new Uint8Array(crypto.createHash("sha256").update(encode(["orbit-perm", 1, s.instanceId, nonce, toolUseId, s.tool, s.sum, s.wok, s.exp])).digest());
    const input = encode(["orbit-dec", 2, nonce, toolUseId, decision, ts, ph]);
    const sig = new Uint8Array(crypto.sign("sha256", input, { key: privateKey, dsaEncoding: "ieee-p1363" }));
    return encodeFrame({ type: "dec", nonce, toolUseId, decision, ts, kid, sig, ph });
  };
  return { spki, kid, sign };
}

describe("parseWatchKeys", () => {
  it("acepta SPKI P-256 en base64url, vacío = sin llaves, y rechaza basura", () => {
    const k = watchKey();
    const r = parseWatchKeys(JSON.stringify([b64uEncode(k.spki)]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(Array.from(r.keys[0]!.kid)).toEqual(Array.from(k.kid));
    expect(parseWatchKeys(undefined)).toEqual({ ok: true, keys: [] });
    expect(parseWatchKeys("nope").ok).toBe(false);
    expect(parseWatchKeys('["AAAA"]').ok).toBe(false);
  });
});

describe("llaves de prueba de protocol/vectors/sig (G2)", () => {
  const vec = JSON.parse(readFileSync(fileURLToPath(new URL("../protocol/vectors/sig/key.json", import.meta.url)), "utf8")).keys as {
    spki: string;
    kid: string;
  }[];
  const hexBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

  it("TEST_KIDS cubre todas las llaves de key.json", () => {
    expect(vec.map((k) => k.kid).sort()).toEqual([...TEST_KIDS].sort());
  });

  it("ORBIT_WATCH_KEYS rechaza una llave de prueba (su d es pública)", () => {
    for (const k of vec) {
      const r = parseWatchKeys(JSON.stringify([b64uEncode(hexBytes(k.spki))]));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/prueba/);
    }
  });

  it("dropTestKeys quita las de prueba (p. ej. de $.store) y deja las reales", () => {
    const real = watchKey();
    const keys = [...vec.map((k) => ({ kid: hexBytes(k.kid), spki: hexBytes(k.spki) })), { kid: real.kid, spki: real.spki }];
    const r = dropTestKeys(keys);
    expect(r.dropped).toBe(2);
    expect(r.keys).toHaveLength(1);
    expect(isTestKey(r.keys[0]!.kid)).toBe(false);
  });
});

describe("k1Verifier", () => {
  const T = 1_791_683_886_000;
  const pending = (nonce: Uint8Array, wok = true) => ({
    instanceId: "mac-personal", nonce, nonceB64: b64uEncode(nonce), toolUseId: "t1", exp: Math.floor(T / 1000) + 90, wok, tool: "Bash", sum: "x", sessionId: "s",
  });
  const nonce = new Uint8Array(16).fill(3);

  it("firma válida -> ok; ms se convierten a segundos para exp", () => {
    const k = watchKey();
    const v = k1Verifier([{ kid: k.kid, spki: k.spki }]);
    const bytes = k.sign(nonce, "t1", "allow", Math.floor(T / 1000) + 1);
    expect(v(pending(nonce), bytes, T + 5000)).toEqual({ ok: true });
    expect(v(pending(nonce), bytes, T + 90_000)).toEqual({ ok: true });
    expect(v(pending(nonce), bytes, T + 91_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("firma manipulada -> sig; llave no emparejada -> kid; allow con wok=false -> forbidden", () => {
    const k = watchKey();
    const other = watchKey();
    const v = k1Verifier([{ kid: k.kid, spki: k.spki }]);
    const bytes = k.sign(nonce, "t1", "allow", Math.floor(T / 1000) + 1);
    const tampered = bytes.slice();
    tampered[tampered.length - 40]! ^= 1; // byte de sig
    expect(v(pending(nonce), tampered, T)).toEqual({ ok: false, reason: "sig" });
    expect(v(pending(nonce), other.sign(nonce, "t1", "allow", Math.floor(T / 1000)), T)).toEqual({ ok: false, reason: "kid" });
    // wok=false en el pendiente: lo que el reloj vio (wok=true) ya no cuadra con el ph -> ph. Firmado
    // sobre wok=false (lo que el reloj vería de verdad), el allow se rechaza por forbidden.
    expect(v(pending(nonce, false), bytes, T)).toEqual({ ok: false, reason: "ph" });
    expect(v(pending(nonce, false), k.sign(nonce, "t1", "allow", Math.floor(T / 1000) + 1, { wok: false }), T)).toEqual({ ok: false, reason: "forbidden" });
    // Servidor que reetiqueta: el reloj vio otro sum y firmó sobre eso -> ph.
    expect(v(pending(nonce), k.sign(nonce, "t1", "allow", Math.floor(T / 1000) + 1, { sum: "ls" }), T)).toEqual({ ok: false, reason: "ph" });
  });
});

describe("PermHolder + verificador real", () => {
  it("una dec manipulada se descarta y la firmada de verdad gana", async () => {
    const k = watchKey();
    let t = 1_791_683_886_000;
    const timers: { at: number; cb: () => void }[] = [];
    const reqs: { path: string; body: any }[] = [];
    const decs: string[] = [];
    const fetch = async (url: string, init: HttpInit): Promise<HttpResponse> => {
      const u = new URL(url);
      reqs.push({ path: u.pathname, body: init.body ? JSON.parse(init.body) : undefined });
      if (u.pathname === "/v0/perm/decision") {
        const d = decs.shift();
        return d === undefined ? { status: 204, ok: true, text: "" } : { status: 200, ok: true, text: JSON.stringify({ dec: d }) };
      }
      return { status: 200, ok: true, text: "{}" };
    };
    const io: PermIo = {
      now: () => t,
      fetch,
      after: (ms, cb) => {
        const x = { at: t + ms, cb };
        timers.push(x);
        return { cancel: () => timers.splice(timers.indexOf(x), 1) };
      },
      random: (n) => new Uint8Array(n).fill(5),
      log: () => undefined,
    };
    const holder = new PermHolder({
      config: { url: "http://o", token: "t", instanceId: "mac", ctx: "personal" },
      perm: { enabled: true, holdMs: 90_000, forbidden: [...DEFAULT_FORBIDDEN] },
      io,
      verify: k1Verifier([{ kid: k.kid, spki: k.spki }]),
    });
    const result = holder.hold({ tool: "Bash", tool_use_id: "t1", input: { command: "touch x" } }, { decision: "ask" }, { sessionId: "s" });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    const nonce = b64uDecode(reqs[0]!.body.nonce);
    const good = k.sign(nonce, "t1", "allow", Math.floor(t / 1000) + 1, { instanceId: "mac", sum: "touch x", exp: reqs[0]!.body.exp });
    const bad = good.slice();
    bad[bad.length - 40]! ^= 0xff; // un byte de sig (la trama acaba en ph: 2 + 32 bytes)
    decs.push(b64uEncode(bad), b64uEncode(good));
    // Avanza el reloj falso disparando temporizadores hasta que se resuelva.
    let done = false;
    void result.then(() => (done = true));
    for (let i = 0; i < 200 && !done; i++) {
      for (let j = 0; j < 5; j++) await new Promise((r) => setImmediate(r));
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      if (next !== undefined) {
        t = Math.max(t, next.at);
        next.cb();
      }
    }
    expect((await result).decision).toBe("allow");
    const resolved = reqs.filter((r) => r.path === "/v0/perm/resolved").map((r) => r.body);
    expect(resolved).toEqual([{ tool_use_id: "t1", nonce: b64uEncode(nonce), by: "watch", decision: "allow", reject: "sig" }]);
  });
});
