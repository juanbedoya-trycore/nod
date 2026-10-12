/**
 * La retención contra un controlador falso, con el reloj falso de vitest: quién gana la carrera, qué se descarta,
 * cuánto tarda en soltar el veredicto original cuando el controlador falla, y qué se le cuenta en /resolved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Holder } from "../src/core/control/hold.js";
import type { HoldOutcome, HoldRequest } from "../src/core/control/hold.js";
import { FakeController, approver, decide, fakeIo } from "./support/control.js";

const A = approver("nod-hold-aprobador");
const B = approver("nod-hold-intruso");
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);

function request(over: Partial<HoldRequest> = {}): HoldRequest {
  return {
    instance: "personal-3fa9c2d1",
    session: "s1",
    toolUseId: "toolu_1",
    tool: "Bash",
    summary: "touch x",
    wok: true,
    holdMs: 20_000,
    keys: async () => [A.paired],
    ...over,
  };
}

/** Lanza la retención y avanza el reloj falso hasta que termina (o `limit`). Devuelve el desenlace y cuándo. */
async function run(holder: Holder, ctrl: FakeController, req: HoldRequest, limit = 120_000, logs: string[] = []): Promise<{ out: HoldOutcome; ms: number }> {
  let out: HoldOutcome | undefined;
  const start = Date.now();
  let ms = -1;
  void holder.hold(req, { url: ctrl.base, token: "tok" }, fakeIo(ctrl, logs)).then((o) => {
    out = o;
    ms = Date.now() - start;
  });
  for (let t = 0; t < limit && out === undefined; t += 50) await vi.advanceTimersByTimeAsync(50);
  if (out === undefined) throw new Error("la retención no terminó");
  return { out, ms };
}

/** Deja correr el reloj (para el /resolved en segundo plano). */
const drain = async (ms = 5_000) => {
  for (let t = 0; t < ms; t += 100) await vi.advanceTimersByTimeAsync(100);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe("retención", () => {
  it("allow firmado → decisión remota; anuncia lo que firmará el aprobador y cierra con /resolved", async () => {
    const ctrl = new FakeController();
    ctrl.onApproval = (body) => setTimeout(() => ctrl.queue(body.id, decide(A, body, "allow")), 3_000);
    const { out, ms } = await run(new Holder(), ctrl, request({ agent: "ag1" }));
    expect(out).toEqual({ held: true, by: "remote", decision: "allow", reject: undefined, rejected: 0 });
    expect(ms).toBeGreaterThanOrEqual(3_000);
    expect(ms).toBeLessThan(4_000);
    const post = ctrl.calls[0]!;
    expect(post.url).toBe("http://127.0.0.1:7878/v1/control/approvals");
    expect(post.headers.authorization).toBe("Bearer tok");
    expect(post.body).toMatchObject({ instance: "personal-3fa9c2d1", session: "s1", tool_use_id: "toolu_1", tool: "Bash", summary: "touch x", wok: true, agent: "ag1", exp: Math.floor((T0 + 20_000) / 1000) });
    expect(post.body.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(post.body.sid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await drain();
    expect(ctrl.resolvedBodies()).toEqual([{ by: "remote", decision: "allow" }]);
  });

  it("deny firmado → deny", async () => {
    const ctrl = new FakeController();
    ctrl.onApproval = (body) => ctrl.queue(body.id, decide(A, body, "deny"));
    expect((await run(new Holder(), ctrl, request())).out).toMatchObject({ by: "remote", decision: "deny" });
  });

  it("una firma mala se descarta y se sigue esperando: gana la buena que llega después", async () => {
    const ctrl = new FakeController();
    ctrl.onApproval = (body) => {
      ctrl.queue(body.id, decide(B, body, "allow")); // llave no emparejada
      ctrl.queue(body.id, decide(A, body, "allow", undefined, { summary: "rm -rf /" })); // firmó otra cosa
      setTimeout(() => ctrl.queue(body.id, decide(A, body, "allow")), 5_000);
    };
    const logs: string[] = [];
    const { out, ms } = await run(new Holder(), ctrl, request(), 120_000, logs);
    expect(out).toEqual({ held: true, by: "remote", decision: "allow", reject: "sig", rejected: 2 });
    expect(ms).toBeGreaterThanOrEqual(5_000);
    expect(logs.join("\n")).toMatch(/descartada.*kid[\s\S]*descartada.*sig/);
    await drain();
    expect(ctrl.resolvedBodies()).toEqual([{ by: "remote", decision: "allow", reject: "sig" }]);
  });

  it("sin decisión: vence el plazo exactamente en hold_ms y se devuelve el veredicto original", async () => {
    const ctrl = new FakeController();
    const { out, ms } = await run(new Holder(), ctrl, request({ holdMs: 7_000 }));
    expect(out).toMatchObject({ held: true, by: "timeout", decision: "none" });
    expect(ms).toBeGreaterThanOrEqual(7_000);
    expect(ms).toBeLessThan(7_100);
    await drain();
    expect(ctrl.resolvedBodies()).toEqual([{ by: "timeout", decision: "none" }]);
  });

  it("una decisión firmada que llega tarde (después de exp) no cuenta", async () => {
    const ctrl = new FakeController();
    ctrl.onApproval = (body) => setTimeout(() => ctrl.queue(body.id, decide(A, body, "allow")), 25_000);
    expect((await run(new Holder(), ctrl, request())).out).toMatchObject({ by: "timeout" });
  });

  it("la cancelación del agente gana en cuanto llega", async () => {
    const ctrl = new FakeController();
    const listeners: (() => void)[] = [];
    const signal = { aborted: false, addEventListener: (_t: "abort", cb: () => void) => void listeners.push(cb), removeEventListener: () => undefined };
    setTimeout(() => {
      signal.aborted = true;
      for (const l of listeners) l();
    }, 4_000);
    const { out, ms } = await run(new Holder(), ctrl, request({ signal }));
    expect(out).toMatchObject({ held: true, by: "abort", decision: "none" });
    expect(ms).toBeLessThan(4_100);
    await drain();
    expect(ctrl.resolvedBodies()).toEqual([{ by: "abort", decision: "none" }]);
  });

  it("ya cancelado antes de empezar: ni se anuncia", async () => {
    const ctrl = new FakeController();
    const { out } = await run(new Holder(), ctrl, request({ signal: { aborted: true } }));
    expect(out.held).toBe(false);
    expect(ctrl.calls).toEqual([]);
  });

  it("controlador caído: veredicto original al instante, sin /resolved", async () => {
    const ctrl = new FakeController();
    ctrl.mode = "down";
    const { out, ms } = await run(new Holder(), ctrl, request());
    expect(out).toMatchObject({ held: false });
    expect(ms).toBeLessThan(100);
    await drain();
    expect(ctrl.resolvedBodies()).toEqual([]);
  });

  it("controlador colgado (acepta y no contesta): veredicto original a los 3 s", async () => {
    const ctrl = new FakeController();
    ctrl.mode = "hang";
    const { out, ms } = await run(new Holder(), ctrl, request());
    expect(out).toMatchObject({ held: false, why: expect.stringContaining("no contestó") });
    expect(ms).toBeGreaterThanOrEqual(3_000);
    expect(ms).toBeLessThan(3_100);
  });

  it("controlador que se cuelga a mitad del long-poll: el plazo exp manda igual", async () => {
    const ctrl = new FakeController();
    ctrl.onApproval = () => {
      ctrl.mode = "hang";
    };
    const { out, ms } = await run(new Holder(), ctrl, request({ holdMs: 10_000 }));
    expect(out).toMatchObject({ held: true, by: "timeout" });
    expect(ms).toBeLessThan(10_100);
  });

  it("POST con respuesta rara (409, 500): no se retiene", async () => {
    for (const status of [409, 500, 401]) {
      const ctrl = new FakeController();
      ctrl.postStatus = status;
      const { out, ms } = await run(new Holder(), ctrl, request());
      expect(out).toEqual({ held: false, why: `el controlador respondió ${status}` });
      expect(ms).toBeLessThan(100);
    }
  });

  it("404/410 del long-poll: el controlador lo olvidó, se deja de esperar", async () => {
    const ctrl = new FakeController();
    ctrl.onApproval = (body) => setTimeout(() => (ctrl.approvals.get(body.id)!.gone = true), 2_000);
    const { out, ms } = await run(new Holder(), ctrl, request());
    expect(out).toMatchObject({ held: true, by: "error" });
    expect(ms).toBeLessThan(10_000);
    await drain();
    expect(ctrl.resolvedBodies()).toEqual([]);
  });

  it("forbidden: un allow válido con wok false se descarta; un deny vale", async () => {
    const ctrl = new FakeController();
    ctrl.onApproval = (body) => {
      ctrl.queue(body.id, decide(A, body, "allow"));
      setTimeout(() => ctrl.queue(body.id, decide(A, body, "deny")), 2_000);
    };
    const { out } = await run(new Holder(), ctrl, request({ wok: false, summary: "rm -rf build" }));
    expect(out).toEqual({ held: true, by: "remote", decision: "deny", reject: "forbidden", rejected: 1 });
  });

  it("replay: la decisión de un permiso anterior no sirve para uno nuevo de la misma tool", async () => {
    const ctrl = new FakeController();
    const holder = new Holder();
    let first: Record<string, unknown> | undefined;
    ctrl.onApproval = (body) => {
      first ??= decide(A, body, "allow");
      ctrl.queue(body.id, first);
    };
    expect((await run(holder, ctrl, request({ holdMs: 5_000 }))).out).toMatchObject({ by: "remote", decision: "allow" });
    // El controlador repite la decisión capturada para el siguiente permiso (mismo tool_use_id, otro id).
    const { out } = await run(holder, ctrl, request({ holdMs: 5_000 }));
    expect(out).toMatchObject({ by: "timeout", reject: "sig", rejected: 1 });
  });

  it("la misma decisión inválida repetida en cada long-poll cuenta una vez", async () => {
    const ctrl = new FakeController();
    ctrl.sticky = true;
    ctrl.onApproval = (body) => ctrl.queue(body.id, decide(B, body, "allow"));
    const { out } = await run(new Holder(), ctrl, request({ holdMs: 5_000 }));
    expect(out).toMatchObject({ by: "timeout", reject: "kid", rejected: 1 });
    // No gira en vacío: con la pausa entre vueltas, unas pocas decenas de peticiones en 5 s.
    expect(ctrl.calls.filter((c) => c.method === "GET").length).toBeLessThan(15);
  });

  it("una llave revocada a mitad de la espera deja de contar desde la siguiente decisión", async () => {
    const ctrl = new FakeController();
    let keys = [A.paired];
    ctrl.onApproval = (body) => setTimeout(() => {
      keys = [];
      ctrl.queue(body.id, decide(A, body, "allow"));
    }, 1_000);
    const { out } = await run(new Holder(), ctrl, request({ holdMs: 5_000, keys: async () => keys }));
    expect(out).toMatchObject({ by: "timeout", reject: "kid" });
  });

  it("/resolved que falla se reintenta en segundo plano sin retrasar la respuesta", async () => {
    const ctrl = new FakeController();
    let fails = 2;
    let tries = 0;
    const orig = ctrl.fetch;
    ctrl.fetch = async (url, init) => {
      if (url.endsWith("/resolved")) {
        tries++;
        if (fails-- > 0) return { status: 503, ok: false, text: "" };
      }
      return orig(url, init);
    };
    ctrl.onApproval = (body) => ctrl.queue(body.id, decide(A, body, "allow"));
    const { ms } = await run(new Holder(), ctrl, request());
    expect(ms).toBeLessThan(1_000);
    await drain(10_000);
    expect(tries).toBe(3);
    expect(ctrl.approvals.values().next().value!.resolved).toEqual({ by: "remote", decision: "allow" });
  });

  it("dos permisos a la vez del mismo tool_use_id: el segundo no se retiene", async () => {
    const ctrl = new FakeController();
    const holder = new Holder();
    const io = fakeIo(ctrl);
    const a = holder.hold(request({ holdMs: 3_000 }), { url: ctrl.base }, io);
    const b = await holder.hold(request({ holdMs: 3_000 }), { url: ctrl.base }, io);
    expect(b).toEqual({ held: false, why: "ya retenido" });
    await drain(4_000);
    expect(await a).toMatchObject({ by: "timeout" });
  });

  it("sin token no manda Authorization", async () => {
    const ctrl = new FakeController();
    void new Holder().hold(request({ holdMs: 1_000 }), { url: ctrl.base }, fakeIo(ctrl));
    await drain(2_000);
    expect(ctrl.calls[0]!.headers.authorization).toBeUndefined();
  });
});
