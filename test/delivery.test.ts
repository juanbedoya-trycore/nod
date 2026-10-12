/** Entrega: cola, lotes, rechazos, reintentos, persistencia y numeración. */
import { describe, expect, it } from "vitest";
import { Counter, SEQ_PER_MS } from "../src/core/counter.js";
import type { Envelope, NodEvent, Privacy } from "../src/core/events.js";
import { Outbox, sinkId } from "../src/core/outbox.js";
import type { Delivery } from "../src/core/outbox.js";
import { OfflineQueue } from "../src/core/queue.js";

const ev = (seq: number): NodEvent => ({ seq, ts: seq, type: "turn.start", session: "s", data: {} });

function box(respond: (env: Envelope) => Delivery | Promise<Delivery>, store = new Map<string, unknown>()) {
  const sent: Envelope[] = [];
  let now = 1000;
  const o = new Outbox(
    { kind: "http", target: "http://127.0.0.1:1" },
    (p: Privacy) => ({ instance: "i", host: "test", profile: "p", privacy: p }),
    async (env) => {
      sent.push(env);
      return respond(env);
    },
    { now: async () => now, load: async (k) => store.get(k), save: async (k, v) => void (v === null ? store.delete(k) : store.set(k, structuredClone(v))), log: () => undefined },
    "i",
  );
  return { o, sent, store, advance: (ms: number) => (now += ms), now: () => now };
}

describe("Outbox", () => {
  it("espera la ventana del lote salvo urgencia", async () => {
    const { o } = box(() => ({ status: 200 }));
    o.push({ e: ev(1), p: "completo" }, 1000);
    expect(o.delay(1000, false)).toBe(250);
    o.urgent();
    expect(o.delay(1000, false)).toBe(0);
    expect(o.delay(1000, true)).toBeNull();
  });

  it("un lote por perfil de privacidad", async () => {
    const { o, sent } = box(() => ({ status: 200 }));
    o.push({ e: ev(1), p: "completo" }, 0);
    o.push({ e: ev(2), p: "completo" }, 0);
    o.push({ e: ev(3), p: "redactado" }, 0);
    await o.flush();
    expect(sent.map((s) => [s.source.privacy, s.events.map((e) => e.seq)])).toEqual([["completo", [1, 2]], ["redactado", [3]]]);
    expect(o.status().sent).toBe(3);
  });

  it("400: aísla el evento culpable, lo descarta y entrega el resto", async () => {
    const { o, sent } = box((env) => ({ status: env.events.some((e) => e.seq === 3) ? 400 : 200 }));
    for (let i = 1; i <= 6; i++) o.push({ e: ev(i), p: "completo" }, 0);
    await o.flush();
    const ok = sent.filter((s) => !s.events.some((e) => e.seq === 3)).flatMap((s) => s.events.map((e) => e.seq));
    expect(ok.sort()).toEqual([1, 2, 4, 5, 6]);
    expect(o.status()).toMatchObject({ queued: 0, sent: 5, dropped: 1 });
  });

  it("503: guarda la cola, espera y la entrega después en orden", async () => {
    let up = false;
    const store = new Map<string, unknown>();
    const { o, sent, advance, now } = box(() => ({ status: up ? 200 : 503 }), store);
    o.push({ e: ev(1), p: "completo" }, 0);
    o.push({ e: ev(2), p: "completo" }, 0);
    await o.flush();
    expect(o.status()).toMatchObject({ queued: 2, sent: 0, lastError: "HTTP 503" });
    expect([...store.keys()]).toEqual([`nod.outbox.i.${sinkId({ kind: "http", target: "http://127.0.0.1:1" })}`]);
    expect(o.delay(now(), false)).toBeGreaterThan(0);
    up = true;
    advance(60_000);
    await o.flush();
    expect(sent.at(-1)!.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(store.size).toBe(0);
  });

  it("lo que quedó en cola en otra sesión se recupera al arrancar", async () => {
    const store = new Map<string, unknown>();
    const a = box(() => ({ status: 503 }), store);
    a.o.push({ e: ev(7), p: "completo" }, 0);
    await a.o.flush();
    const b = box(() => ({ status: 200 }), store);
    await b.o.init();
    expect(b.o.status().queued).toBe(1);
    await b.o.flush();
    expect(b.sent[0]!.events.map((e) => e.seq)).toEqual([7]);
  });

  it("si el transporte lanza (red, disco), no se pierde nada", async () => {
    const { o } = box(() => {
      throw new Error("ECONNREFUSED");
    });
    o.push({ e: ev(1), p: "completo" }, 0);
    await o.flush();
    expect(o.status()).toMatchObject({ queued: 1, lastError: "ECONNREFUSED" });
  });

  it("cuenta los duplicados que dice el destino", async () => {
    const { o } = box(() => ({ status: 200, text: JSON.stringify({ accepted: 1, duplicates: 1 }) }));
    o.push({ e: ev(1), p: "completo" }, 0);
    o.push({ e: ev(2), p: "completo" }, 0);
    await o.flush();
    expect(o.status().duplicates).toBe(1);
  });
});

describe("OfflineQueue", () => {
  it("al llenarse descarta los más viejos y lo cuenta", () => {
    const q = new OfflineQueue<number>({ maxEvents: 3, maxBytes: 1e6 });
    for (let i = 1; i <= 5; i++) q.push(i);
    expect(q.peek(10)).toEqual([3, 4, 5]);
    expect(q.droppedTotal).toBe(2);
  });
});

describe("Counter", () => {
  it("nunca repite: tras reiniciar sigue por encima de lo reservado y del reloj", () => {
    const a = new Counter("i", undefined, 1000);
    const first = a.next();
    expect(first).toBe(1000 * SEQ_PER_MS + 1);
    for (let i = 0; i < 1500; i++) a.next();
    const last = a.next();
    const b = new Counter("i", a.snapshot(), 1000);
    expect(b.next()).toBeGreaterThan(last);
    // Otra instancia no hereda la reserva.
    expect(new Counter("j", a.snapshot(), 1000).next()).toBe(first);
  });
});
