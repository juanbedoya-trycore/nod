import { describe, expect, it } from "vitest";
import { Normalizer, verbOf } from "../src/core/normalize.js";

const S = "sess";

describe("verbOf", () => {
  it("primera palabra, sin variables, sudo ni ruta", () => {
    expect(verbOf("FOO=1 BAR=2 npm test")).toBe("npm");
    expect(verbOf("sudo /usr/bin/rm -rf x")).toBe("rm");
    expect(verbOf("  git status")).toBe("git");
    expect(verbOf("")).toBeUndefined();
    expect(verbOf(42)).toBeUndefined();
  });
});

describe("permisos", () => {
  it("allow sin preguntar = policy, sin espera", () => {
    const n = new Normalizer();
    n.toolCall(0, S, { toolUseId: "t1", tool: "Read" });
    const [d] = n.toolCheck(5, S, "t1", "Read", "allow");
    expect(d!.type).toBe("permission.decision");
    expect(d!.data).toMatchObject({ decision: "allow", by: "policy", wait_ms: 0 });
  });

  it("ask y la tool se ejecuta = el humano aprobó; la duración no incluye la espera", () => {
    const n = new Normalizer();
    n.turnStart(0, S, "turn1");
    n.toolCall(10, S, { toolUseId: "t1", tool: "Bash", input: { command: "ls" } });
    expect(n.toolCheck(20, S, "t1", "Bash", "ask", "necesita permiso")[0]!.type).toBe("permission.request");
    const out = n.toolResult(5020, S, { toolUseId: "t1", tool: "Bash", ok: true, rejected: false, outputChars: 3 });
    expect(out.map((e) => e.type)).toEqual(["permission.decision", "tool.result"]);
    expect(out[0]!.data).toMatchObject({ decision: "allow", by: "user", wait_ms: 5000 });
    expect(out[0]!.turn).toBe("turn1");
    expect(out[1]!.data).toMatchObject({ ok: true, rejected: false, duration_ms: 0 });
  });

  it("ask y rechazo = el humano negó", () => {
    const n = new Normalizer();
    n.toolCall(0, S, { toolUseId: "t1", tool: "Bash" });
    n.toolCheck(10, S, "t1", "Bash", "ask");
    const out = n.toolResult(3010, S, { toolUseId: "t1", tool: "Bash", ok: false, rejected: true, outputChars: 0 });
    expect(out[0]!.data).toMatchObject({ decision: "deny", by: "user", wait_ms: 3000 });
    expect(out[1]!.data).toMatchObject({ ok: false, rejected: true });
  });

  it("un ask sin respuesta al cerrar el turno cuenta como negado por el humano", () => {
    const n = new Normalizer();
    n.turnStart(0, S, "turn1");
    n.toolCall(1, S, { toolUseId: "t1", tool: "Edit" });
    n.toolCheck(2, S, "t1", "Edit", "ask");
    const out = n.turnEnd(1002, S, { turn: "turn1", outcome: "aborted" });
    expect(out.map((e) => e.type)).toEqual(["permission.decision", "turn.end"]);
    expect(out[0]!.data).toMatchObject({ decision: "deny", by: "user", wait_ms: 1000 });
  });

  it("una decisión remota cuenta como remote y la tool ya no la duplica", () => {
    const n = new Normalizer();
    n.toolCall(0, S, { toolUseId: "t1", tool: "Bash" });
    n.toolCheck(1, S, "t1", "Bash", "ask");
    expect(n.remoteDecision(4001, S, "t1", "allow")[0]!.data).toMatchObject({ by: "remote", wait_ms: 4000 });
    expect(n.remoteDecision(4002, S, "t1", "deny")).toEqual([]);
    const out = n.toolResult(5000, S, { toolUseId: "t1", tool: "Bash", ok: true, rejected: false, outputChars: 0 });
    expect(out.map((e) => e.type)).toEqual(["tool.result"]);
    expect(out[0]!.data.duration_ms).toBe(999);
  });
});

describe("prompts", () => {
  it("recalled si parte de un prompt ya enviado; revised si se borra texto", () => {
    const n = new Normalizer();
    n.promptEdit(0, { before: "", start: 0, end: 0, inserted: "hola" });
    const a = n.promptSubmit(1000, S, { text: "hola", origin: "composer" })[0]!;
    expect(a.data.edit).toEqual({ events: 1, typing_ms: 1000, recalled: false, revised: false });
    n.promptEdit(2000, { before: "hola", start: 4, end: 4, inserted: " mundo" });
    n.promptEdit(2500, { before: "hola mundo", start: 0, end: 4, inserted: "adiós" });
    const b = n.promptSubmit(3000, S, { text: "adiós mundo", origin: "composer" })[0]!;
    expect(b.data.edit).toEqual({ events: 2, typing_ms: 1000, recalled: true, revised: true });
  });

  it("un prompt sin edición (otro origen) no trae edit", () => {
    const n = new Normalizer();
    expect(n.promptSubmit(0, S, { text: "x", origin: "task-notification" })[0]!.data.edit).toBeUndefined();
  });
});

describe("tareas y turnos", () => {
  it("la tarea va en todos los eventos posteriores y se cierra", () => {
    const n = new Normalizer();
    n.setTask(0, S, "ABC-12", "Login", "command");
    expect(n.turnStart(1, S, "t")[0]!.task).toBe("ABC-12");
    n.setTask(2, S, undefined, undefined, "command");
    expect(n.turnStart(3, S, "u")[0]!.task).toBeUndefined();
  });

  it("los pasos se cuentan por turno y el subagente acumula su uso", () => {
    const n = new Normalizer();
    n.agentSpawn(0, S, { agent: "a1", type: "Explore" });
    n.step(10, S, { turn: "ta", agent: "a1", index: 0, tools: ["Read"], usage: { input: 1, output: 10, cache_read: 0, cache_write: 0 } });
    n.step(20, S, { turn: "ta", agent: "a1", index: 1, tools: [], usage: { input: 2, output: 5, cache_read: 0, cache_write: 0 } });
    const out = n.turnEnd(30, S, { turn: "ta", agent: "a1", outcome: "answer" });
    expect(out[0]!.data.steps).toBe(2);
    expect(out[1]!.type).toBe("agent.end");
    expect(out[1]!.data).toMatchObject({ agent: "a1", duration_ms: 30, usage: { input: 3, output: 15 } });
  });

  it("una tool de subagente se asocia a su turno, no al principal", () => {
    const n = new Normalizer();
    n.turnStart(0, S, "main");
    n.step(1, S, { turn: "sub", agent: "a1", index: 0, tools: ["Read"] });
    expect(n.toolCall(2, S, { toolUseId: "x", tool: "Read", agent: "a1" })[0]!.turn).toBe("sub");
    expect(n.toolCall(3, S, { toolUseId: "y", tool: "Bash" })[0]!.turn).toBe("main");
  });

  it("usage vacío no emite", () => {
    expect(new Normalizer().usage(0, S, {})).toEqual([]);
  });
});

describe("fidelidad", () => {
  it("verbOf no deja salir trozos de secretos ni scripts propios", () => {
    expect(verbOf("PGPASSWORD='hunter2 s3cr3t' psql")).toBeUndefined();
    expect(verbOf("/Users/jperez/clientes/acme/deploy-acme.sh prod")).toBeUndefined();
    expect(verbOf("(cd /x && make)")).toBeUndefined();
    expect(verbOf("$(echo rm) -rf")).toBeUndefined();
    expect(verbOf("npm run build")).toBe("npm");
  });

  it("lo tecleado para un comando no se cuela en el siguiente prompt; los prompts del agente no consumen la edición", () => {
    const n = new Normalizer();
    n.promptEdit(0, { before: "", start: 0, end: 0, inserted: "/exit" });
    n.command(10, S, "exit");
    expect(n.promptSubmit(20, S, { text: "aviso", origin: "task-notification" })[0]!.data.edit).toBeUndefined();
    n.promptEdit(30, { before: "", start: 0, end: 0, inserted: "hola" });
    expect(n.promptSubmit(40, S, { text: "aviso", origin: "task-notification" })[0]!.data.edit).toBeUndefined();
    expect(n.promptSubmit(50, S, { text: "hola", origin: "composer" })[0]!.data.edit).toMatchObject({ events: 1, typing_ms: 20 });
  });

  it("aprobado sin duración de ejecución: wait_ms es cota superior (exact: false)", () => {
    const n = new Normalizer();
    n.toolCall(0, S, { toolUseId: "t", tool: "Bash" });
    n.toolCheck(10, S, "t", "Bash", "ask");
    const [d] = n.toolResult(5010, S, { toolUseId: "t", tool: "Bash", ok: true, rejected: false, outputChars: 0 });
    expect(d!.data).toMatchObject({ wait_ms: 5000, exact: false });
  });

  it("aprobado con duración de ejecución: la espera excluye la ejecución", () => {
    const n = new Normalizer();
    n.toolCall(0, S, { toolUseId: "t", tool: "Bash" });
    n.toolCheck(10, S, "t", "Bash", "ask");
    n.toolExec("t", 300_000);
    const out = n.toolResult(302_010, S, { toolUseId: "t", tool: "Bash", ok: true, rejected: false, outputChars: 0 });
    expect(out[0]!.data).toMatchObject({ wait_ms: 2_000, exact: true });
    expect(out[0]!.ts).toBe(2_010);
    expect(out[1]!.data.duration_ms).toBe(300_000);
  });

  it("un permiso de subagente abandonado se cierra con su turno", () => {
    const n = new Normalizer();
    n.stepBegin("sub", "a1");
    n.toolCall(1, S, { toolUseId: "t", tool: "Edit", agent: "a1" });
    n.toolCheck(2, S, "t", "Edit", "ask");
    expect(n.turnEnd(10, S, { turn: "sub", agent: "a1", outcome: "aborted" }).map((e) => [e.type, e.data.decision])).toEqual([["permission.decision", "deny"], ["turn.end", undefined]]);
  });
});
