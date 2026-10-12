/** NodEngine sobre una Platform falsa: lo que verá cualquier adaptador, y los comandos /nod. */
import { describe, expect, it } from "vitest";
import { NodEngine } from "../src/core/engine.js";
import type { NodEnv } from "../src/core/config.js";
import type { Envelope } from "../src/core/events.js";
import type { Platform } from "../src/core/platform.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function fake(env: NodEnv = { HOME: "/h" }, store = new Map<string, unknown>()) {
  const files = new Map<string, string>();
  let t = 1_800_000_000_000;
  const p: Platform = {
    info: async () => ({ host: "test", profile: "p", machine: "m" }),
    env: async () => env,
    now: async () => t,
    after: (_ms, cb) => {
      const h = setTimeout(cb, 0);
      return { cancel: () => clearTimeout(h) };
    },
    fetch: async () => ({ status: 200, ok: true, text: "" }),
    store: { get: async (k) => store.get(k), set: async (k, v) => void (v === null ? store.delete(k) : store.set(k, v)) },
    read: async () => {
      throw new Error("ENOENT");
    },
    append: async (path, text) => void files.set(path, (files.get(path) ?? "") + text),
    log: () => undefined,
  };
  const envelopes = () => [...files.values()].flatMap((s) => s.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Envelope));
  return { p, store, files, envelopes, advance: (ms: number) => (t += ms) };
}

async function settle() {
  for (let i = 0; i < 10; i++) await tick();
}

describe("/nod", () => {
  it("tarea: los eventos siguientes la llevan y task.set queda registrado", async () => {
    const f = fake();
    const nod = new NodEngine();
    await nod.sessionStart(f.p, "s1", { interactive: true });
    expect(await nod.runCommand(f.p, "s1", "tarea ABC-12 Arreglar el login")).toContain("tarea: ABC-12 (Arreglar el login)");
    await nod.turnStart(f.p, "s1", "t1");
    await nod.sessionEnd(f.p, "s1", "exit");
    await settle();
    const evs = f.envelopes().flatMap((e) => e.events);
    expect(evs.find((e) => e.type === "task.set")!.data).toEqual({ task: "ABC-12", title: "Arreglar el login", source: "command" });
    expect(evs.find((e) => e.type === "turn.start")!.task).toBe("ABC-12");
    expect(await nod.runCommand(f.p, "s1", "tarea fin")).toContain("tarea cerrada");
  });

  it("NOD_TASK fija la tarea desde el inicio", async () => {
    const f = fake({ HOME: "/h", NOD_TASK: "XY-1" });
    const nod = new NodEngine();
    await nod.sessionStart(f.p, "s1", {});
    await nod.sessionEnd(f.p, "s1", "exit");
    await settle();
    const evs = f.envelopes().flatMap((e) => e.events);
    expect(evs.map((e) => e.type)).toEqual(["session.start", "task.set", "session.end"]);
    expect(evs[2]!.task).toBe("XY-1");
  });

  it("privacidad: se guarda por perfil y vale en la siguiente sesión", async () => {
    const store = new Map<string, unknown>();
    const a = fake({ HOME: "/h" }, store);
    expect(await new NodEngine().runCommand(a.p, "s", "privacidad redactado")).toContain("privacidad en este perfil: redactado");
    const b = fake({ HOME: "/h" }, store);
    const nod = new NodEngine();
    await nod.promptSubmit(b.p, "s2", "secreto", "composer");
    await nod.sessionEnd(b.p, "s2", "exit");
    await settle();
    expect(JSON.stringify(b.envelopes())).not.toContain("secreto");
    expect(await nod.runCommand(b.p, "s", "privacidad total")).toContain('"total" no existe');
  });

  it("NOD_PRIVACY manda sobre /nod privacidad", async () => {
    const f = fake({ HOME: "/h", NOD_PRIVACY: "trabajo" });
    expect(await new NodEngine().runCommand(f.p, "s", "privacidad completo")).toContain("NOD_PRIVACY=trabajo manda");
  });

  it("pausa: guarda en cola sin entregar; reanuda entrega", async () => {
    const f = fake();
    const nod = new NodEngine();
    expect(await nod.runCommand(f.p, "s", "pausa")).toContain("en pausa");
    await nod.sessionStart(f.p, "s", {});
    await nod.turnStart(f.p, "s", "t");
    await settle();
    expect(f.files.size).toBe(0);
    expect(await nod.runCommand(f.p, "s", "")).toContain("en cola 2");
    await nod.runCommand(f.p, "s", "reanuda");
    f.advance(1000);
    await settle();
    expect(f.envelopes().flatMap((e) => e.events).map((e) => e.type)).toEqual(["session.start", "turn.start"]);
  });

  it("NOD_OFF=1: no emite nada y /nod lo dice", async () => {
    const f = fake({ HOME: "/h", NOD_OFF: "1" });
    const nod = new NodEngine();
    await nod.sessionStart(f.p, "s", {});
    await nod.sessionEnd(f.p, "s", "exit");
    await settle();
    expect(f.files.size).toBe(0);
    expect(await nod.runCommand(f.p, "s", "")).toContain("desactivado");
  });

  it("argumentos desconocidos devuelven el uso; ayuda explica", async () => {
    const f = fake();
    const nod = new NodEngine();
    expect(await nod.runCommand(f.p, "s", "bailar")).toContain("uso: /nod");
    expect(await nod.runCommand(f.p, "s", "ayuda")).toContain("Nod observa tus sesiones");
  });
});

describe("robustez y privacidad del motor", () => {
  it("/clear: la sesión nueva abre con session.start (continued) y no hereda lo anterior", async () => {
    const f = fake();
    const nod = new NodEngine();
    await nod.sessionStart(f.p, "S1", { interactive: true });
    await nod.promptSubmit(f.p, "S1", "uno", "composer");
    f.advance(60_000);
    await nod.sessionEnd(f.p, "S1", "clear");
    f.advance(1_000);
    await nod.promptSubmit(f.p, "S2", "dos", "composer");
    f.advance(1_000);
    await nod.sessionEnd(f.p, "S2", "exit");
    await settle();
    const evs = f.envelopes().flatMap((e) => e.events).map((e) => [e.type, e.session, e.data.continued ?? e.data.duration_ms ?? e.data.text]);
    expect(evs).toEqual([
      ["session.start", "S1", undefined],
      ["prompt.submit", "S1", "uno"],
      ["session.end", "S1", 60_000],
      ["session.start", "S2", true],
      ["prompt.submit", "S2", "dos"],
      ["session.end", "S2", 1_000],
    ]);
  });

  it("la privacidad guardada no relaja la del fichero; /nod privacidad no puede relajarla", async () => {
    const store = new Map<string, unknown>([["nod.privacy", "completo"]]);
    const f = fake({ HOME: "/h" }, store);
    f.p.read = async () => JSON.stringify({ privacy: "trabajo" });
    const nod = new NodEngine();
    await nod.promptSubmit(f.p, "s", "texto del cliente", "composer");
    await nod.sessionEnd(f.p, "s", "exit");
    await settle();
    expect(JSON.stringify(f.envelopes())).not.toContain("texto del cliente");
    expect(f.envelopes()[0]!.source.privacy).toBe("trabajo");
    expect(await nod.runCommand(f.p, "s", "privacidad completo")).toContain("solo puede endurecerla");
  });

  it("pasar a trabajo con eventos en cola: nada sale al destino remoto", async () => {
    const posts: string[] = [];
    const f = fake({ HOME: "/h", NOD_SINKS: "https://collector.example.com" });
    f.p.fetch = async (_u, init) => {
      posts.push(init.body);
      return { status: 200, ok: true, text: "" };
    };
    const nod = new NodEngine();
    await nod.runCommand(f.p, "s", "pausa");
    await nod.promptSubmit(f.p, "s", "password hunter2", "composer");
    expect(await nod.runCommand(f.p, "s", "privacidad trabajo")).toContain("no se entregará a");
    await nod.runCommand(f.p, "s", "reanuda");
    await nod.sessionEnd(f.p, "s", "exit");
    f.advance(5_000);
    await settle();
    expect(posts).toEqual([]);
  });

  it("la cola de una sesión anterior en completo no sale tras arrancar en trabajo", async () => {
    const store = new Map<string, unknown>();
    const posts: string[] = [];
    const a = fake({ HOME: "/h", NOD_SINKS: "https://collector.example.com" }, store);
    a.p.fetch = async () => ({ status: 503, ok: false, text: "" });
    const first = new NodEngine();
    await first.promptSubmit(a.p, "s1", "ACME secreto", "composer");
    await first.sessionEnd(a.p, "s1", "exit");
    await settle();
    const b = fake({ HOME: "/h", NOD_SINKS: "https://collector.example.com", NOD_PRIVACY: "trabajo" }, store);
    b.p.fetch = async (_u, init) => {
      posts.push(init.body);
      return { status: 200, ok: true, text: "" };
    };
    b.advance(60 * 60_000);
    const second = new NodEngine();
    await second.sessionStart(b.p, "s2", {});
    await second.sessionEnd(b.p, "s2", "exit");
    await settle();
    expect(posts.join()).not.toContain("ACME secreto");
    expect(posts).toEqual([]);
  });

  it("un destino que acepta y no contesta no retrasa el cierre más de 3 s", async () => {
    const f = fake({ HOME: "/h", NOD_SINKS: "https://colgado.example.com" });
    f.p.fetch = () => new Promise(() => undefined);
    const nod = new NodEngine();
    await nod.sessionStart(f.p, "s", {});
    let done = false;
    const closing = nod.sessionEnd(f.p, "s", "exit").then(() => (done = true));
    await settle();
    expect(done).toBe(true); // el temporizador falso del arnés vence enseguida: lo que importa es que vence
    await closing;
  });
});
