/** Mensajes de un aprobador: el long-poll, qué se acepta (sid, edad, repetidos) y el plan para text, stop y recap. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTEXT_PREFIX, MessageLoop, Notes, RECAP_PROMPT, messagePlan, withContext } from "../src/core/control/messages.js";
import type { Accepted } from "../src/core/control/messages.js";
import { FakeController, approver, fakeIo, message } from "./support/control.js";

const A = approver("nod-msg-aprobador");
const B = approver("nod-msg-intruso");
const INSTANCE = "personal-3fa9c2d1";
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const sec = () => Math.floor(Date.now() / 1000);

describe("plan", () => {
  it("text: nota con turno, prompt sin turno; vacío no hace nada", () => {
    expect(messagePlan("text", "sigue", true)).toEqual({ abort: false, note: "sigue" });
    expect(messagePlan("text", "sigue", false)).toEqual({ abort: false, submitNow: "sigue" });
    expect(messagePlan("text", "  ", false)).toEqual({ abort: false });
  });

  it("stop: corta si hay turno; su texto no es un prompt", () => {
    expect(messagePlan("stop", "rm -rf", true)).toEqual({ abort: true });
    expect(messagePlan("stop", "", false)).toEqual({ abort: false });
  });

  it("recap: corta y pide el resumen al terminar; sin turno, ya", () => {
    expect(messagePlan("recap", "", true)).toEqual({ abort: true, submitAfterTurn: RECAP_PROMPT });
    expect(messagePlan("recap", "¿qué falta?", true)).toEqual({ abort: true, submitAfterTurn: "¿qué falta?" });
    expect(messagePlan("recap", "", false)).toEqual({ abort: false, submitNow: RECAP_PROMPT });
  });

  it("notas: contexto con prefijo o prompt tal cual, y se vacían", () => {
    const n = new Notes();
    n.push("uno");
    n.push("dos");
    expect(n.takeContext()).toBe(`${CONTEXT_PREFIX}uno\n${CONTEXT_PREFIX}dos`);
    expect(n.takeContext()).toBeUndefined();
    n.push("tres");
    expect(n.takePrompt()).toBe("tres");
    expect(n.size).toBe(0);
  });

  it("withContext añade sin perder el contexto que ya había", () => {
    expect(withContext({ result: "ok" }, "x")).toEqual({ result: "ok", context: ["x"] });
    expect(withContext({ result: "ok", context: "a" }, "x")).toEqual({ result: "ok", context: ["a", "x"] });
    expect(withContext({ context: ["a", 3] }, "x")).toEqual({ context: ["a", "x"] });
    expect(withContext(undefined, "x")).toBeUndefined();
  });
});

describe("bucle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  function setup(session = "s1") {
    const ctrl = new FakeController();
    const got: Accepted[] = [];
    const logs: string[] = [];
    let current: string | undefined = session;
    let keys = [A.paired];
    const loop = new MessageLoop({
      controller: { url: ctrl.base, token: "tok" },
      io: fakeIo(ctrl, logs),
      instance: INSTANCE,
      session: () => current,
      keys: async () => keys,
      onMessage: async (m) => void got.push(m),
    });
    return { ctrl, got, logs, loop, stop: () => (current = undefined), switchTo: (s: string) => (current = s), setKeys: (k: typeof keys) => (keys = k) };
  }

  it("acepta los de esta sesión y descarta los de otra, los viejos, los de otra llave y los repetidos", async () => {
    const f = setup();
    void f.loop.run();
    await vi.advanceTimersByTimeAsync(1_000);
    const ok = message(A, INSTANCE, "s1", "text", "hola", sec());
    f.ctrl.messages.push(
      ok,
      message(A, INSTANCE, "otra", "text", "no", sec()),
      message(A, INSTANCE, "s1", "text", "viejo", sec() - 121),
      message(B, INSTANCE, "s1", "stop", "", sec()),
      ok,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.got).toEqual([{ id: ok.id, kind: "text", text: "hola" }]);
    expect(f.logs.filter((l) => l.includes("descartado"))).toEqual([
      "nod control: mensaje descartado (sid)",
      "nod control: mensaje descartado (expired)",
      "nod control: mensaje descartado (kid)",
    ]);
    // El controlador lo vuelve a dar más tarde: ya aplicado, se ignora sin ruido.
    f.ctrl.messages.push(ok);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.got.length).toBe(1);
    expect(f.loop.rejected).toBe(3);
    const get = f.ctrl.calls.find((c) => c.method === "GET")!;
    expect(get.url).toBe(`${f.ctrl.base}/v1/control/messages?session=s1&wait=20000`);
    expect(get.headers.authorization).toBe("Bearer tok");
    f.stop();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(f.loop.running).toBe(false);
  });

  it("stop y recap llegan en orden", async () => {
    const f = setup();
    void f.loop.run();
    f.ctrl.messages.push(message(A, INSTANCE, "s1", "stop", "", sec()), message(A, INSTANCE, "s1", "recap", "", sec()));
    await vi.advanceTimersByTimeAsync(500);
    expect(f.got.map((m) => m.kind)).toEqual(["stop", "recap"]);
    f.stop();
  });

  it("tras /clear escucha la sesión nueva (y el sid de la vieja ya no vale)", async () => {
    const f = setup();
    void f.loop.run();
    await vi.advanceTimersByTimeAsync(100);
    f.switchTo("s2");
    await vi.advanceTimersByTimeAsync(21_000);
    f.ctrl.messages.push(message(A, INSTANCE, "s1", "text", "vieja", sec()), message(A, INSTANCE, "s2", "text", "nueva", sec()));
    await vi.advanceTimersByTimeAsync(500);
    expect(f.got.map((m) => m.text)).toEqual(["nueva"]);
    expect(f.ctrl.calls.at(-1)!.url).toContain("session=s2");
    f.stop();
  });

  it("sin llaves no pregunta al controlador; al emparejar empieza", async () => {
    const f = setup();
    f.setKeys([]);
    void f.loop.run();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.ctrl.calls).toEqual([]);
    f.setKeys([A.paired]);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(f.ctrl.calls.length).toBeGreaterThan(0);
    f.stop();
  });

  it("controlador caído o colgado: reintenta con pausa, sin girar en vacío", async () => {
    const f = setup();
    f.ctrl.mode = "down";
    void f.loop.run();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.ctrl.calls.length).toBeLessThanOrEqual(7);
    f.ctrl.mode = "hang";
    const before = f.ctrl.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    // Cada petición colgada se abandona a los 23 s (wait + 3 s) y tras una pausa se pide otra.
    expect(f.ctrl.calls.length - before).toBeGreaterThanOrEqual(2);
    expect(f.ctrl.calls.length - before).toBeLessThanOrEqual(3);
    f.stop();
  });

  it("un controlador que contesta 204 sin esperar no lo hace girar en vacío", async () => {
    const f = setup();
    const orig = f.ctrl.fetch;
    f.ctrl.fetch = async (url, init) => (url.includes("/messages") ? { status: 204, ok: true, text: "" } : orig(url, init));
    let n = 0;
    const counting = f.ctrl.fetch;
    f.ctrl.fetch = async (url, init) => {
      n++;
      return counting(url, init);
    };
    void f.loop.run();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(n).toBeGreaterThanOrEqual(9);
    expect(n).toBeLessThanOrEqual(11);
    f.stop();
  });

  it("un solo bucle aunque se arranque dos veces", async () => {
    const f = setup();
    void f.loop.run();
    void f.loop.run();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.ctrl.calls.length).toBe(1);
    f.stop();
  });
});
