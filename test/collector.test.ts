import { describe, expect, it } from "vitest";
import { BATCH_WINDOW_MS, Collector, MAX_BATCH, STORE_KEYS } from "../src/core/collector.js";
import type { HttpReply, Io } from "../src/core/collector.js";
import type { Config, Envelope, HookPayload } from "../src/core/types.js";
import { FIXTURE_NAMES, loadFixture, makeAjv, replay } from "./support/fixtures.js";

const cfg = (ctx: "personal" | "work" = "personal"): Config => ({ url: "http://srv:1", token: "tok", instanceId: "mac-test", ctx });

class FakeIo implements Io {
  time = 1_000_000;
  store = new Map<string, unknown>();
  logs: string[] = [];
  posts: { url: string; headers: Record<string, string>; env: Envelope }[] = [];
  /** Respuestas en orden; si se acaban, 200. Un Error se lanza como fallo de red. */
  replies: (HttpReply | Error)[] = [];
  now() {
    return this.time;
  }
  async post(url: string, init: { method: string; headers: Record<string, string>; body: string }) {
    const next = this.replies.shift();
    if (next instanceof Error) throw next;
    if (next === undefined || next.ok) this.posts.push({ url, headers: init.headers, env: JSON.parse(init.body) });
    return next ?? { status: 200, ok: true, text: "" };
  }
  async load(key: string) {
    return this.store.get(key);
  }
  async save(key: string, value: unknown) {
    if (value === null) this.store.delete(key);
    else this.store.set(key, JSON.parse(JSON.stringify(value)));
  }
  log(m: string) {
    this.logs.push(m);
  }
}

const stop = (i: number): HookPayload => ({ session_id: "s", hook_event_name: "Stop", turn_id: `t${i}`, is_aborted: false });
const make = async (io: FakeIo, c = cfg(), o = {}) => {
  const col = new Collector(c, io, o);
  await col.init();
  return col;
};
/** Base del contador: arranca en `now * 1024` para no chocar con otros procesos con el mismo instance_id. */
const BASE = 1_000_000 * 1024;
const sentN = (io: FakeIo) => io.posts.flatMap((p) => p.env.events.map((e) => e.n - BASE));
const down = (k: number): Error[] => Array.from({ length: k }, () => new Error("ECONNREFUSED"));

describe("sobre y transporte", () => {
  it("POST /v0/ingest con Bearer, sobre §3.1, n desde 1 y rx del momento de captura", async () => {
    const io = new FakeIo();
    const col = await make(io);
    col.ingest([stop(1)], 111);
    col.ingest([stop(2)], 222);
    await col.flush();
    expect(io.posts).toHaveLength(1);
    const p = io.posts[0]!;
    expect(p.url).toBe("http://srv:1/v0/ingest");
    expect(p.headers.authorization).toBe("Bearer tok");
    expect(p.headers["content-type"]).toBe("application/json");
    expect(p.env).toMatchObject({ orbit: "0.2.0", instance_id: "mac-test", ctx: "personal", src: "mod" });
    expect(p.env.events.map((e) => [e.n - BASE, e.rx])).toEqual([[1, 111], [2, 222]]);
  });

  it("la lista blanca se aplica ANTES de enviar con ctx=work", async () => {
    const io = new FakeIo();
    const col = await make(io, cfg("work"));
    col.ingest([{ session_id: "s", hook_event_name: "UserPromptSubmit", prompt: "secreto", turn_id: "t", cwd: "/Users/x" }], 1);
    await col.flush();
    const body = JSON.stringify(io.posts[0]!.env);
    expect(body).not.toContain("secreto");
    expect(body).not.toContain("/Users/x");
    expect(io.posts[0]!.env.events[0]!.ev).toEqual({ session_id: "s", hook_event_name: "UserPromptSubmit", turn_id: "t" });
    // tampoco queda en la cola persistida
    expect(JSON.stringify([...io.store.values()])).not.toContain("secreto");
  });
});

describe("lotes de 250 ms (máx. 500)", () => {
  it("el envío se programa 250 ms después del primer evento de la ventana", async () => {
    const io = new FakeIo();
    const col = await make(io);
    expect(col.delay(1000)).toBeNull();
    col.ingest([stop(1)], 1000);
    expect(col.delay(1000)).toBe(BATCH_WINDOW_MS);
    col.ingest([stop(2)], 1100);
    expect(col.delay(1100)).toBe(BATCH_WINDOW_MS - 100); // la ventana no se alarga
    expect(col.delay(1400)).toBe(0);
  });

  it("1200 eventos salen en lotes de 500, 500 y 200, en orden de n", async () => {
    const io = new FakeIo();
    const col = await make(io);
    col.ingest(Array.from({ length: 1200 }, (_, i) => stop(i)), 5);
    await col.flush();
    expect(io.posts.map((p) => p.env.events.length)).toEqual([MAX_BATCH, MAX_BATCH, 200]);
    expect(sentN(io)).toEqual(Array.from({ length: 1200 }, (_, i) => i + 1));
  });

  it("maxBatch configurable nunca supera 500", async () => {
    const io = new FakeIo();
    const col = await make(io, cfg(), { maxBatch: 9999 });
    col.ingest(Array.from({ length: 501 }, (_, i) => stop(i)), 5);
    await col.flush();
    expect(io.posts.map((p) => p.env.events.length)).toEqual([500, 1]);
  });

  it("sin eventos no se envía nada", async () => {
    const io = new FakeIo();
    const col = await make(io);
    await col.flush();
    expect(io.posts).toHaveLength(0);
  });
});

describe("cola offline", () => {
  it("si el POST falla se conserva y se reenvía en orden de n, sin duplicar", async () => {
    const io = new FakeIo();
    io.replies = down(1);
    const col = await make(io);
    col.ingest([stop(1), stop(2)], 1);
    await col.flush();
    expect(io.posts).toHaveLength(0);
    expect(col.status()).toMatchObject({ queued: 2, state: "offline" });
    expect(col.status().lastError).toContain("ECONNREFUSED");
    col.ingest([stop(3)], 2);
    await col.flush();
    expect(sentN(io)).toEqual([1, 2, 3]);
    expect(col.status()).toMatchObject({ queued: 0, sent: 3, state: "connected" });
  });

  it("HTTP 500 y 401 conservan la cola; el error queda visible", async () => {
    const io = new FakeIo();
    io.replies = [{ status: 500, ok: false, text: "boom" }];
    const col = await make(io);
    col.ingest([stop(1)], 1);
    await col.flush();
    expect(col.status()).toMatchObject({ queued: 1 });
    expect(col.status().lastError).toContain("HTTP 500");
    io.replies = [{ status: 401, ok: false, text: "" }];
    await col.flush();
    expect(col.status()).toMatchObject({ queued: 1 });
    expect(col.status().lastError).toContain("HTTP 401");
  });

  it("el reintento usa backoff: delay() respeta nextRetry y crece", async () => {
    const io = new FakeIo();
    io.replies = down(3);
    const col = await make(io);
    col.ingest([stop(1)], io.time);
    await col.flush();
    expect(col.delay(io.time)).toBe(1000);
    await col.flush();
    expect(col.delay(io.time)).toBe(2000);
    await col.flush();
    expect(col.delay(io.time)).toBe(4000);
    await col.flush(); // éxito
    expect(col.delay(io.time)).toBeNull();
  });

  it("sobrevive a un reinicio: la cola y el contador se recargan de la store", async () => {
    const io = new FakeIo();
    io.replies = down(1);
    const a = await make(io);
    a.ingest([stop(1), stop(2)], 1);
    await a.flush();
    expect(io.store.get(STORE_KEYS.queue("mac-test"))).toBeDefined();

    const b = await make(io);
    expect(b.status().queued).toBe(2);
    b.ingest([stop(3)], 2);
    await b.flush();
    const n = sentN(io);
    expect(n.slice(0, 2)).toEqual([1, 2]);
    expect(n[2]!).toBeGreaterThan(2); // continúa tras la reserva: nunca repite n
    expect(io.store.has(STORE_KEYS.queue("mac-test"))).toBe(false); // vacía: se limpia lo persistido
  });

  it("n es monótono entre reinicios aunque no se haya enviado nada", async () => {
    const io = new FakeIo();
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await make(io, cfg(), { seqBlock: 10 });
      c.ingest([stop(i), stop(i)], 1);
      await c.flush();
    }
    seen.push(...sentN(io));
    expect(seen).toEqual([...seen].sort((x, y) => x - y));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("tope de tamaño: descarta los más viejos y REGISTRA cuántos se perdieron", async () => {
    const io = new FakeIo();
    io.replies = down(1);
    const col = await make(io, cfg(), { queue: { maxEvents: 5 } });
    col.ingest(Array.from({ length: 12 }, (_, i) => stop(i)), 1);
    await col.flush();
    expect(col.status()).toMatchObject({ queued: 5, dropped: 7 });
    expect(io.logs.some((l) => /perdieron 7 eventos/.test(l))).toBe(true);
    await col.flush();
    expect(sentN(io)).toEqual([8, 9, 10, 11, 12]); // los más nuevos, en orden
  });

  it("el tope también cuenta lo perdido al recargar una cola persistida mayor", async () => {
    const io = new FakeIo();
    io.replies = down(1);
    const a = await make(io);
    a.ingest(Array.from({ length: 10 }, (_, i) => stop(i)), 1);
    await a.flush();
    const b = await make(io, cfg(), { queue: { maxEvents: 4 } });
    expect(b.status()).toMatchObject({ queued: 4, dropped: 6 });
    await b.flush();
    expect(io.logs.some((l) => /perdieron 6 eventos/.test(l))).toBe(true);
  });

  it("un lote rechazado (400) se descarta, se cuenta y se registra; no bloquea la cola", async () => {
    const io = new FakeIo();
    // Lote [1,2] rechazado; se parte y el evento 1 sigue rechazado: solo ese se descarta.
    io.replies = [{ status: 400, ok: false, text: "bad" }, { status: 400, ok: false, text: "bad" }];
    const col = await make(io, cfg(), { maxBatch: 2 });
    col.ingest(Array.from({ length: 4 }, (_, i) => stop(i)), 1);
    await col.flush();
    expect(sentN(io)).toEqual([2, 3, 4]);
    expect(col.status()).toMatchObject({ dropped: 1, queued: 0 });
    expect(io.logs.some((l) => /perdieron 1 eventos/.test(l))).toBe(true);
    expect(col.status().lastError).toContain("400");
  });

  it("un solo evento inválido en un lote de 500 no pierde los otros 499", async () => {
    const io = new FakeIo();
    const badN = BASE + 137;
    // El servidor real rechaza el sobre entero si algún evento es inválido.
    const origPost = io.post.bind(io);
    io.post = async (url, init) => {
      const env = JSON.parse(init.body) as Envelope;
      if (env.events.some((e) => e.n === badN)) return { status: 400, ok: false, text: "bad_event" };
      return origPost(url, init);
    };
    const col = await make(io);
    col.ingest(Array.from({ length: 500 }, (_, i) => stop(i)), 1);
    await col.flush();
    expect(col.status()).toMatchObject({ dropped: 1, queued: 0, sent: 499 });
    const sent = sentN(io);
    expect(sent).toHaveLength(499);
    expect(sent).not.toContain(137);
    expect(sent).toEqual([...sent].sort((x, y) => x - y));
  });

  it("el servidor que descarta repetidos (duplicates>0) queda registrado y visible en el estado", async () => {
    const io = new FakeIo();
    io.replies = [{ status: 200, ok: true, text: JSON.stringify({ orbit: "0.2.0", accepted: 1, duplicates: 2 }) }];
    const col = await make(io);
    col.ingest([stop(1), stop(2), stop(3)], 1);
    await col.flush();
    expect(col.status().duplicates).toBe(2);
    expect(io.logs.some((l) => /descartó 2 eventos por repetidos/.test(l))).toBe(true);
  });

  it("dos procesos con el mismo instance_id y un store vacío no reutilizan n", async () => {
    const ioA = new FakeIo();
    const ioB = new FakeIo();
    ioB.time = ioA.time + 5; // arrancan en ms distintos, cada uno con su store (vacío)
    const a = await make(ioA);
    const b = await make(ioB);
    a.ingest(Array.from({ length: 1500 }, (_, i) => stop(i)), 1);
    b.ingest(Array.from({ length: 300 }, (_, i) => stop(i)), 1);
    await a.flush();
    await b.flush();
    const all = [...ioA.posts, ...ioB.posts].flatMap((p) => p.env.events.map((e) => e.n));
    expect(new Set(all).size).toBe(all.length);
  });

  it("la pausa es por instancia: pausar una no pausa a otra del mismo store", async () => {
    const io = new FakeIo();
    await (await make(io)).setPaused(true);
    expect((await make(io, { ...cfg(), instanceId: "otra" })).isPaused).toBe(false);
    expect((await make(io)).isPaused).toBe(true);
  });

  it("cada instance_id tiene su propia cola y su propio contador", async () => {
    const io = new FakeIo();
    io.replies = down(1);
    const a = await make(io);
    a.ingest([stop(1), stop(2)], 1);
    await a.flush();
    const b = await make(io, { ...cfg(), instanceId: "mac-otro" });
    expect(b.status().queued).toBe(0);
    b.ingest([stop(1)], 1);
    await b.flush();
    expect(io.posts[0]!.env).toMatchObject({ instance_id: "mac-otro" });
    expect(io.posts[0]!.env.events.map((e) => e.n - BASE)).toEqual([1]);
    expect((await make(io)).status().queued).toBe(2); // la de mac-test sigue ahí
  });

  it("si ctx pasó a work, lo guardado como personal se vuelve a filtrar antes de reenviarlo", async () => {
    const io = new FakeIo();
    io.replies = down(1);
    const a = await make(io);
    a.ingest([{ session_id: "s", hook_event_name: "UserPromptSubmit", prompt: "privado" }], 1);
    await a.flush();
    const b = await make(io, cfg("work"));
    await b.flush();
    expect(JSON.stringify(io.posts)).not.toContain("privado");
    expect(io.posts[0]!.env.ctx).toBe("work");
  });
});

describe("pausa", () => {
  it("en pausa se acumula sin enviar; al reanudar sale todo en orden", async () => {
    const io = new FakeIo();
    const col = await make(io);
    await col.setPaused(true);
    col.ingest([stop(1), stop(2)], 1);
    expect(col.delay(2)).toBeNull();
    await col.flush();
    expect(io.posts).toHaveLength(0);
    expect(col.status()).toMatchObject({ state: "paused", queued: 2 });
    await col.setPaused(false);
    expect(col.delay(io.time)).toBe(0);
    await col.flush();
    expect(sentN(io)).toEqual([1, 2]);
  });

  it("la pausa se persiste entre sesiones", async () => {
    const io = new FakeIo();
    await (await make(io)).setPaused(true);
    expect((await make(io)).isPaused).toBe(true);
  });
});

describe("e2e puro: fixtures reales -> colector -> schema de ingesta", () => {
  for (const ctx of ["personal", "work"] as const) {
    it(`todos los fixtures producen sobres válidos contra ingest.schema.json (ctx=${ctx})`, async () => {
      const validate = makeAjv().getSchema("ingest.schema.json")!;
      for (const name of FIXTURE_NAMES) {
        const io = new FakeIo();
        const col = await make(io, cfg(ctx));
        const evs = replay(loadFixture(name));
        col.ingest(evs, 1791683886699);
        await col.flush();
        expect(io.posts.length, name).toBeGreaterThan(0);
        for (const p of io.posts) expect(validate(p.env), `${name}: ${JSON.stringify(validate.errors?.slice(0, 3))}`).toBe(true);
        expect(sentN(io)).toEqual(evs.map((_, i) => i + 1));
      }
    });
  }
});
