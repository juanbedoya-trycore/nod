/** Entrega: cola, lotes, rechazos, reintentos, persistencia y varias ejecuciones a la vez. */
import { describe, expect, it } from "vitest";
import type { Envelope, NodEvent, Privacy } from "../src/core/events.js";
import { ORPHAN_AFTER_MS, Outbox, sinkId } from "../src/core/outbox.js";
import type { Delivery, Queued } from "../src/core/outbox.js";
import { OfflineQueue } from "../src/core/queue.js";

const SINK = { kind: "http" as const, target: "http://127.0.0.1:1" };
const BASE = `nod.outbox.i.${sinkId(SINK)}`;
const ev = (seq: number, data: Record<string, unknown> = {}): NodEvent => ({ seq, ts: seq, type: "turn.start", session: "s", data });
const q = (seq: number, p: Privacy = "completo", r = "run00001"): Queued => ({ e: ev(seq), p, r });

function box(respond: (env: Envelope) => Delivery | Promise<Delivery>, opts: { store?: Map<string, unknown>; run?: string; now?: number; maxEvents?: number } = {}) {
  const store = opts.store ?? new Map<string, unknown>();
  const sent: Envelope[] = [];
  let now = opts.now ?? 1_000_000;
  const o = new Outbox(
    SINK,
    (p: Privacy, run: string) => ({ instance: "i", run, host: "test", profile: "p", privacy: p }),
    async (env) => {
      sent.push(env);
      return respond(env);
    },
    { now: async () => now, load: async (k) => store.get(k), save: async (k, v) => void (v === null ? store.delete(k) : store.set(k, structuredClone(v))), log: () => undefined },
    "i",
    opts.run ?? "run00001",
    opts.maxEvents === undefined ? undefined : { maxEvents: opts.maxEvents },
  );
  return { o, sent, store, advance: (ms: number) => (now += ms), now: () => now };
}

describe("Outbox", () => {
  it("espera la ventana del lote salvo urgencia", () => {
    const { o } = box(() => ({ status: 200 }));
    o.push(q(1), 1000);
    expect(o.delay(1000, false)).toBe(250);
    o.urgent();
    expect(o.delay(1000, false)).toBe(0);
    expect(o.delay(1000, true)).toBeNull();
  });

  it("un sobre por perfil de privacidad y por ejecución", async () => {
    const { o, sent } = box(() => ({ status: 200 }));
    o.push(q(1), 0);
    o.push(q(2), 0);
    o.push(q(3, "redactado"), 0);
    o.push(q(1, "redactado", "run00002"), 0);
    await o.flush();
    expect(sent.map((s) => [s.source.privacy, s.source.run, s.events.map((e) => e.seq)])).toEqual([
      ["completo", "run00001", [1, 2]],
      ["redactado", "run00001", [3]],
      ["redactado", "run00002", [1]],
    ]);
  });

  it("400: aísla el evento culpable, lo descarta y entrega el resto", async () => {
    const { o, sent } = box((env) => ({ status: env.events.some((e) => e.seq === 3) ? 400 : 200 }));
    for (let i = 1; i <= 6; i++) o.push(q(i), 0);
    await o.flush();
    const ok = sent.filter((s) => !s.events.some((e) => e.seq === 3)).flatMap((s) => s.events.map((e) => e.seq));
    expect(ok.sort()).toEqual([1, 2, 4, 5, 6]);
    expect(o.status()).toMatchObject({ queued: 0, sent: 5, dropped: 1 });
  });

  it("si la cola se desborda con un lote en vuelo, el acuse no se lleva eventos que no salieron", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { o, sent } = box(async () => {
      await gate;
      return { status: 200 };
    }, { maxEvents: 4 });
    for (let i = 1; i <= 4; i++) o.push(q(i), 0);
    const flushing = o.flush();
    await new Promise((r) => setTimeout(r, 0)); // el lote ya está en vuelo
    o.push(q(5), 0);
    o.push(q(6), 0); // la cola descarta 1 y 2 para caber
    release();
    await flushing;
    expect(sent[0]!.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    // 5 y 6 siguen pendientes (o ya entregados en el mismo flush), nunca perdidos.
    const delivered = sent.flatMap((s) => s.events.map((e) => e.seq));
    expect(delivered).toEqual(expect.arrayContaining([5, 6]));
    expect(o.status().queued).toBe(0);
  });

  it("503: guarda la cola, espera y la entrega después en orden", async () => {
    let up = false;
    const { o, sent, store, advance, now } = box(() => ({ status: up ? 200 : 503 }));
    o.push(q(1), 0);
    o.push(q(2), 0);
    await o.flush();
    expect(o.status()).toMatchObject({ queued: 2, sent: 0, lastError: "HTTP 503" });
    expect((store.get(`${BASE}.run00001`) as { items: unknown[] }).items).toHaveLength(2);
    expect(o.delay(now(), false)).toBeGreaterThan(0);
    up = true;
    advance(60_000);
    await o.flush();
    expect(sent.at(-1)!.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(store.has(`${BASE}.run00001`)).toBe(false);
  });

  it("dos sesiones vivas no se pisan la cola; la de un proceso muerto se adopta", async () => {
    const store = new Map<string, unknown>();
    const a = box(() => ({ status: 503 }), { store, run: "aaaaaaaa" });
    const b = box(() => ({ status: 503 }), { store, run: "bbbbbbbb" });
    await a.o.init();
    await b.o.init();
    a.o.push(q(1, "completo", "aaaaaaaa"), 0);
    b.o.push(q(1, "completo", "bbbbbbbb"), 0);
    await a.o.flush();
    await b.o.flush();
    // Una tercera arranca enseguida: las dos están vivas, no adopta nada.
    const c = box(() => ({ status: 200 }), { store, run: "cccccccc" });
    await c.o.init();
    expect(c.o.status().adopted).toBe(0);
    // Mucho después (A y B ya no guardan): las adopta y las entrega, cada una con su ejecución.
    const d = box(() => ({ status: 200 }), { store, run: "dddddddd", now: 1_000_000 + ORPHAN_AFTER_MS + 1 });
    await d.o.init();
    expect(d.o.status().adopted).toBe(2);
    await d.o.flush();
    expect(d.sent.map((s) => s.source.run).sort()).toEqual(["aaaaaaaa", "bbbbbbbb"]);
    expect(store.has(`${BASE}.aaaaaaaa`)).toBe(false);
  });

  it("lo encolado durante la espera se guarda sin esperar a la entrega", async () => {
    const { o, store } = box(() => ({ status: 503 }));
    o.push(q(1), 0);
    await o.flush();
    for (let i = 2; i <= 50; i++) o.push(q(i), 0);
    await o.persistSoon(Number.MAX_SAFE_INTEGER);
    expect((store.get(`${BASE}.run00001`) as { items: unknown[] }).items).toHaveLength(50);
  });

  it("endurecer la privacidad vuelve a filtrar lo encolado; un destino vetado se vacía", async () => {
    const { o, store } = box(() => ({ status: 503 }));
    o.push({ e: ev(1, { text: "secreto", chars: 7 }), p: "completo", r: "run00001" }, 0);
    await o.flush();
    await o.restrict("redactado", true);
    expect(JSON.stringify(store.get(`${BASE}.run00001`))).not.toContain("secreto");
    expect(o.queue.peek(1)[0]!.p).toBe("redactado");
    expect(await o.restrict("trabajo", false)).toBe(1);
    expect(o.status().queued).toBe(0);
  });

  it("si el transporte lanza, no se pierde nada y la cadena sigue viva", async () => {
    let fail = true;
    const { o, sent } = box(() => {
      if (fail) throw new Error("ECONNREFUSED");
      return { status: 200 };
    });
    o.push(q(1), 0);
    await o.flush();
    expect(o.status()).toMatchObject({ queued: 1, lastError: "ECONNREFUSED" });
    fail = false;
    await o.flush();
    expect(sent.at(-1)!.events.map((e) => e.seq)).toEqual([1]);
  });

  it("cuenta los duplicados que dice el destino", async () => {
    const { o } = box(() => ({ status: 200, text: JSON.stringify({ accepted: 1, duplicates: 1 }) }));
    o.push(q(1), 0);
    o.push(q(2), 0);
    await o.flush();
    expect(o.status().duplicates).toBe(1);
  });
});

describe("OfflineQueue", () => {
  it("al llenarse descarta los más viejos y lo cuenta", () => {
    const queue = new OfflineQueue<number>({ maxEvents: 3, maxBytes: 1e6 });
    for (let i = 1; i <= 5; i++) queue.push(i);
    expect(queue.peek(10)).toEqual([3, 4, 5]);
    expect(queue.droppedTotal).toBe(2);
  });
});
