import { describe, expect, it } from "vitest";
import { Translator, agentIdFromText, toolInputOf } from "../src/core/translate.js";
import { FIXTURE_NAMES, loadFixture, makeAjv, replay } from "./support/fixtures.js";

const names = (evs: { hook_event_name: string }[]) => evs.map((e) => e.hook_event_name);

describe("traducción con fixtures reales", () => {
  const observe = replay(loadFixture("observe"));

  it("observe: secuencia canónica completa", () => {
    expect(names(observe)).toEqual([
      "SessionStart", "UserPromptSubmit",
      "PreToolUse", "PostToolUse", // ToolSearch
      "PreToolUse", "PostToolUse", // mcp__echo__echo (main)
      "PreToolUse", "SubagentStart", "PostToolUse", // Agent: el id llega en el texto del resultado
      "PreToolUse", "PostToolUse", // ToolSearch del subagente
      "PreToolUse", "PostToolUse", // mcp del subagente
      "Stop", "SubagentStop",
      "UserPromptSubmit", "Stop", "SessionEnd",
    ]);
  });

  it("SessionStart / UserPromptSubmit / Stop / SessionEnd llevan los campos de §3.3", () => {
    const start = observe.find((e) => e.hook_event_name === "SessionStart")!;
    expect(start.source).toBe("mod");
    expect(typeof start.cwd).toBe("string");
    const prompt = observe.find((e) => e.hook_event_name === "UserPromptSubmit")!;
    expect(prompt.prompt).toMatch(/^Do these steps/);
    expect(typeof prompt.turn_id).toBe("string");
    const stop = observe.filter((e) => e.hook_event_name === "Stop");
    expect(stop[stop.length - 1]).toMatchObject({ last_assistant_message: "finished", is_aborted: false });
    const end = observe.find((e) => e.hook_event_name === "SessionEnd")!;
    expect(end.reason).toBe("other");
  });

  it("PreToolUse aplana los args sin tool, tool_use_id ni agentId", () => {
    const mcp = observe.filter((e) => e.hook_event_name === "PreToolUse" && e.tool_name === "mcp__echo__echo");
    expect(mcp).toHaveLength(2);
    expect(mcp[0]!.tool_input).toEqual({ text: "from-main" });
    expect(mcp[0]!.agent_id).toBeUndefined();
    expect(mcp[1]!.tool_input).toEqual({ text: "from-subagent" });
    expect(mcp[1]!.agent_id).toBe("af04106b85f08f59a");
    expect(mcp[1]!.agent_type).toBe("general-purpose");
  });

  it("emparejamiento tardío: SubagentStart con parent_tool_use_id del tool Agent y antes de PostToolUse(Agent)", () => {
    const agentCall = observe.find((e) => e.hook_event_name === "PreToolUse" && e.tool_name === "Agent")!;
    const start = observe.filter((e) => e.hook_event_name === "SubagentStart");
    expect(start).toHaveLength(1);
    expect(start[0]).toMatchObject({
      agent_id: "af04106b85f08f59a", agent_type: "general-purpose", parent_tool_use_id: agentCall.tool_use_id, background: true,
    });
    const iStart = observe.indexOf(start[0]!);
    const iPre = observe.indexOf(agentCall);
    const iPost = observe.findIndex((e) => e.hook_event_name === "PostToolUse" && e.tool_use_id === agentCall.tool_use_id);
    expect(iPre).toBeLessThan(iStart);
    expect(iStart).toBeLessThan(iPost);
  });

  it("PostToolUse no copia el texto del resultado, solo is_error (y el agentId del tool Agent)", () => {
    const posts = observe.filter((e) => e.hook_event_name === "PostToolUse");
    for (const p of posts) {
      expect(p.is_error).toBe(false);
      expect(JSON.stringify(p)).not.toContain("echo: from-main");
      expect(JSON.stringify(p)).not.toContain("Async agent launched");
    }
    const agentPost = posts.find((p) => p.tool_name === "Agent")!;
    expect(agentPost.tool_response).toEqual({ agentId: "af04106b85f08f59a" });
  });

  it("SubagentStop (turn.complete con agentId) y Stop (sin agentId)", () => {
    const stop = observe.find((e) => e.hook_event_name === "SubagentStop")!;
    expect(stop).toMatchObject({ agent_id: "af04106b85f08f59a", is_aborted: false });
    expect(observe.some((e) => e.hook_event_name === "Stop" && e.agent_id !== undefined)).toBe(false);
  });

  it("usage va en Stop/SubagentStop-Stop como campo extra", () => {
    const stops = observe.filter((e) => e.hook_event_name === "Stop");
    expect(stops.every((s) => typeof (s as any).usage === "object")).toBe(true);
  });

  it("turnComplete con agentId lleva usage en SubagentStop (SPEC §3.3); sin usage no inventa el campo", () => {
    const t = new Translator();
    const usage = { input_tokens: 5000, output_tokens: 700 };
    const [withUsage] = t.turnComplete("s", { agentId: "ag1", usage });
    expect(withUsage).toMatchObject({ hook_event_name: "SubagentStop", agent_id: "ag1", usage });
    const [without] = new Translator().turnComplete("s", { agentId: "ag2" });
    expect(without).not.toHaveProperty("usage");
    const [stop] = new Translator().turnComplete("s", { usage });
    expect(stop).toMatchObject({ hook_event_name: "Stop", usage });
  });

  it("PermissionRequest solo cuando el veredicto es ask (fixtures allow/deny/timeout)", () => {
    for (const name of ["allow", "deny", "timeout", "slow"]) {
      const lines = loadFixture(name);
      const asks = lines.filter((l) => l.event === "tool.check" && l.data.verdict?.decision === "ask");
      const out = replay(lines).filter((e) => e.hook_event_name === "PermissionRequest");
      expect(asks.length, name).toBeGreaterThan(0);
      expect(out, name).toHaveLength(asks.length);
      expect(out[0]).toMatchObject({ tool_name: "Bash", tool_use_id: asks[0]!.data.tool_use_id });
      expect(typeof out[0]!.tool_input).toBe("object");
    }
    expect(replay(loadFixture("observe")).some((e) => e.hook_event_name === "PermissionRequest")).toBe(false);
  });

  it("parallel: dos PermissionRequest con tool_use_id distintos", () => {
    const out = replay(loadFixture("parallel")).filter((e) => e.hook_event_name === "PermissionRequest");
    expect(new Set(out.map((e) => e.tool_use_id)).size).toBe(2);
  });

  it("timeout: el resultado erróneo del motor da PostToolUse is_error=true", () => {
    const post = replay(loadFixture("timeout")).filter((e) => e.hook_event_name === "PostToolUse" && e.tool_name === "Bash");
    expect(post[0]!.is_error).toBe(true);
  });

  it("todos los fixtures producen payloads válidos contra hook-payload.schema.json", () => {
    const v = makeAjv().getSchema("hook-payload.schema.json")!;
    for (const n of FIXTURE_NAMES) {
      const evs = replay(loadFixture(n));
      expect(evs.length, n).toBeGreaterThan(0);
      for (const ev of evs) expect(v(ev), `${n}/${ev.hook_event_name}: ${JSON.stringify(v.errors)}`).toBe(true);
    }
  });

  it("no se emiten prompt.submit ni eventos sin traducción", () => {
    const hooks = new Set(FIXTURE_NAMES.flatMap((n) => names(replay(loadFixture(n)))));
    for (const h of hooks) expect(["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "SubagentStart", "SubagentStop", "Stop", "SessionEnd"]).toContain(h);
  });
});

describe("emparejamiento tardío de agentId (sintético)", () => {
  const spawn = (t: Translator, id: string, type = "general-purpose", description = "", background = false) =>
    t.agentSpawn({ tool_use_id: id, subagentType: type, description, background });

  it("sin agentId todavía no hay SubagentStart", () => {
    const t = new Translator();
    spawn(t, "tu1");
    expect(t.pendingSpawns).toBe(1);
  });

  it("primer tool.call del subagente (primer plano): empareja por tipo y emite antes del PreToolUse", () => {
    const t = new Translator();
    spawn(t, "tu1", "Explore", "buscar");
    const out = t.toolCall("s", { tool: "Read", tool_use_id: "r1", agentId: "A1", file_path: "/x" }, { id: "A1", type: "Explore", description: "buscar" });
    expect(names(out)).toEqual(["SubagentStart", "PreToolUse"]);
    expect(out[0]).toMatchObject({ agent_id: "A1", agent_type: "Explore", parent_tool_use_id: "tu1", background: false });
    expect(out[1]).toMatchObject({ agent_id: "A1", agent_type: "Explore", tool_input: { file_path: "/x" } });
    // el resto de llamadas del mismo agente no repiten SubagentStart
    expect(names(t.toolCall("s", { tool: "Read", tool_use_id: "r2", agentId: "A1" }))).toEqual(["PreToolUse"]);
    expect(t.needsAgentLookup("A1")).toBe(false);
  });

  it("dos spawns del mismo tipo: FIFO, y la descripción desempata", () => {
    const t = new Translator();
    spawn(t, "tu1", "general-purpose", "uno");
    spawn(t, "tu2", "general-purpose", "dos");
    const b = t.toolCall("s", { tool: "Bash", tool_use_id: "b", agentId: "B" }, { id: "B", type: "general-purpose", description: "dos" });
    expect(b[0]).toMatchObject({ hook_event_name: "SubagentStart", parent_tool_use_id: "tu2" });
    const a = t.toolCall("s", { tool: "Bash", tool_use_id: "a", agentId: "A" }, { id: "A", type: "general-purpose", description: "x" });
    expect(a[0]).toMatchObject({ hook_event_name: "SubagentStart", parent_tool_use_id: "tu1" });
  });

  it("el agentId: del resultado del tool Agent vincula por tool_use_id exacto, aunque haya otros pendientes", () => {
    const t = new Translator();
    spawn(t, "tu1", "Explore");
    spawn(t, "tu2", "Plan", "", true);
    const out = t.toolResult("s", { tool: "Agent", tool_use_id: "tu2" }, { text: "Async agent launched\nagentId: aP1 (internal ID)" });
    expect(names(out)).toEqual(["SubagentStart", "PostToolUse"]);
    expect(out[0]).toMatchObject({ agent_id: "aP1", agent_type: "Plan", parent_tool_use_id: "tu2", background: true });
    expect(t.pendingSpawns).toBe(1);
  });

  it("si el agente ya arrancó por un tool.call, el resultado del Agent no repite SubagentStart", () => {
    const t = new Translator();
    spawn(t, "tu1", "Explore");
    t.toolCall("s", { tool: "Read", tool_use_id: "r", agentId: "A1" }, { id: "A1", type: "Explore" });
    const out = t.toolResult("s", { tool: "Agent", tool_use_id: "tu1" }, { text: "agentId: A1" });
    expect(names(out)).toEqual(["PostToolUse"]);
  });

  it("turn.complete de un agente sin arrancar: usa el único pendiente; con varios, no adivina", () => {
    const t = new Translator();
    spawn(t, "tu1", "Explore");
    expect(names(t.turnComplete("s", { agentId: "A1", isAborted: false }))).toEqual(["SubagentStart", "SubagentStop"]);
    const u = new Translator();
    spawn(u, "tu1", "Explore");
    spawn(u, "tu2", "Plan");
    expect(names(u.turnComplete("s", { agentId: "A1", isAborted: true }))).toEqual(["SubagentStop"]);
  });

  it("un tool.call de subagente sin spawn conocido no inventa SubagentStart", () => {
    const t = new Translator();
    expect(names(t.toolCall("s", { tool: "Bash", tool_use_id: "b", agentId: "Z" }, { id: "Z", type: "fork" }))).toEqual(["PreToolUse"]);
  });

  it("SubagentStop abortado marca is_aborted", () => {
    const t = new Translator();
    expect(t.turnComplete("s", { agentId: "A", isAborted: true })[0]).toMatchObject({ hook_event_name: "SubagentStop", is_aborted: true });
  });
});

describe("utilidades", () => {
  it("toolInputOf quita las claves reservadas del motor", () => {
    expect(toolInputOf({ tool: "Bash", tool_use_id: "x", agentId: "a", requestMeta: {}, command: "ls", description: "d" })).toEqual({ command: "ls", description: "d" });
  });

  it("agentIdFromText", () => {
    expect(agentIdFromText("Async agent launched.\nagentId: af04106b85f08f59a (internal ID)")).toBe("af04106b85f08f59a");
    expect(agentIdFromText("sin id")).toBeUndefined();
    expect(agentIdFromText(undefined)).toBeUndefined();
  });

  it("un resultado con deny cuenta como error", () => {
    const t = new Translator();
    expect(t.toolResult("s", { tool: "Bash", tool_use_id: "b" }, { deny: "no" })[0]!.is_error).toBe(true);
  });

  it("tool.check allow/deny no emite nada", () => {
    const t = new Translator();
    expect(t.toolCheck("s", { tool: "Bash", input: {}, tool_use_id: "b" }, { decision: "allow" })).toEqual([]);
    expect(t.toolCheck("s", { tool: "Bash", input: {}, tool_use_id: "b" }, { decision: "deny" })).toEqual([]);
  });
});

import { sessionFigures } from "../src/hosts/claude/register.js";

describe("cifras de la sesión en el Stop", () => {
  it("solo copia números de usage()", () => {
    expect(sessionFigures({ startedAt: 1000, context: { window: 200000, tokens: 50000, percent: 25, breakdown: { x: "texto" } }, cost: { usd: 1.25 }, rateLimits: [] }))
      .toEqual({ context: { window: 200000, tokens: 50000, percent: 25 }, session_started_ms: 1000, cost_usd: 1.25 });
    expect(sessionFigures(undefined)).toEqual({});
    expect(sessionFigures({ context: { window: "x" } })).toEqual({});
  });
});
