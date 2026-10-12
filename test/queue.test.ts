import { describe, expect, it } from "vitest";
import { OfflineQueue } from "../src/core/queue.js";
import { Sequencer, buildEnvelope } from "../src/core/sequencer.js";
import type { IngestEvent } from "../src/core/types.js";

const ev = (n: number, pad = 0): IngestEvent => ({ n, rx: 1000 + n, ev: { session_id: "s", hook_event_name: "Stop", pad: "x".repeat(pad) } });

describe("OfflineQueue", () => {
  it("conserva el orden y permite peek/ack", () => {
    const q = new OfflineQueue({ maxEvents: 10, maxBytes: 1e6 });
    for (let i = 1; i <= 5; i++) q.push(ev(i));
    expect(q.peek(3).map((e) => e.n)).toEqual([1, 2, 3]);
    q.ack(2);
    expect(q.peek(10).map((e) => e.n)).toEqual([3, 4, 5]);
    expect(q.length).toBe(3);
  });

  it("al llegar al tope descarta los más viejos y cuenta cuántos", () => {
    const q = new OfflineQueue({ maxEvents: 3, maxBytes: 1e6 });
    let dropped = 0;
    for (let i = 1; i <= 7; i++) dropped += q.push(ev(i));
    expect(dropped).toBe(4);
    expect(q.droppedTotal).toBe(4);
    expect(q.peek(10).map((e) => e.n)).toEqual([5, 6, 7]);
  });

  it("respeta el tope de bytes", () => {
    const q = new OfflineQueue({ maxEvents: 1000, maxBytes: 1000 });
    for (let i = 1; i <= 20; i++) q.push(ev(i, 200));
    expect(q.byteSize).toBeLessThanOrEqual(1000);
    expect(q.droppedTotal).toBeGreaterThan(0);
    expect(q.droppedTotal + q.length).toBe(20);
  });

  it("un evento enorme no vacía la cola por completo: siempre queda el último", () => {
    const q = new OfflineQueue({ maxEvents: 10, maxBytes: 100 });
    q.push(ev(1, 5000));
    expect(q.length).toBe(1);
  });

  it("reject cuenta como perdidos", () => {
    const q = new OfflineQueue();
    for (let i = 1; i <= 4; i++) q.push(ev(i));
    expect(q.reject(3)).toBe(3);
    expect(q.droppedTotal).toBe(3);
  });

  it("load reordena por n y suma lo perdido", () => {
    const a = new OfflineQueue();
    a.push(ev(2));
    a.push(ev(1));
    const b = new OfflineQueue({ maxEvents: 10, maxBytes: 1e6 });
    b.load({ items: [ev(3), ev(1), ev(2)], dropped: 5 });
    expect(b.peek(10).map((e) => e.n)).toEqual([1, 2, 3]);
    expect(b.droppedTotal).toBe(5);
  });
});

describe("Sequencer", () => {
  it("n crece de 1 en 1 desde 1", () => {
    const s = new Sequencer("mac", undefined, 10);
    expect([s.next(), s.next(), s.next()]).toEqual([1, 2, 3]);
  });

  it("tras reiniciar continúa desde la reserva: nunca repite", () => {
    const a = new Sequencer("mac", undefined, 10);
    const used = Array.from({ length: 25 }, () => a.next());
    const b = new Sequencer("mac", a.snapshot(), 10);
    expect(b.next()).toBeGreaterThan(Math.max(...used));
  });

  it("la reserva persistida siempre cubre los n asignados", () => {
    const s = new Sequencer("mac", undefined, 5);
    for (let i = 0; i < 100; i++) {
      const n = s.next();
      expect(s.snapshot().reserve).toBeGreaterThanOrEqual(n);
    }
  });

  it("arranca como mínimo en nowMs*1024: dos arranques en ms distintos no solapan", () => {
    const a = new Sequencer("mac", undefined, 1000, 5000);
    const b = new Sequencer("mac", undefined, 1000, 5001);
    const na = Array.from({ length: 1000 }, () => a.next());
    const nb = Array.from({ length: 1000 }, () => b.next());
    expect(Math.min(...nb)).toBeGreaterThan(Math.max(...na));
  });

  it("si el store ya va por delante del reloj, continúa desde el store", () => {
    const a = new Sequencer("mac", { instance_id: "mac", reserve: 9_000_000 }, 10, 1);
    expect(a.next()).toBe(9_000_001);
  });

  it("otro instance_id empieza de cero", () => {
    const a = new Sequencer("mac-a", { instance_id: "mac-b", reserve: 500 });
    expect(a.next()).toBe(1);
  });
});

describe("buildEnvelope", () => {
  it("tiene la forma de SPEC §3.1", () => {
    expect(buildEnvelope({ instanceId: "mac", ctx: "work" }, [ev(1)])).toEqual({
      orbit: "0.2.0", instance_id: "mac", ctx: "work", src: "mod", events: [ev(1)],
    });
  });
});
