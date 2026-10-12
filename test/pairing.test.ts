/** Emparejamiento (protocol/docs/pairing.md): huellas, ofertas no fiables y el comando /orbit pair. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  MAX_PAIRED_KEYS,
  PAIR_STORE_KEY,
  b64uDecode,
  clockTime,
  b64uEncode,
  fingerprint,
  loadPairedKeys,
  parseKidInput,
  parseOffers,
  parsePairCommand,
  readStoredKeys,
  runPairCommand,
  sanitizeLabel,
} from "../src/core/pairing.js";
import type { PairAction, PairingIo } from "../src/core/pairing.js";
import { SPKI_PREFIX, kidOf, verifyDecision } from "../src/core/perm/verify.js";
import * as noble from "../src/vendor/noble-p256.js";
import { hexDecode, hexEncode } from "../src/protocol/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIG = join(HERE, "../protocol/vectors/sig");
const keys = JSON.parse(readFileSync(join(SIG, "key.json"), "utf8")).keys as { name: string; spki: string; kid: string }[];
const WATCH = keys.find((k) => k.name === "reloj")!;
const OTHER = keys.find((k) => k.name === "otra")!;
const schema = JSON.parse(readFileSync(join(HERE, "../protocol/schema/pairing.schema.json"), "utf8"));
const ajv = new (Ajv2020 as any)({ strict: false });
ajv.addSchema(schema, "pairing.schema.json");
const validate = (def: string, v: unknown) => ajv.getSchema(`pairing.schema.json#/$defs/${def}`)!(v) as boolean;

const offerOf = (k: { spki: string; kid: string }, label = "Galaxy Watch") => ({
  kid: b64uEncode(hexDecode(k.kid)),
  spki: b64uEncode(hexDecode(k.spki)),
  label,
  created_ms: 1_000,
  expires_ms: 601_000,
});

/** Servidor y store falsos. */
function fakeIo(offers: unknown[]) {
  const store = new Map<string, unknown>();
  const calls: { method: string; url: string; auth: string | undefined }[] = [];
  let list = [...offers];
  const io: PairingIo = {
    now: () => 61_000,
    fetch: async (url, init) => {
      calls.push({ method: init.method, url, auth: init.headers.authorization });
      if (init.headers.authorization !== "Bearer tok") return { status: 401, ok: false, text: "" };
      if (init.method === "GET" && url.endsWith("/v0/pair/offers")) {
        const body = { offers: list };
        return { status: 200, ok: true, text: JSON.stringify(body) };
      }
      if (init.method === "DELETE") {
        const kid = url.split("/").pop()!;
        const before = list.length;
        list = list.filter((o) => (o as { kid: string }).kid !== kid);
        return { status: before === list.length ? 404 : 204, ok: before !== list.length, text: "" };
      }
      return { status: 404, ok: false, text: "" };
    },
    load: async (k) => store.get(k),
    save: async (k, v) => {
      if (v === null) store.delete(k);
      else store.set(k, JSON.parse(JSON.stringify(v)));
    },
  };
  return { io, store, calls, setList: (l: unknown[]) => (list = l) };
}
const cfg = { url: "http://srv", token: "tok", instanceId: "mac-personal" };
const run = (io: PairingIo, args: string) => runPairCommand(cfg, io, parsePairCommand(args) as PairAction);

describe("huella y entrada del usuario", () => {
  it("hex agrupado y 8 palabras", () => {
    const f = fingerprint(hexDecode(WATCH.kid));
    expect(f.hex).toBe("058f 0152 8618 14b2");
    expect(f.words).toHaveLength(8);
  });

  it("acepta la huella con espacios, guiones, mayúsculas o en palabras", () => {
    const kid = hexDecode(WATCH.kid);
    for (const s of ["058f 0152 8618 14b2", "058F-0152-8618-14B2", "058f015286181 4b2", fingerprint(kid).words.join(" ")]) {
      expect(parseKidInput(s), s).toEqual(kid);
    }
    for (const s of ["058f 0152 8618", "058f 0152 8618 14b2 00", "zzzz", "agua leche", ""]) expect(parseKidInput(s), s).toBeUndefined();
  });

  it("base64url ida y vuelta, y rechazo de no canónicos", () => {
    for (let n = 0; n < 20; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      expect(b64uDecode(b64uEncode(b))).toEqual(b);
    }
    expect(b64uEncode(hexDecode(WATCH.spki))).toHaveLength(122);
    expect(() => b64uDecode("AB=")).toThrow();
    expect(() => b64uDecode("A")).toThrow();
    expect(b64uDecode("AA")).toEqual(Uint8Array.of(0));
    expect(b64uDecode("AQ")).toEqual(Uint8Array.of(1));
    expect(() => b64uDecode("AB")).toThrow(/no canónico/);
  });

  it("las etiquetas del servidor no pueden inyectar secuencias de terminal", () => {
    expect(sanitizeLabel("Reloj\u001b[2J\u001b]0;x\u0007 malo")).toBe("Reloj[2J]0;x malo");
    expect(sanitizeLabel("a‮b")).toBe("ab");
    expect(sanitizeLabel("x".repeat(100))).toHaveLength(32);
    expect(sanitizeLabel(42)).toBe("");
  });
});

describe("parsePairCommand", () => {
  it("reconoce pair y unpair, y deja pasar el resto de /orbit", () => {
    expect(parsePairCommand("")).toBeUndefined();
    expect(parsePairCommand("status")).toBeUndefined();
    expect(parsePairCommand("pair")).toEqual({ kind: "list" });
    expect(parsePairCommand("  PAIR keys")).toEqual({ kind: "keys" });
    expect(parsePairCommand("pair confirm 058f 0152 8618 14b2")).toEqual({ kind: "confirm", kid: hexDecode(WATCH.kid) });
    expect(parsePairCommand("pair reject 058f015286181 4b2")).toMatchObject({ kind: "reject" });
    expect(parsePairCommand("unpair 058f-0152-8618-14b2")).toEqual({ kind: "unpair", kid: hexDecode(WATCH.kid) });
    expect(parsePairCommand("pair confirm")).toMatchObject({ kind: "invalid" });
    expect(parsePairCommand("pair confirm 1234")).toMatchObject({ kind: "invalid" });
    expect(parsePairCommand("pair frobnicate")).toMatchObject({ kind: "invalid" });
    expect(parsePairCommand("unpair")).toMatchObject({ kind: "invalid" });
  });
});

describe("ofertas: el mod no confía en el servidor", () => {
  it("las ofertas válidas cumplen el schema", () => {
    expect(validate("pairOffers", { offers: [offerOf(WATCH)] })).toBe(true);
    expect(validate("pairOffer", { orbit: "0.2.0", instance_id: "mac-personal", spki: offerOf(WATCH).spki, label: "Watch" })).toBe(true);
    expect(validate("pairOffer", { orbit: "0.2.0", instance_id: "mac-personal", spki: "AAAA" })).toBe(false);
    expect(validate("pairOfferAck", { kid: offerOf(WATCH).kid, expires_ms: 1 })).toBe(true);
  });

  it("descarta ofertas con kid que no corresponde a su SPKI o con SPKI inválido", () => {
    const lying = { ...offerOf(OTHER), kid: offerOf(WATCH).kid };
    const badSpki = { ...offerOf(WATCH), spki: b64uEncode(hexDecode(WATCH.spki).map((b, i) => (i === 90 ? b ^ 1 : b))) };
    const { offers, dropped } = parseOffers(JSON.stringify({ offers: [lying, badSpki, offerOf(WATCH), offerOf(WATCH)] }));
    expect(dropped).toBe(2);
    expect(offers).toHaveLength(1);
    expect(hexEncode(offers[0]!.kid)).toBe(WATCH.kid);
    expect(() => parseOffers("no json")).toThrow();
    expect(() => parseOffers("{}")).toThrow();
  });
});

describe("/orbit pair (flujo completo con servidor falso)", () => {
  it("list -> confirm guarda la llave y borra la oferta; la llave verifica decisiones", async () => {
    const { io, store, calls } = fakeIo([offerOf(WATCH, "Galaxy\u001b[31m Watch")]);
    const listed = await run(io, "pair");
    expect(listed).toContain("058f 0152 8618 14b2");
    expect(listed).toContain(fingerprint(hexDecode(WATCH.kid)).words.join(" "));
    expect(listed).not.toContain("\u001b");
    expect(store.size).toBe(0); // listar no empareja nada

    const out = await run(io, "pair confirm 058f 0152 8618 14b2");
    expect(out).toMatch(/llave emparejada/);
    const saved = store.get(PAIR_STORE_KEY("mac-personal"));
    expect(validate("storedKeys", saved)).toBe(true);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(calls.every((c) => c.auth === "Bearer tok")).toBe(true);

    const paired = await loadPairedKeys("mac-personal", io);
    expect(paired.map((k) => hexEncode(k.kid))).toEqual([WATCH.kid]);
    // Con esa llave, la dec válida de los vectores (firmada en Kotlin) se acepta.
    const dv = JSON.parse(readFileSync(join(SIG, "decisions.json"), "utf8"));
    const c = dv.cases.find((x: { name: string }) => x.name === "allow-valida");
    const p = {
      nonce: hexDecode(c.pending.nonce),
      toolUseId: c.pending.tool_use_id,
      exp: c.pending.exp,
      wok: true,
      instanceId: c.pending.instance_id,
      tool: c.pending.tool,
      sum: c.pending.sum,
    };
    expect(verifyDecision(p, hexDecode(c.dec), paired, c.now).ok).toBe(true);

    // unpair revoca: la misma dec deja de aceptarse.
    expect(await run(io, "unpair 058f015286181 4b2")).toMatch(/revocada/);
    expect(store.has(PAIR_STORE_KEY("mac-personal"))).toBe(false);
    expect(verifyDecision(p, hexDecode(c.dec), await loadPairedKeys("mac-personal", io), c.now)).toMatchObject({ ok: false, cause: "kid" });
  });

  it("0.2 (D-F): enseña la hora de cada oferta y avisa si hay más de una pendiente", async () => {
    const one = await run(fakeIo([offerOf(WATCH)]).io, "pair");
    expect(one).toMatch(/publicada a las \d\d:\d\d:\d\d/);
    expect(one).toContain(`publicada a las ${clockTime(1_000)}`);
    expect(one).not.toMatch(/AVISO/);
    const two = await run(fakeIo([offerOf(WATCH), offerOf(OTHER, "intruso")]).io, "pair");
    expect(two).toMatch(/AVISO: hay 2 ofertas pendientes/);
  });

  it("confirm con una huella que no está en las ofertas no empareja nada", async () => {
    const { io, store } = fakeIo([offerOf(OTHER)]);
    expect(await run(io, "pair confirm 058f 0152 8618 14b2")).toMatch(/no hay ninguna oferta/);
    expect(store.size).toBe(0);
  });

  it("un servidor que miente con el kid no consigue emparejar otra llave", async () => {
    // El servidor anuncia la SPKI de 'otra' con el kid del reloj: el usuario confirma la huella del reloj.
    const { io, store } = fakeIo([{ ...offerOf(OTHER), kid: offerOf(WATCH).kid }]);
    expect(await run(io, "pair")).toMatch(/1 ofertas descartadas/);
    expect(await run(io, `pair confirm ${WATCH.kid}`)).toMatch(/no hay ninguna oferta/);
    expect(store.size).toBe(0);
  });

  it("reject borra la oferta sin emparejar; keys lista; tope de llaves", async () => {
    const { io, store } = fakeIo([offerOf(WATCH)]);
    expect(await run(io, `pair reject ${WATCH.kid}`)).toMatch(/descartada/);
    expect(await run(io, "pair")).toMatch(/no hay ofertas/);
    expect(await run(io, "pair keys")).toMatch(/no hay ninguna llave/);
    expect(store.size).toBe(0);

    const { io: io2, store: store2 } = fakeIo([offerOf(WATCH)]);
    const dup = { kid: OTHER.kid, spki: offerOf(OTHER).spki, label: "", paired_at: 0 };
    store2.set(PAIR_STORE_KEY("mac-personal"), { v: 1, keys: [dup, dup] }); // repetidas cuentan una vez
    expect(readStoredKeys(store2.get(PAIR_STORE_KEY("mac-personal"))).keys).toHaveLength(1);
    expect(await run(io2, `pair confirm ${WATCH.kid}`)).toMatch(/llave emparejada/);
    expect(await run(io2, "pair keys")).toMatch(/llaves emparejadas \(2\)/);
    expect(await run(io2, `pair confirm ${WATCH.kid}`)).toMatch(/ya está emparejada/);

    // Tope: con MAX_PAIRED_KEYS llaves distintas no se empareja otra.
    const { io: io3, store: store3 } = fakeIo([offerOf(WATCH)]);
    const many = Array.from({ length: MAX_PAIRED_KEYS }, (_, i) => {
      const sk = new Uint8Array(32);
      sk[0] = 0x22;
      sk[31] = i + 1;
      const spki = new Uint8Array(91);
      spki.set(SPKI_PREFIX, 0);
      spki.set((noble as any).p256.getPublicKey(sk, false), 26);
      return { kid: hexEncode(kidOf(spki)), spki: b64uEncode(spki), label: `r${i}`, paired_at: 0 };
    });
    store3.set(PAIR_STORE_KEY("mac-personal"), { v: 1, keys: many });
    expect(await run(io3, `pair confirm ${WATCH.kid}`)).toMatch(new RegExp(`ya hay ${MAX_PAIRED_KEYS} llaves`));
    expect(readStoredKeys(store3.get(PAIR_STORE_KEY("mac-personal"))).keys).toHaveLength(MAX_PAIRED_KEYS);
  });

  it("token rechazado: error claro, nada guardado", async () => {
    const { io, store } = fakeIo([offerOf(WATCH)]);
    const bad = { ...cfg, token: "otro" };
    await expect(runPairCommand(bad, io, { kind: "list" })).rejects.toThrow(/401/);
    await expect(runPairCommand(bad, io, { kind: "confirm", kid: hexDecode(WATCH.kid) })).rejects.toThrow(/401/);
    expect(store.size).toBe(0);
  });

  it("sin configuración: keys y unpair funcionan, list no", async () => {
    const { io } = fakeIo([]);
    expect(await runPairCommand(undefined, io, { kind: "keys" }, "mac-personal")).toMatch(/no hay ninguna llave/);
    expect(await runPairCommand(undefined, io, { kind: "list" }, "mac-personal")).toMatch(/sin configurar/);
  });

  it("entradas manipuladas en $.store no cuentan como emparejadas", () => {
    const tampered = { v: 1, keys: [{ kid: WATCH.kid, spki: offerOf(OTHER).spki, label: "x", paired_at: 1 }, { kid: 5 }] };
    const r = readStoredKeys(tampered);
    expect(r.keys).toHaveLength(0);
    expect(r.invalid).toBe(2);
    expect(readStoredKeys(undefined)).toEqual({ stored: [], keys: [], invalid: 0 });
    expect(readStoredKeys("basura").invalid).toBe(1);
  });
});
