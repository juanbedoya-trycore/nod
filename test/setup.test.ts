/** Configuración automática y emparejamiento por QR (SPEC §6.3.1, protocol/docs/pairing.md §2.2). */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { PAIR_STORE_KEY, b64uDecode, b64uEncode, readStoredKeys } from "../src/core/pairing.js";
import type { PairingIo } from "../src/core/pairing.js";
import {
  SETUP_TTL_MS,
  addSetupKey,
  autoPair,
  hmacSha256,
  isLoopbackUrl,
  liveSetupKeys,
  pairTag,
  pairTagInput,
  parseClientConfig,
  qrMatrix,
  qrText,
  readSetupKeys,
  resolvePhoneUrl,
  setupLink,
  stateDirCandidates,
  verifyPairTag,
} from "../src/core/setup.js";
import type { SetupKeyEntry, SetupKeyring } from "../src/core/setup.js";
import { hexDecode, hexEncode } from "../src/protocol/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SIG = join(HERE, "../protocol/vectors/sig");
const keys = JSON.parse(readFileSync(join(SIG, "key.json"), "utf8")).keys as { name: string; spki: string; kid: string }[];
const WATCH = keys.find((k) => k.name === "reloj")!;
const OTHER = keys.find((k) => k.name === "otra")!;
const schema = JSON.parse(readFileSync(join(HERE, "../protocol/schema/pairing.schema.json"), "utf8"));
const ajv = new (Ajv2020 as any)({ strict: false });
ajv.addSchema(schema, "pairing.schema.json");
const validate = (def: string, v: unknown) => ajv.getSchema(`pairing.schema.json#/$defs/${def}`)!(v) as boolean;

describe("etiqueta HMAC (vectores compartidos)", () => {
  const v = JSON.parse(readFileSync(join(SIG, "pair-tag.json"), "utf8")) as {
    cases: { name: string; k: string; instance_id: string; spki: string; input: string; tag: string; expect: boolean }[];
  };
  it.each(v.cases.map((c) => [c.name, c] as const))("%s", (_n, c) => {
    expect(hexEncode(pairTagInput(c.instance_id, hexDecode(c.spki)))).toBe(c.input);
    expect(verifyPairTag(hexDecode(c.k), c.instance_id, hexDecode(c.spki), b64uDecode(c.tag))).toBe(c.expect);
  });
  it("HMAC-SHA256 coincide con node:crypto (claves cortas, de 64 y largas)", () => {
    for (const klen of [1, 32, 64, 65, 200]) {
      for (const mlen of [0, 1, 55, 64, 200]) {
        const k = randomBytes(klen);
        const m = randomBytes(mlen);
        expect(hexEncode(hmacSha256(k, m))).toBe(createHmac("sha256", k).update(m).digest("hex"));
      }
    }
  });
  it("K de otra longitud no verifica nada", () => {
    expect(verifyPairTag(new Uint8Array(31), "mac-personal", hexDecode(WATCH.spki), new Uint8Array(32))).toBe(false);
    expect(() => pairTag(new Uint8Array(16), "mac-personal", hexDecode(WATCH.spki))).toThrow();
  });
});

describe("enlace y QR", () => {
  const k = new Uint8Array(32).fill(0xff);
  const link = setupLink("http://192.168.1.20:7878", "mac-personal", "abc+/=", k);
  it("formato orbit://setup (el mismo que orbit-server setup)", () => {
    expect(link).toBe("orbit://setup?v=1&u=http%3A%2F%2F192.168.1.20%3A7878&i=mac-personal&t=abc%2B%2F%3D&k=__________________________________________8");
    const u = new URL(link);
    expect(u.searchParams.get("u")).toBe("http://192.168.1.20:7878");
    expect(u.searchParams.get("t")).toBe("abc+/=");
    expect(b64uDecode(u.searchParams.get("k")!)).toEqual(k);
  });
  it("QR cuadrado, con margen claro y los tres patrones de posición", () => {
    const m = qrMatrix(link);
    const n = m.length;
    expect(n).toBeGreaterThanOrEqual(21);
    for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]] as const) {
      for (let i = 0; i < 7; i++) expect(m[r]![c + i]).toBe(true);
      expect(m[r + 2]![c + 2]).toBe(true);
      expect(m[r + 1]![c + 1]).toBe(false);
    }
    const lines = qrText(link).split("\n");
    expect(lines.every((l) => [...l].length === n + 4)).toBe(true);
    expect(lines.length).toBe(Math.ceil((n + 4) / 2));
    expect([...lines[0]!].every((ch) => ch === "█")).toBe(true);
  });
  it("src/vendor/qrcode.ts está al día y no tiene imports", () => {
    execFileSync(process.execPath, [join(ROOT, "scripts/vendor-qr.mjs"), "--check"], { stdio: "pipe" });
    expect(readFileSync(join(ROOT, "src/vendor/qrcode.ts"), "utf8")).not.toMatch(/^\s*import\s/m);
  });
});

describe("client.json y dirección del teléfono", () => {
  it("lee client.json (schema clientConfig)", () => {
    const c = { v: 1, url: "http://127.0.0.1:7878", phone_url: "http://100.64.0.9:7878", token: "t", instance_id: "mac-personal", ctx: "personal" };
    expect(validate("clientConfig", c)).toBe(true);
    expect(parseClientConfig(JSON.stringify(c))).toEqual({ raw: { url: c.url, token: "t", instanceId: "mac-personal", ctx: "personal" }, phoneUrl: c.phone_url });
    expect(parseClientConfig("{")).toBeUndefined();
    expect(parseClientConfig(JSON.stringify({ ...c, v: 2 }))).toBeUndefined();
  });
  it("directorios de estado en el mismo orden que el servidor", () => {
    expect(stateDirCandidates({ stateDir: "/x/", home: "/h" })).toEqual(["/x"]);
    expect(stateDirCandidates({ home: "/h", xdg: "/c" })).toEqual(["/h/Library/Application Support/Orbit", "/c/orbit", "/h/.config/orbit"]);
    expect(stateDirCandidates({})).toEqual([]);
  });
  it("la URL del QR nunca es de loopback", () => {
    expect(isLoopbackUrl("http://127.0.0.1:7878")).toBe(true);
    expect(isLoopbackUrl("http://localhost:7878")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:7878")).toBe(true);
    expect(isLoopbackUrl("http://192.168.1.20:7878")).toBe(false);
    expect(resolvePhoneUrl(undefined, "http://100.64.0.9:7878/", "http://127.0.0.1:7878")).toBe("http://100.64.0.9:7878");
    expect(resolvePhoneUrl("http://10.0.0.2:1", "http://100.64.0.9:7878", "http://127.0.0.1:7878")).toBe("http://10.0.0.2:1");
    expect(resolvePhoneUrl(undefined, undefined, "http://192.168.1.20:7878")).toBe("http://192.168.1.20:7878");
    expect(resolvePhoneUrl(undefined, "http://127.0.0.1:7878", "http://localhost:7878")).toBeUndefined();
  });
});

describe("K de un solo uso", () => {
  it("añade, caduca a los 15 min y respeta el schema", () => {
    const a = addSetupKey([], new Uint8Array(32).fill(1), "mac-personal", 1_000);
    expect(validate("setupKeys", a)).toBe(true);
    expect(a.keys[0]!.expires_ms).toBe(1_000 + SETUP_TTL_MS);
    const b = addSetupKey(a.keys, new Uint8Array(32).fill(2), "mac-personal", 1_000 + SETUP_TTL_MS + 1);
    expect(b.keys.length).toBe(1);
    expect(liveSetupKeys(b.keys, "mac-personal", 1_000 + SETUP_TTL_MS + 1).length).toBe(1);
    expect(liveSetupKeys(b.keys, "mac-work", 0).length).toBe(0);
    let many = b.keys;
    for (let i = 0; i < 20; i++) many = addSetupKey(many, new Uint8Array(32).fill(i), "mac-personal", 5_000_000).keys;
    expect(many.length).toBe(8);
    expect(readSetupKeys(JSON.stringify({ v: 1, keys: [{ k: "corto", instance_id: "x", expires_ms: 1 }, ...many] })).length).toBe(8);
  });
});

// ---------------------------------------------------------------- autoPair con servidor y store falsos

const INST = "mac-personal";
const NOW = 2_000_000;
const offerJson = (k: { spki: string; kid: string }, tag?: Uint8Array) => ({
  kid: b64uEncode(hexDecode(k.kid).subarray(0, 8)),
  spki: b64uEncode(hexDecode(k.spki)),
  label: "Galaxy Watch",
  created_ms: NOW - 1_000,
  expires_ms: NOW + 600_000,
  ...(tag === undefined ? {} : { tag: b64uEncode(tag) }),
});

function world(offers: unknown[], kEntries: SetupKeyEntry[]) {
  const store = new Map<string, unknown>();
  let list = [...offers];
  let ks = [...kEntries];
  const calls: string[] = [];
  const io: PairingIo = {
    now: () => NOW,
    fetch: async (url, init) => {
      calls.push(`${init.method} ${url}`);
      if (init.method === "GET") return { status: 200, ok: true, text: JSON.stringify({ offers: list }) };
      const kid = url.split("/").pop()!;
      list = list.filter((o) => (o as { kid: string }).kid !== kid);
      return { status: 204, ok: true, text: "" };
    },
    load: async (k) => store.get(k),
    save: async (k, v) => void (v === null ? store.delete(k) : store.set(k, v)),
  };
  const ring: SetupKeyring = { list: async () => ks, consume: async (k) => void (ks = ks.filter((x) => x.k !== k)) };
  return { io, ring, store, calls, keys: () => ks, offers: () => list, setOffers: (l: unknown[]) => (list = l) };
}
const cfg = { url: "http://srv", token: "tok", instanceId: INST };
const K1 = new Uint8Array(32).fill(7);
const K2 = new Uint8Array(32).fill(8);
const entry = (k: Uint8Array, exp = NOW + 60_000, inst = INST): SetupKeyEntry => ({ k: b64uEncode(k), instance_id: inst, expires_ms: exp });
const paired = (w: ReturnType<typeof world>) => readStoredKeys(w.store.get(PAIR_STORE_KEY(INST))).stored.map((k) => k.kid);

describe("emparejamiento automático (D)", () => {
  it("tag válido: empareja sin huella, consume K y borra la oferta", async () => {
    const w = world([offerJson(WATCH, pairTag(K1, INST, hexDecode(WATCH.spki)))], [entry(K1)]);
    const r = await autoPair(cfg, w.io, w.ring);
    expect(r).toMatchObject({ armed: true, rejected: 0 });
    expect(r.paired.map((k) => k.kid)).toEqual([WATCH.kid]);
    expect(paired(w)).toEqual([WATCH.kid]);
    expect(w.keys()).toEqual([]);
    expect(w.offers()).toEqual([]);
  });
  it("tag con otro K: no empareja y no gasta el K", async () => {
    const w = world([offerJson(WATCH, pairTag(K2, INST, hexDecode(WATCH.spki)))], [entry(K1)]);
    const r = await autoPair(cfg, w.io, w.ring);
    expect(r).toMatchObject({ armed: true, rejected: 1, paired: [] });
    expect(paired(w)).toEqual([]);
    expect(w.keys().length).toBe(1);
  });
  it("tag sobre otra SPKI (oferta ajena con un tag copiado): rechazo", async () => {
    const tag = pairTag(K1, INST, hexDecode(WATCH.spki));
    const w = world([offerJson(OTHER, tag)], [entry(K1)]);
    expect((await autoPair(cfg, w.io, w.ring)).paired).toEqual([]);
    expect(paired(w)).toEqual([]);
  });
  it("tag para otra instancia: rechazo", async () => {
    const w = world([offerJson(WATCH, pairTag(K1, "mac-work", hexDecode(WATCH.spki)))], [entry(K1)]);
    expect((await autoPair(cfg, w.io, w.ring)).paired).toEqual([]);
  });
  it("K caducado: ni siquiera pide las ofertas", async () => {
    const w = world([offerJson(WATCH, pairTag(K1, INST, hexDecode(WATCH.spki)))], [entry(K1, NOW - 1)]);
    expect(await autoPair(cfg, w.io, w.ring)).toEqual({ armed: false, paired: [], rejected: 0 });
    expect(w.calls).toEqual([]);
    expect(paired(w)).toEqual([]);
  });
  it("K ya usado: la misma oferta repetida no vuelve a emparejar tras revocar", async () => {
    const tag = pairTag(K1, INST, hexDecode(WATCH.spki));
    const w = world([offerJson(WATCH, tag)], [entry(K1)]);
    expect((await autoPair(cfg, w.io, w.ring)).paired.length).toBe(1);
    w.store.delete(PAIR_STORE_KEY(INST)); // /nod unpair
    w.setOffers([offerJson(WATCH, tag)]); // alguien repite la oferta
    expect(await autoPair(cfg, w.io, w.ring)).toEqual({ armed: false, paired: [], rejected: 0 });
    expect(paired(w)).toEqual([]);
  });
  it("ofertas sin tag: quedan para /nod pair (flujo manual)", async () => {
    const w = world([offerJson(WATCH)], [entry(K1)]);
    expect(await autoPair(cfg, w.io, w.ring)).toEqual({ armed: true, paired: [], rejected: 0 });
    expect(w.offers().length).toBe(1);
  });
  it("un K empareja una sola oferta aunque lleguen dos con su tag", async () => {
    const w = world(
      [offerJson(WATCH, pairTag(K1, INST, hexDecode(WATCH.spki))), offerJson(OTHER, pairTag(K1, INST, hexDecode(OTHER.spki)))],
      [entry(K1)],
    );
    const r = await autoPair(cfg, w.io, w.ring);
    expect(r.paired.length).toBe(1);
    expect(r.rejected).toBe(1);
  });
});
