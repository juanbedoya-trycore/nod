/** Emparejamiento: K de un solo uso, ofertas válidas e inválidas, approvers.json y el QR. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addApprover, parseApprovers, removeApprover } from "../src/core/control/approvers.js";
import type { ApproverEntry } from "../src/core/control/approvers.js";
import { b64u, fromHex, hex, kidOf } from "../src/core/control/crypto.js";
import { PAIR_TTL_MS, addPairKey, fillPairUrl, livePairKeys, pairOffers, parsePairing, qrMatrix, qrText } from "../src/core/control/pairing.js";
import type { PairKeyEntry, PairingStore } from "../src/core/control/pairing.js";
import { FakeController, approver, fakeIo, offer } from "./support/control.js";

const INSTANCE = "personal-3fa9c2d1";
const A = approver("nod-pair-aprobador");
const B = approver("nod-pair-otro");
const K1 = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const K2 = Uint8Array.from({ length: 32 }, (_, i) => 100 + i);
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const TEST_KEY = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../vectors/control/key.json"), "utf8")).keys[0];

function memoryStore(keys: PairKeyEntry[]) {
  const state = { keys: [...keys], approvers: [] as ApproverEntry[] };
  const store: PairingStore = {
    pairKeys: async () => state.keys,
    consume: async (k) => void (state.keys = state.keys.filter((e) => e.k !== k)),
    addApprover: async (spki, name) => {
      const r = addApprover(state.approvers, spki, name, Date.now());
      if ("error" in r) return r.error;
      state.approvers = r.file.keys;
      return undefined;
    },
  };
  return { state, store };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe("ofertas", () => {
  it("una oferta válida empareja la llave, consume K y se borra del controlador", async () => {
    const ctrl = new FakeController();
    ctrl.offers = [offer(A, K1, INSTANCE, "o1", "Reloj\nde Juan")];
    const { state, store } = memoryStore([addPairKey([], K1, INSTANCE, T0).keys[0]!]);
    const r = await pairOffers({ url: ctrl.base }, fakeIo(ctrl), INSTANCE, store);
    expect(r).toEqual({ armed: true, paired: [{ kid: b64u(A.kid), name: "Reloj de Juan" }], rejected: 0 });
    expect(state.keys).toEqual([]);
    expect(state.approvers).toEqual([{ kid: b64u(A.kid), spki: b64u(A.spki), added_ms: T0, name: "Reloj de Juan" }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(ctrl.offers).toEqual([]);
    expect(ctrl.calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`)).toEqual([
      `GET /v1/control/pair-offers?instance=${INSTANCE}`,
      "DELETE /v1/control/pair-offers/o1",
    ]);
  });

  it("K ya usado: una segunda oferta con el mismo K no empareja", async () => {
    const ctrl = new FakeController();
    ctrl.offers = [offer(A, K1, INSTANCE, "o1"), offer(B, K1, INSTANCE, "o2")];
    const { state, store } = memoryStore([addPairKey([], K1, INSTANCE, T0).keys[0]!]);
    const r = await pairOffers({ url: ctrl.base }, fakeIo(ctrl), INSTANCE, store);
    expect(r.paired.map((p) => p.kid)).toEqual([b64u(A.kid)]);
    expect(r.rejected).toBe(1);
    expect(state.approvers.map((a) => a.kid)).toEqual([b64u(A.kid)]);
    // Con el K consumido, la misma oferta repetida más tarde ni se pide (no hay K vigente).
    ctrl.offers = [offer(B, K1, INSTANCE, "o3")];
    expect(await pairOffers({ url: ctrl.base }, fakeIo(ctrl), INSTANCE, store)).toEqual({ armed: false, paired: [], rejected: 0 });
  });

  it("K caducado (15 min) ya no empareja", async () => {
    const ctrl = new FakeController();
    ctrl.offers = [offer(A, K1, INSTANCE)];
    const { state, store } = memoryStore([addPairKey([], K1, INSTANCE, T0).keys[0]!]);
    vi.setSystemTime(T0 + PAIR_TTL_MS + 1);
    expect(await pairOffers({ url: ctrl.base }, fakeIo(ctrl), INSTANCE, store)).toEqual({ armed: false, paired: [], rejected: 0 });
    expect(state.approvers).toEqual([]);
    expect(ctrl.calls).toEqual([]);
  });

  it("ofertas inválidas: otro K, otra instancia, tag de otra llave, spki roto, llave de prueba → se descartan y se borran", async () => {
    const ctrl = new FakeController();
    const testSpki = fromHex(TEST_KEY.spki);
    const forged = offer(B, K1, INSTANCE, "o3");
    forged.tag = offer(A, K1, INSTANCE).tag;
    ctrl.offers = [
      offer(A, K2, INSTANCE, "o1"),
      offer(A, K1, "otra-0000", "o2"),
      forged,
      { id: "o4", spki: "AAAA", tag: offer(A, K1, INSTANCE).tag },
      { id: "o5", spki: b64u(testSpki), tag: offer({ ...A, spki: testSpki } as never, K1, INSTANCE).tag },
      { spki: "sin id" },
    ];
    const { state, store } = memoryStore([addPairKey([], K1, INSTANCE, T0).keys[0]!]);
    const logs: string[] = [];
    const r = await pairOffers({ url: ctrl.base }, fakeIo(ctrl, logs), INSTANCE, store);
    expect(r).toEqual({ armed: true, paired: [], rejected: 5 });
    expect(state.approvers).toEqual([]);
    expect(state.keys.length).toBe(1);
    expect(logs.join("\n")).toContain("(test-key)");
    await vi.advanceTimersByTimeAsync(10);
    expect(ctrl.offers).toEqual([{ spki: "sin id" }]);
  });

  it("controlador caído: no empareja ni lanza", async () => {
    const ctrl = new FakeController();
    ctrl.mode = "down";
    const { store } = memoryStore([addPairKey([], K1, INSTANCE, T0).keys[0]!]);
    expect(await pairOffers({ url: ctrl.base }, fakeIo(ctrl), INSTANCE, store)).toEqual({ armed: true, paired: [], rejected: 0 });
  });
});

describe("pairing.json y approvers.json", () => {
  it("pairing.json: lee lo que deja un instalador, descarta lo mal formado y filtra por instancia y vigencia", () => {
    const text = JSON.stringify({ v: 1, keys: [
      { k: b64u(K1), instance: INSTANCE, expires_ms: T0 + 1000 },
      { k: b64u(K2), instance: "otra", expires_ms: T0 + 1000 },
      { k: "corto", instance: INSTANCE, expires_ms: T0 + 1000 },
      { k: b64u(K2), instance: INSTANCE, expires_ms: T0 - 1 },
    ] });
    const all = parsePairing(text);
    expect(all.length).toBe(3);
    expect(livePairKeys(all, INSTANCE, T0).map((e) => e.k)).toEqual([b64u(K1)]);
    expect(parsePairing("no json")).toEqual([]);
    // addPairKey quita los caducados y no crece sin límite.
    let f = addPairKey(all, K1, INSTANCE, T0);
    expect(f.keys.some((e) => e.expires_ms < T0)).toBe(false);
    for (let i = 0; i < 20; i++) f = addPairKey(f.keys, K2, INSTANCE, T0);
    expect(f.keys.length).toBe(8);
  });

  it("approvers.json: añadir, nombre saneado, kid que no cuadra, quitar por kid en base64url o hex", () => {
    const r1 = addApprover([], A.spki, "  móvil ", T0);
    if ("error" in r1) throw new Error(r1.error);
    const r2 = addApprover(r1.file.keys, B.spki, undefined, T0);
    if ("error" in r2) throw new Error(r2.error);
    const parsed = parseApprovers(JSON.stringify(r2.file));
    expect(parsed.keys.map((k) => hex(k.kid))).toEqual([hex(A.kid), hex(B.kid)]);
    expect(parsed.entries[0]!.name).toBe("móvil");
    // Una entrada cuyo kid no es el de su llave no cuenta.
    const tampered = { v: 1, keys: [{ ...r2.file.keys[0]!, kid: r2.file.keys[1]!.kid }] };
    expect(parseApprovers(JSON.stringify(tampered)).keys).toEqual([]);
    expect(removeApprover(r2.file.keys, hex(A.kid))!.file.keys.map((k) => k.kid)).toEqual([b64u(B.kid)]);
    expect(removeApprover(r2.file.keys, b64u(B.kid))!.removed.kid).toBe(b64u(B.kid));
    expect(removeApprover(r2.file.keys, "nada")).toBeUndefined();
    expect(addApprover([], fromHex(TEST_KEY.spki), undefined, T0)).toEqual({ error: "llave de prueba: su clave privada es pública" });
    expect(b64u(kidOf(A.spki))).toBe(r1.entry.kid);
  });
});

describe("QR", () => {
  it("rellena la plantilla del controlador (token y K) y exige {k}", () => {
    const url = fillPairUrl("https://c.example/pair?i={instance}&t={token}&k={k}", INSTANCE, "a b&c", K1);
    expect(url).toBe(`https://c.example/pair?i=${INSTANCE}&t=a%20b%26c&k=${b64u(K1)}`);
    expect(fillPairUrl("https://c.example/pair?i={instance}", INSTANCE, "t", K1)).toBeUndefined();
  });

  it("el QR tiene la forma de un QR (tamaño, patrones de posición) y se dibuja con dos módulos por línea", () => {
    const link = fillPairUrl("https://c.example/pair?i={instance}&t={token}&k={k}", INSTANCE, "tok", K1)!;
    const m = qrMatrix(link);
    const n = m.length;
    expect((n - 17) % 4).toBe(0); // tamaño de un QR: 17 + 4·versión
    // Patrones de posición en tres esquinas: el lector de un móvil los necesita.
    for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]] as const) {
      expect(m[r]![c]).toBe(true);
      expect(m[r + 1]![c + 1]).toBe(false);
      expect(m[r + 3]![c + 3]).toBe(true);
    }
    const lines = qrText(link).split("\n");
    expect(lines.length).toBe(Math.ceil((n + 4) / 2));
    expect(lines.every((l) => [...l].length === n + 4)).toBe(true);
  });
});
