/**
 * Nod Control a través del motor (lo que verá cualquier adaptador): cuándo se retiene, qué se emite con cada
 * desenlace, los mensajes a mitad de turno, y los comandos /nod emparejar, aprobadores, lejos y cerca.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodEngine } from "../src/core/engine.js";
import type { NodEnv } from "../src/core/config.js";
import { b64u, fromB64u, fromHex } from "../src/core/control/crypto.js";
import { CONTEXT_PREFIX, RECAP_PROMPT } from "../src/core/control/messages.js";
import type { Envelope, NodEvent } from "../src/core/events.js";
import type { Platform } from "../src/core/platform.js";
import { FakeController, approver, decide, message, offer } from "./support/control.js";

const A = approver("nod-engine-aprobador");
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const STATE = "/estado/nod";
const LOG = "/eventos.jsonl";
const CTL = "http://127.0.0.1:7878";
const TEST_KEY = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../vectors/control/key.json"), "utf8")).keys[0];

const approversFile = (keys: { spki: Uint8Array; kid: Uint8Array }[]) =>
  JSON.stringify({ v: 1, keys: keys.map((k) => ({ kid: b64u(k.kid), spki: b64u(k.spki), added_ms: T0, name: "móvil" })) });

function fake(env: Partial<NodEnv> = {}, opts: { paired?: boolean } = {}) {
  const ctrl = new FakeController(CTL);
  const files = new Map<string, string>();
  if (opts.paired !== false) files.set(`${STATE}/approvers.json`, approversFile([A]));
  const aborted: string[] = [];
  const prompts: string[] = [];
  const statuses: (string | undefined)[] = [];
  const toasts: string[] = [];
  const logs: string[] = [];
  let r = 0;
  const p: Platform = {
    info: async () => ({ host: "test", profile: "p" }),
    env: async () => ({ HOME: "/h", XDG_STATE_HOME: "/estado", NOD_SINKS: LOG, NOD_INSTANCE: "personal-3fa9c2d1", NOD_CONTROL: CTL, ...env }),
    now: async () => Date.now(),
    after: (ms, cb) => {
      const h = setTimeout(cb, ms);
      return { cancel: () => clearTimeout(h) };
    },
    fetch: (url, init) => ctrl.fetch(url, init),
    store: { get: async () => undefined, set: async () => undefined },
    read: async (path) => {
      const t = files.get(path);
      if (t === undefined) throw new Error(`ENOENT ${path}`);
      return t;
    },
    append: async (path, text) => void files.set(path, (files.get(path) ?? "") + text),
    write: async (path, text) => void files.set(path, text),
    random: async (n) => Uint8Array.from({ length: n }, (_, i) => (i === 0 ? ++r : 0x20 + i)),
    log: (m) => void logs.push(m),
    status: (t) => void statuses.push(t),
    toast: (t) => void toasts.push(t),
    session: {
      abortTurn: async (turn) => void aborted.push(turn),
      submitPrompt: async (text) => void prompts.push(text),
    },
  };
  const events = (): NodEvent[] =>
    (files.get(LOG) ?? "").split("\n").filter(Boolean).flatMap((l) => (JSON.parse(l) as Envelope).events);
  return { p, ctrl, files, aborted, prompts, statuses, toasts, logs, events };
}

type F = ReturnType<typeof fake>;

/** Un permiso preguntado por el agente, como lo pasa el adaptador: request emitido y luego la retención. */
async function ask(nod: NodEngine, f: F, mode: string | undefined = "default", id = "toolu_1", input: unknown = { command: "touch x" }) {
  void nod.toolCall(f.p, "s1", { toolUseId: id, tool: "Bash", input });
  void nod.toolCheck(f.p, "s1", id, "Bash", "ask", "needs approval", 3);
  let modeAsked = false;
  const out = nod.checkPermission(f.p, "s1", { toolUseId: id, tool: "Bash", input }, undefined, async () => {
    modeAsked = true;
    return mode;
  });
  return { out, modeAsked: () => modeAsked };
}

async function until<T>(p: Promise<T>, ms = 120_000): Promise<T> {
  let done = false;
  let v: T;
  void p.then((x) => {
    done = true;
    v = x;
  });
  for (let t = 0; t < ms && !done; t += 50) await vi.advanceTimersByTimeAsync(50);
  if (!done) throw new Error("no terminó");
  return v!;
}

const flush = async (ms = 4_000) => {
  for (let t = 0; t < ms; t += 100) await vi.advanceTimersByTimeAsync(100);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe("permisos", () => {
  it("allow remoto: el hook recibe allow y sale permission.decision by remote (y no by user)", async () => {
    const f = fake();
    const nod = new NodEngine();
    await nod.sessionStart(f.p, "s1", { interactive: true });
    f.ctrl.onApproval = (body) => setTimeout(() => f.ctrl.queue(body.id, decide(A, body, "allow")), 2_000);
    await nod.turnStart(f.p, "s1", "t1");
    const { out } = await ask(nod, f);
    expect(await until(out)).toBe("allow");
    await nod.toolResult(f.p, "s1", { toolUseId: "toolu_1", tool: "Bash", ok: true, rejected: false, outputChars: 0 });
    await nod.sessionEnd(f.p, "s1", "exit");
    await flush();
    const evs = f.events().filter((e) => e.type.startsWith("permission."));
    expect(evs.map((e) => [e.type, e.data.by])).toEqual([["permission.request", undefined], ["permission.decision", "remote"]]);
    expect(evs[1]!.data).toMatchObject({ tool_use_id: "toolu_1", decision: "allow", exact: true });
    expect(evs[1]!.data.wait_ms).toBeGreaterThanOrEqual(2_000);
    expect(evs[1]!.data.wait_ms).toBeLessThan(3_000);
    expect(f.ctrl.approvals.values().next().value!.body).toMatchObject({ instance: "personal-3fa9c2d1", session: "s1", summary: "touch x", wok: true });
  });

  it("deny remoto → deny", async () => {
    const f = fake();
    const nod = new NodEngine();
    await nod.sessionStart(f.p, "s1", {});
    f.ctrl.onApproval = (body) => f.ctrl.queue(body.id, decide(A, body, "deny"));
    expect(await until((await ask(nod, f)).out)).toBe("deny");
  });

  it("plazo vencido: veredicto original (undefined) y el humano decide después como siempre", async () => {
    const f = fake();
    const nod = new NodEngine();
    await nod.sessionStart(f.p, "s1", {});
    await nod.turnStart(f.p, "s1", "t1");
    const started = Date.now();
    expect(await until((await ask(nod, f)).out)).toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(20_000);
    await nod.toolResult(f.p, "s1", { toolUseId: "toolu_1", tool: "Bash", ok: true, rejected: false, outputChars: 0 });
    await flush();
    const dec = f.events().find((e) => e.type === "permission.decision")!;
    expect(dec.data).toMatchObject({ by: "user", decision: "allow" });
  });

  it("auto mode: no se retiene ni se anuncia", async () => {
    const f = fake();
    const nod = new NodEngine();
    await nod.sessionStart(f.p, "s1", {});
    const a = await ask(nod, f, "auto");
    expect(await until(a.out)).toBeUndefined();
    expect(a.modeAsked()).toBe(true);
    expect(f.ctrl.calls.filter((c) => c.url.includes("/approvals"))).toEqual([]);
  });

  it("modo desconocido: se retiene", async () => {
    const f = fake();
    const nod = new NodEngine();
    await nod.sessionStart(f.p, "s1", {});
    f.ctrl.onApproval = (body) => f.ctrl.queue(body.id, decide(A, body, "allow"));
    expect(await until((await ask(nod, f, undefined)).out)).toBe("allow");
  });

  it("sin llaves emparejadas, o solo la de prueba: no se retiene", async () => {
    for (const files of [undefined, approversFile([{ spki: fromHex(TEST_KEY.spki), kid: fromHex(TEST_KEY.kid) }])]) {
      const f = fake({}, { paired: false });
      if (files) f.files.set(`${STATE}/approvers.json`, files);
      const nod = new NodEngine();
      await nod.sessionStart(f.p, "s1", {});
      expect(await until((await ask(nod, f)).out)).toBeUndefined();
      expect(f.ctrl.calls.filter((c) => c.url.includes("/approvals"))).toEqual([]);
    }
  });

  it("sin canal (no configurado, o trabajo con controlador remoto): ni se pregunta el modo", async () => {
    for (const env of [{ NOD_CONTROL: undefined }, { NOD_CONTROL: "https://ctl.example", NOD_PRIVACY: "trabajo" }]) {
      const f = fake(env);
      const nod = new NodEngine();
      await nod.sessionStart(f.p, "s1", {});
      const a = await ask(nod, f);
      expect(await until(a.out)).toBeUndefined();
      expect(a.modeAsked()).toBe(false);
      expect(f.ctrl.calls).toEqual([]);
    }
  });

  it("controlador caído: veredicto original enseguida", async () => {
    const f = fake();
    f.ctrl.mode = "down";
    const nod = new NodEngine();
    await nod.sessionStart(f.p, "s1", {});
    const started = Date.now();
    expect(await until((await ask(nod, f)).out)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("redactado: el aprobador ve solo el verbo; rm -rf va con wok false", async () => {
    const f = fake({ NOD_PRIVACY: "redactado" });
    const nod = new NodEngine();
    await nod.sessionStart(f.p, "s1", {});
    f.ctrl.onApproval = (body) => f.ctrl.queue(body.id, decide(A, body, "deny"));
    await until((await ask(nod, f, "default", "toolu_1", { command: "rm -rf /clientes/acme" })).out);
    expect(f.ctrl.approvals.values().next().value!.body).toMatchObject({ summary: "rm", wok: false, tool: "Bash" });
  });
});

describe("mensajes", () => {
  async function started(f: F) {
    const nod = new NodEngine();
    await nod.sessionStart(f.p, "s1", {});
    await vi.advanceTimersByTimeAsync(10);
    return nod;
  }
  const send = async (f: F, kind: string, text = "") => {
    f.ctrl.messages.push(message(A, "personal-3fa9c2d1", "s1", kind, text, Math.floor(Date.now() / 1000)));
    await vi.advanceTimersByTimeAsync(200);
  };

  it("text a mitad de turno: contexto del siguiente resultado de tool de la sesión principal, no de un subagente", async () => {
    const f = fake();
    const nod = await started(f);
    await nod.turnStart(f.p, "s1", "t1");
    await send(f, "text", "usa pnpm");
    expect(nod.takeNote("subagente")).toBeUndefined();
    expect(nod.takeNote(undefined)).toBe(`${CONTEXT_PREFIX}usa pnpm`);
    expect(nod.takeNote(undefined)).toBeUndefined();
    expect(f.prompts).toEqual([]);
  });

  it("text que no alcanzó a salir: prompt al acabar el turno; con el agente libre, prompt ya", async () => {
    const f = fake();
    const nod = await started(f);
    await nod.turnStart(f.p, "s1", "t1");
    await send(f, "text", "y añade tests");
    await nod.turnEnd(f.p, "s1", { turn: "t1", outcome: "answer" });
    expect(f.prompts).toEqual(["y añade tests"]);
    await send(f, "text", "otra cosa");
    expect(f.prompts).toEqual(["y añade tests", "otra cosa"]);
  });

  it("stop corta el turno en curso; sin turno no hace nada", async () => {
    const f = fake();
    const nod = await started(f);
    await send(f, "stop");
    expect(f.aborted).toEqual([]);
    await nod.turnStart(f.p, "s1", "t7");
    await send(f, "stop", "esto no es un prompt");
    expect(f.aborted).toEqual(["t7"]);
    await nod.turnEnd(f.p, "s1", { turn: "t7", outcome: "aborted" });
    expect(f.prompts).toEqual([]);
  });

  it("recap a mitad de turno: corta y, al terminar, pide el resumen", async () => {
    const f = fake();
    const nod = await started(f);
    await nod.turnStart(f.p, "s1", "t2");
    await send(f, "recap");
    expect(f.aborted).toEqual(["t2"]);
    expect(f.prompts).toEqual([]);
    await nod.turnEnd(f.p, "s1", { turn: "t2", outcome: "aborted" });
    expect(f.prompts).toEqual([RECAP_PROMPT]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.prompts).toEqual([RECAP_PROMPT]);
  });

  it("recap si el turno cortado no llega a cerrarse: el resumen sale igual a los 3 s", async () => {
    const f = fake();
    const nod = await started(f);
    await nod.turnStart(f.p, "s1", "t3");
    await send(f, "recap", "resume solo los tests");
    await vi.advanceTimersByTimeAsync(3_500);
    expect(f.prompts).toEqual(["resume solo los tests"]);
  });

  it("al cerrar la sesión el bucle para", async () => {
    const f = fake();
    const nod = await started(f);
    await nod.sessionEnd(f.p, "s1", "exit");
    await vi.advanceTimersByTimeAsync(30_000);
    const n = f.ctrl.calls.filter((c) => c.url.includes("/messages")).length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.ctrl.calls.filter((c) => c.url.includes("/messages")).length).toBe(n);
  });
});

describe("/nod", () => {
  it("emparejar: QR, K en pairing.json, oferta del aprobador → llave emparejada en approvers.json", async () => {
    const f = fake({}, { paired: false });
    const nod = new NodEngine();
    await nod.sessionStart(f.p, "s1", {});
    const text = await nod.runCommand(f.p, "s1", "emparejar");
    expect(text).toContain("Empareja un aprobador con http://127.0.0.1:7878 (prueba)");
    expect(text).toMatch(/[█▀▄]{20,}/);
    const pairing = JSON.parse(f.files.get(`${STATE}/pairing.json`)!);
    expect(pairing.keys).toHaveLength(1);
    expect(pairing.keys[0]).toMatchObject({ instance: "personal-3fa9c2d1", expires_ms: T0 + 15 * 60_000 });
    const k = fromB64u(pairing.keys[0].k);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(f.statuses.at(-1)).toMatch(/escanea el QR.*\(11\d s\)/);
    f.ctrl.offers = [offer(A, k, "personal-3fa9c2d1", "o1", "Pixel")];
    await vi.advanceTimersByTimeAsync(2_100);
    expect(JSON.parse(f.files.get(`${STATE}/approvers.json`)!).keys.map((e: any) => e.kid)).toEqual([b64u(A.kid)]);
    expect(JSON.parse(f.files.get(`${STATE}/pairing.json`)!).keys).toEqual([]);
    expect(f.statuses.at(-1)).toBeUndefined();
    expect(f.toasts.at(-1)).toContain("Pixel");
    expect(await nod.runCommand(f.p, "s1", "aprobadores")).toContain(`${b64u(A.kid)}  Pixel`);
  });

  it("emparejar sin oferta: a los 2 min deja de buscar y lo dice", async () => {
    const f = fake({}, { paired: false });
    const nod = new NodEngine();
    await nod.runCommand(f.p, "s1", "emparejar");
    await vi.advanceTimersByTimeAsync(125_000);
    expect(f.statuses.at(-1)).toBeUndefined();
    expect(f.toasts.at(-1)).toContain("no llegó la oferta");
    const n = f.ctrl.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.ctrl.calls.length).toBe(n);
  });

  it("emparejar sin canal o con un controlador sin {k}: explica por qué", async () => {
    expect(await new NodEngine().runCommand(fake({ NOD_CONTROL: undefined }).p, "s1", "emparejar")).toContain("no está activo (sin configurar)");
    const f = fake();
    f.ctrl.info = { pair_url: "https://x/pair?i={instance}" };
    expect(await new NodEngine().runCommand(f.p, "s1", "emparejar")).toContain("no lleva {k}");
    expect(f.files.has(`${STATE}/pairing.json`)).toBe(false);
  });

  it("aprobadores quitar: la llave deja de contar desde la siguiente decisión", async () => {
    const f = fake();
    const nod = new NodEngine();
    await nod.sessionStart(f.p, "s1", {});
    expect(await nod.runCommand(f.p, "s1", `aprobadores quitar ${b64u(A.kid)}`)).toContain("revocado");
    expect(JSON.parse(f.files.get(`${STATE}/approvers.json`)!).keys).toEqual([]);
    expect(await until((await ask(nod, f)).out)).toBeUndefined();
    expect(await nod.runCommand(f.p, "s1", "aprobadores quitar nada")).toContain("no hay ningún aprobador");
  });

  it("lejos: 90 s en toda la máquina (away.json); cerca: vuelve a hold_ms", async () => {
    const f = fake();
    const nod = new NodEngine();
    await nod.sessionStart(f.p, "s1", {});
    expect(await nod.runCommand(f.p, "s1", "lejos")).toContain("espera 90 s");
    expect(JSON.parse(f.files.get(`${STATE}/away.json`)!)).toMatchObject({ v: 1, away: true });
    // Otra sesión (otro motor, otro perfil) de la misma máquina también espera 90 s.
    const other = new NodEngine();
    f.ctrl.onApproval = (body) => f.ctrl.queue(body.id, decide(A, body, "deny"));
    await until((await ask(other, f)).out);
    const exp = [...f.ctrl.approvals.values()][0]!.body.exp;
    expect(exp).toBe(Math.floor((Date.now() + 90_000) / 1000));
    expect(await nod.runCommand(f.p, "s1", "cerca")).toContain("espera 20 s");
    expect(JSON.parse(f.files.get(`${STATE}/away.json`)!).away).toBe(false);
  });

  it("estado: controlador, llaves y retención", async () => {
    const f = fake();
    const nod = new NodEngine();
    await nod.sessionStart(f.p, "s1", {});
    const s = await nod.runCommand(f.p, "s1", "");
    expect(s).toContain("control: http://127.0.0.1:7878");
    expect(s).toContain("aprobadores: móvil");
    expect(s).toContain("retención: 20 s (cerca: /nod lejos)");
    const off = await new NodEngine().runCommand(fake({ NOD_CONTROL: "https://ctl.example", NOD_PRIVACY: "trabajo" }).p, "s1", "");
    expect(off).toContain("control: https://ctl.example (desactivado: privacidad trabajo y el controlador no es local)");
    expect(await new NodEngine().runCommand(fake({ NOD_CONTROL: undefined }).p, "s1", "")).toContain("control: sin configurar");
  });
});
