/** NodEngine sobre una Platform falsa: lo que verá cualquier adaptador. */
import { describe, expect, it } from "vitest";
import { NodEngine, SERVER_INSTALL_HINT } from "../src/core/engine.js";
import type { OrbitEnv, Platform, SessionControl } from "../src/core/platform.js";

function fakePlatform(env: OrbitEnv, files: Record<string, string> = {}) {
  const posts: { url: string; body: any }[] = [];
  const store = new Map<string, unknown>();
  let t = 1_700_000_000_000;
  const p: Platform = {
    host: "test",
    env: async () => env,
    now: async () => t,
    after: (ms, cb) => {
      const h = setTimeout(cb, Math.min(ms, 5));
      return { cancel: () => clearTimeout(h) };
    },
    fetch: async (url, init) => {
      if (url.includes("/v0/ingest")) {
        posts.push({ url, body: JSON.parse(String((init as any).body)) });
        return { status: 200, ok: true, text: "{}" };
      }
      return { status: 204, ok: true, text: "" };
    },
    store: {
      get: async (k) => store.get(k),
      set: async (k, v) => void store.set(k, v),
      delete: async (k) => void store.delete(k),
    },
    read: async (path) => {
      if (path in files) return files[path]!;
      throw new Error("ENOENT");
    },
    write: async (path, text) => void (files[path] = text),
    run: async () => undefined,
    log: () => undefined,
    toast: () => undefined,
    status: () => undefined,
    sessionId: async () => "sess-1",
  };
  return { p, posts, store, files, tick: (ms: number) => (t += ms) };
}

const control: SessionControl = { abortTurn: async () => undefined, submitPrompt: async () => undefined };
const ENV: OrbitEnv = { ORBIT_URL: "http://127.0.0.1:7878", ORBIT_TOKEN: "t".repeat(32), ORBIT_INSTANCE_ID: "mac-test", ORBIT_CTX: "personal", HOME: "/nohome" };

describe("NodEngine", () => {
  it("sin variables ni client.json, /nod dice que falta el servidor", async () => {
    const { p } = fakePlatform({ HOME: "/nohome" });
    const text = await new NodEngine().command(p, "");
    expect(text).toContain("sin configurar");
    expect(text).toContain(SERVER_INSTALL_HINT);
  });

  it("con client.json del servidor se configura solo", async () => {
    const client = JSON.stringify({ v: 1, url: "http://127.0.0.1:7878", token: "t".repeat(32), instance_id: "mac-auto", ctx: "personal" });
    const { p } = fakePlatform({ ORBIT_STATE_DIR: "/estado" }, { "/estado/client.json": client });
    const text = await new NodEngine().command(p, "");
    expect(text).toContain("instancia: mac-auto");
    expect(text).toContain("configuración: /estado/client.json");
  });

  it("un fin de turno de la sesión principal sale ya, con lo que añade el adaptador", async () => {
    const { p, posts } = fakePlatform(ENV);
    const o = new NodEngine();
    await o.sessionStart(p, { source: "startup" }, control, { orbit_where: { profile: "claude" } });
    await o.turnStart(p, { turnId: "turn-1" });
    await o.turnComplete(p, {}, control, async () => ({ cost_usd: 0.5 }));
    const events = posts.flatMap((x) => (x.body.events ?? []).map((e: any) => e.ev));
    const names = events.map((e: any) => e.hook_event_name);
    expect(names).toContain("SessionStart");
    expect(names).toContain("Stop");
    expect(events.find((e: any) => e.hook_event_name === "SessionStart").orbit_where).toEqual({ profile: "claude" });
    expect(events.find((e: any) => e.hook_event_name === "Stop").cost_usd).toBe(0.5);
  });

  it("un ask que el agente no deja retener (auto mode) pasa sin avisar al servidor", async () => {
    const { p, posts } = fakePlatform(ENV);
    const verdict = { decision: "ask" } as any;
    const out = await new NodEngine().toolCheck(p, { tool: "Bash", input: { command: "ls" }, tool_use_id: "toolu_1" }, verdict, undefined, false);
    expect(out).toBe(verdict);
    expect(posts).toEqual([]);
  });

  it("un ask sin reloj emparejado no se retiene", async () => {
    const { p } = fakePlatform(ENV);
    const verdict = { decision: "ask" } as any;
    const out = await new NodEngine().toolCheck(p, { tool: "Bash", input: { command: "ls" }, tool_use_id: "toolu_2" }, verdict, undefined);
    expect(out).toBe(verdict);
  });

  it("/nod away es de la máquina: lo guarda en el directorio de estado", async () => {
    const client = JSON.stringify({ v: 1, url: "http://127.0.0.1:7878", token: "t".repeat(32), instance_id: "mac-auto", ctx: "personal" });
    const { p, files } = fakePlatform({ ORBIT_STATE_DIR: "/estado" }, { "/estado/client.json": client });
    const text = await new NodEngine().command(p, "away");
    expect(text).toContain("lejos del Mac");
    expect(JSON.parse(files["/estado/away.json"]!)).toEqual({ away: true });
  });
});
