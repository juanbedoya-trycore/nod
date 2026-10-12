/**
 * Sesiones reales de OpenCode 1.18.34 capturadas con tools/probe-opencode y reproducidas por el adaptador:
 *
 *  - TUI: un prompt que lanza un subagente `explore` (glob) y pide un `wc -l` que el humano aprueba tras ~9 s;
 *    /nod; un `date` que el humano niega; un `sleep 30` aprobado e interrumpido con Esc; /exit.
 *  - `opencode run`: un read y un `ls` que `run` rechaza solo (sin --auto).
 *
 * Lo que sale debe ser Nod v1 válido y contar la sesión tal como fue. Las salidas de las tools están recortadas
 * por la sonda (600 caracteres): `output_chars` es el de la captura, no el de la sesión.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { b64u } from "../src/core/control/crypto.js";
import type { NodEvent, Usage } from "../src/core/events.js";
import { profileOf, runModeOf } from "../src/hosts/opencode/node.js";
import { FakeController, approver, decide } from "./support/control.js";
import { replayOpencode } from "./support/opencode.js";
import type { OpencodeReplayOptions } from "./support/opencode.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TUI = join(HERE, "fixtures/opencode-1.18.34-tui.jsonl");
const RUN = join(HERE, "fixtures/opencode-1.18.34-run.jsonl");
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(JSON.parse(readFileSync(join(HERE, "../schema/nod-v1.schema.json"), "utf8")));
const LOG = "/Users/dev/.local/state/nod/events.jsonl";
const REPO = { root: "/Users/dev/proyecto", branch: "feature/NOD-42-prueba" };
const SESSION = "ses_ecdc1a141ffeyRWn0FDRIJ1yD0";
const SUBAGENT = "ses_ecdc18e49ffenp0EgoCUqWFabw";

const events = (envs: { events: NodEvent[] }[]) => envs.flatMap((e) => e.events);
const ofType = (evs: NodEvent[], t: string) => evs.filter((e) => e.type === t);
const sum = (us: Usage[]) => us.reduce((a, u) => ({ input: a.input + u.input, output: a.output + u.output, cache_read: a.cache_read + u.cache_read, cache_write: a.cache_write + u.cache_write }), { input: 0, output: 0, cache_read: 0, cache_write: 0 });
const tokens = (u: unknown) => {
  const { model: _m, ...rest } = u as Usage;
  return rest;
};

describe("sesión real en la TUI (opencode 1.18.34)", async () => {
  const r = await replayOpencode(TUI, { repo: REPO });
  const evs = events(r.envelopes);

  it("sin configuración escribe Nod v1 válido en el fichero por defecto, con host opencode y su versión", () => {
    expect([...r.files.keys()]).toEqual([LOG]);
    for (const env of r.envelopes) expect(validate(env), JSON.stringify(validate.errors)).toBe(true);
    expect(r.envelopes[0]!.source).toMatchObject({ host: "opencode", host_version: "1.18.34", profile: "opencode", machine: "mbp", privacy: "completo" });
    expect(r.envelopes[0]!.source.instance).toMatch(/^opencode-[0-9a-f]{8}$/);
    expect(r.logs.filter((l) => l.includes("falló"))).toEqual([]);
  });

  it("seq empieza en 1, crece de uno en uno y todo es de la misma sesión", () => {
    expect(evs.map((e) => e.seq)).toEqual(evs.map((_, i) => i + 1));
    expect(new Set(evs.map((e) => e.session))).toEqual(new Set([SESSION]));
  });

  it("la sesión empieza con el modelo, el repo y la tarea de la rama, y termina con /exit", () => {
    expect(evs[0]!.type).toBe("session.start");
    expect(evs[0]!.data).toMatchObject({ interactive: true, surface: "terminal", model: "MiniMax-M2.7", cwd: "/Users/dev/proyecto", repo: REPO });
    expect(evs[1]!).toMatchObject({ type: "task.set", data: { task: "NOD-42", source: "branch" } });
    expect(evs.at(-1)!).toMatchObject({ type: "session.end", data: { reason: "exit" } });
    expect(Number(evs.at(-1)!.data.duration_ms)).toBeGreaterThan(90_000);
  });

  it("cuatro prompts: tres del humano y el de /nod", () => {
    expect(ofType(evs, "prompt.submit").map((e) => e.data.origin)).toEqual(["composer", "command", "composer", "composer"]);
    expect(ofType(evs, "prompt.submit")[2]!.data.text).toBe("Ejecuta 'date' con bash.");
    expect(ofType(evs, "turn.start").length).toBe(4);
  });

  it("los tres permisos los decidió el humano, con la espera exacta que da permission.replied", () => {
    expect(ofType(evs, "permission.request").map((e) => e.data.tool)).toEqual(["bash", "bash", "bash"]);
    const d = ofType(evs, "permission.decision");
    expect(d.map((e) => [e.data.decision, e.data.by, e.data.wait_ms, e.data.exact])).toEqual([
      ["allow", "user", 8_807, true],
      ["deny", "user", 4_508, true],
      ["allow", "user", 1_252, true],
    ]);
    // La ejecución empieza al aprobar: no cuenta la espera.
    const results = ofType(evs, "tool.result").filter((e) => e.data.tool === "bash");
    expect(results.map((e) => [e.data.ok, e.data.rejected, e.data.duration_ms])).toEqual([[true, false, 22], [false, true, 0], [true, false, 5_571]]);
  });

  it("el subagente explore: spawn desde la tool task, sus pasos y su fin con el costo acumulado", () => {
    const [spawn] = ofType(evs, "agent.spawn");
    const task = ofType(evs, "tool.call").find((e) => e.data.tool === "task")!;
    expect(spawn!).toMatchObject({ agent: SUBAGENT, turn: task.turn, data: { agent: SUBAGENT, type: "explore", description: "List files with glob", background: false, tool_use_id: task.data.tool_use_id } });
    const glob = ofType(evs, "tool.call").find((e) => e.data.tool === "glob")!;
    expect(glob.agent).toBe(SUBAGENT);
    expect(glob.turn).not.toBe(task.turn);
    const steps = ofType(evs, "turn.step").filter((e) => e.agent === SUBAGENT);
    expect(steps.map((e) => e.data.stop_reason)).toEqual(["tool-calls", "stop"]);
    const end = ofType(evs, "agent.end").find((e) => e.agent === SUBAGENT)!;
    expect(tokens(end.data.usage)).toEqual(sum(steps.map((s) => s.data.usage as Usage)));
    expect((end.data.usage as Usage).output).toBe(941);
    // El resultado de task llega cuando el subagente ya terminó.
    expect(evs.indexOf(ofType(evs, "tool.result").find((e) => e.data.tool === "task")!)).toBeGreaterThan(evs.indexOf(end));
  });

  it("cada turn.end suma los pasos de su turno; el total de la sesión es Σ turn.step", () => {
    for (const end of ofType(evs, "turn.end")) {
      const steps = ofType(evs, "turn.step").filter((s) => s.turn === end.turn);
      expect(end.data.steps).toBe(steps.length);
      expect(tokens(end.data.usage)).toEqual(sum(steps.map((s) => s.data.usage as Usage)));
    }
    expect(ofType(evs, "turn.step").length).toBe(7);
  });

  it("el turno interrumpido con Esc sale como aborted, con su paso parcial y la tool cerrada dentro", () => {
    const ends = ofType(evs, "turn.end").filter((e) => e.agent === undefined);
    expect(ends.map((e) => e.data.outcome)).toEqual(["answer", "answer", "tool-calls", "aborted"]);
    const aborted = ends.at(-1)!;
    const step = ofType(evs, "turn.step").find((s) => s.turn === aborted.turn)!;
    expect(step.data.partial).toBe(true);
    const sleep = ofType(evs, "tool.result").at(-1)!;
    expect(sleep.turn).toBe(aborted.turn);
    expect(evs.indexOf(sleep)).toBeLessThan(evs.indexOf(aborted));
  });

  it("cada fin de turno principal trae el contexto con la ventana del modelo y el costo", () => {
    const u = ofType(evs, "usage");
    expect(u.length).toBe(4);
    expect(u[0]!.data).toEqual({ context: { tokens: 21_661, window: 204_800, percent: 11 }, cost_usd: 0 });
  });

  it("/nod: el prompt que llega al modelo es la respuesta de Nod", () => {
    const nod = r.commandParts.find((c) => c.command === "nod")!;
    expect(nod.parts.length).toBe(1);
    expect(nod.parts[0].text).toContain("observando");
    expect(nod.parts[0].text).toContain("tarea NOD-42");
    // /nod no cuenta como comando de la sesión (igual que en Claude Code).
    expect(ofType(evs, "command")).toEqual([]);
  });

  it("el verbo de cada comando sale de la entrada de bash", () => {
    expect(ofType(evs, "tool.call").filter((e) => e.data.tool === "bash").map((e) => e.data.verb)).toEqual(["wc", "date", "sleep"]);
  });
});

describe("sesión real con opencode run", async () => {
  const r = await replayOpencode(RUN, { mode: "run", repo: REPO });
  const evs = events(r.envelopes);

  it("es Nod v1 válido y no interactiva", () => {
    for (const env of r.envelopes) expect(validate(env), JSON.stringify(validate.errors)).toBe(true);
    expect(evs[0]!.data).toMatchObject({ interactive: false, surface: "cli" });
    expect(ofType(evs, "prompt.submit").map((e) => e.data.origin)).toEqual(["cli"]);
    expect(evs.at(-1)!.type).toBe("session.end");
  });

  it("el rechazo automático de run es de política: nadie llegó a ver la pregunta", () => {
    expect(ofType(evs, "permission.request")).toEqual([]);
    expect(ofType(evs, "permission.decision").map((e) => [e.data.tool, e.data.decision, e.data.by, e.data.wait_ms])).toEqual([["bash", "deny", "policy", 0]]);
    const ls = ofType(evs, "tool.result").find((e) => e.data.tool === "bash")!;
    expect(ls.data).toMatchObject({ ok: false, rejected: false });
    expect(ofType(evs, "turn.end")[0]!.data.outcome).toBe("tool-calls");
  });
});

describe("sesión real con Nod Control", async () => {
  const A = approver("nod-opencode-aprobador");
  const ctrl = new FakeController();
  ctrl.waits = false;
  ctrl.onApproval = (body) => ctrl.queue(body.id, decide(A, body, body.summary === "date" ? "deny" : "allow"));
  const opts: OpencodeReplayOptions = {
    repo: REPO,
    env: { NOD_CONTROL: ctrl.base },
    readable: { "/Users/dev/.local/state/nod/approvers.json": JSON.stringify({ v: 1, keys: [{ kid: b64u(A.kid), spki: b64u(A.spki), added_ms: 1 }] }) },
    controller: { base: ctrl.base, fetch: ctrl.fetch },
  };
  const r = await replayOpencode(TUI, opts);
  const evs = events(r.envelopes);

  it("cada permiso se anuncia con el comando que verá el aprobador", () => {
    expect([...ctrl.approvals.values()].map((a) => [a.body.tool, a.body.summary])).toEqual([["bash", "wc -l notas.txt"], ["bash", "date"], ["bash", "sleep 30"]]);
  });

  it("la decisión remota se contesta a OpenCode y cuenta como remota; la del humano que llega después, no", () => {
    expect(r.client.filter((c) => c.method === "permission.reply").map((c) => c.args.body.response)).toEqual(["once", "reject", "once"]);
    expect(r.client[0]!.args.path).toMatchObject({ id: SESSION });
    expect(ofType(evs, "permission.decision").map((e) => [e.data.decision, e.data.by])).toEqual([["allow", "remote"], ["deny", "remote"], ["allow", "remote"]]);
    const date = ofType(evs, "tool.result").find((e) => ofType(evs, "tool.call").some((c) => c.data.tool_use_id === e.data.tool_use_id && c.data.verb === "date"))!;
    expect(date.data).toMatchObject({ ok: false, rejected: true });
    for (const env of r.envelopes) expect(validate(env), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("casos límite", () => {
  it("con privacidad redactado no sale texto, entrada ni rutas", async () => {
    const r = await replayOpencode(TUI, { repo: REPO, env: { NOD_PRIVACY: "redactado" } });
    const evs = events(r.envelopes);
    for (const env of r.envelopes) expect(validate(env), JSON.stringify(validate.errors)).toBe(true);
    const text = JSON.stringify(evs);
    expect(text).not.toContain("/Users/dev/proyecto");
    expect(text).not.toContain("Ejecuta");
    expect(ofType(evs, "tool.call").every((e) => e.data.input === undefined)).toBe(true);
  });

  it("una sesión retomada (sin session.created) se abre con su primer prompt y pide la versión al servidor", async () => {
    const r = await replayOpencode(TUI, { repo: REPO, skip: (row) => row.event === "session.created" || row.event === "session.updated" });
    const evs = events(r.envelopes);
    expect(evs[0]!).toMatchObject({ type: "session.start", session: SESSION, data: { model: "MiniMax-M2.7" } });
    expect(r.envelopes[0]!.source.host_version).toBe("1.18.34");
    expect(r.client.some((c) => c.method === "session.get")).toBe(true);
    // Sin session.created no se sabe que la hija es un subagente: sus eventos cuentan como de otra sesión.
    expect(ofType(evs, "agent.spawn")).toEqual([]);
  });

  it("si escribir el destino falla, ningún hook lanza y la sesión sigue", async () => {
    const r = await replayOpencode(TUI, { repo: REPO, failWrites: true });
    expect(r.envelopes).toEqual([]);
    expect(r.store.size).toBeGreaterThan(0);
  });

  it("eventos con formas inesperadas no rompen nada ni emiten eventos", async () => {
    const r = await replayOpencode(RUN, { mode: "run" });
    const before = events(r.envelopes).length;
    const h = r.hooks;
    await h.event({ event: { type: "message.part.updated", properties: undefined } });
    await h.event({ event: { type: "permission.asked", properties: { id: "per_1", sessionID: "s" } } });
    await h.event({ event: { type: "permission.replied", properties: { requestID: "nada" } } });
    await h.event(undefined as never);
    await h["chat.message"](undefined, undefined);
    await h["tool.execute.before"]({ sessionID: "s" }, null);
    await h["tool.execute.after"](null, "texto");
    await h.config(null);
    await new Promise((res) => setTimeout(res, 20));
    expect(events(r.envelopes).length).toBe(before);
  });

  it("config registra /nod sin pisar un comando nod del usuario", async () => {
    const r = await replayOpencode(RUN, { mode: "run" });
    const empty: any = {};
    await r.hooks.config(empty);
    expect(empty.command.nod).toMatchObject({ template: "$ARGUMENTS" });
    expect(empty.command.nod.description).toContain("Nod");
    const mine: any = { command: { nod: { template: "otro" } } };
    await r.hooks.config(mine);
    expect(mine.command.nod).toEqual({ template: "otro" });
  });

  it("session.deleted cierra la sesión", async () => {
    const r = await replayOpencode(RUN, { mode: "run", skip: (row) => row.event === "dispose" });
    await r.hooks.event({ event: { type: "session.deleted", properties: { info: { id: "ses_ecdc21524ffe5PuvIoQUFJsORz" } } } });
    await new Promise((res) => setTimeout(res, 20));
    const evs = events([...r.files.values()].flatMap((t) => t.split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    expect(evs.at(-1)!).toMatchObject({ type: "session.end", data: { reason: "deleted" } });
  });
});

describe("perfil y modo", () => {
  it("el perfil es el nombre del directorio de configuración, o opencode", () => {
    expect(profileOf(undefined)).toBe("opencode");
    expect(profileOf("/Users/dev/.config/opencode")).toBe("opencode");
    expect(profileOf("/Users/dev/.config/opencode-trabajo/")).toBe("opencode-trabajo");
    expect(profileOf("/Users/dev/.opencode")).toBe("opencode");
  });

  it("el modo sale de la línea de órdenes", () => {
    expect(runModeOf(["bun", "/$bunfs/root/src/index.js", "run", "-m", "x", "hola"])).toBe("run");
    expect(runModeOf(["bun", "/$bunfs/root/src/index.js", "serve", "--port", "4096"])).toBe("serve");
    expect(runModeOf(["bun", "/$bunfs/root/src/index.js"])).toBe("tui");
    expect(runModeOf(["bun", "/$bunfs/root/src/index.js", "-m", "x"])).toBe("tui");
  });
});
