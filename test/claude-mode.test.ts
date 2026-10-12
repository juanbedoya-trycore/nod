/**
 * El modo de permisos en el adaptador de Claude: el del hook clásico UserPromptSubmit si llega; si no, el último
 * de la transcripción (cacheado 2 s). En auto no se retiene; si no se sabe, sí.
 */
import { describe, expect, it, vi } from "vitest";
import { b64u } from "../src/core/control/crypto.js";
import { lastMode, modeGrepArgs, projectSlug, transcriptPath } from "../src/hosts/claude/mode.js";
import { FakeController, approver, decide } from "./support/control.js";

const A = approver("nod-mode-aprobador");

describe("transcripción", () => {
  it("ruta y último modo", () => {
    expect(projectSlug("/Users/dev/mi proyecto.v2")).toBe("-Users-dev-mi-proyecto-v2");
    expect(transcriptPath("/c/", "/Users/dev/p", "s1")).toBe("/c/projects/-Users-dev-p/s1.jsonl");
    expect(modeGrepArgs("/t.jsonl")).toEqual(["/usr/bin/grep", "-o", '"permissionMode":"[A-Za-z]*"', "/t.jsonl"]);
    expect(lastMode('"permissionMode":"default"\n"permissionMode":"auto"\n')).toBe("auto");
    expect(lastMode("")).toBeUndefined();
    expect(lastMode(undefined)).toBeUndefined();
  });
});

/** El adaptador real con un `$` mínimo: devuelve los hooks y lo que hizo. */
async function adapter(transcript: string) {
  vi.resetModules();
  const { register } = await import("../src/hosts/claude/register.js");
  const hooks = new Map<string, any>();
  register(((event: string, a: any, b?: any) => {
    if (b === undefined) hooks.set(event, a);
    return { catch: () => undefined };
  }) as never);
  const ctrl = new FakeController();
  ctrl.waits = false;
  ctrl.onApproval = (body) => ctrl.queue(body.id, decide(A, body, "allow"));
  const greps: number[] = [];
  let now = 1_800_000_000_000;
  const files: Record<string, string> = { "/h/.local/state/nod/approvers.json": JSON.stringify({ v: 1, keys: [{ kid: b64u(A.kid), spki: b64u(A.spki), added_ms: 1 }] }) };
  const env: Record<string, string> = { HOME: "/h", NOD_CONTROL: ctrl.base, NOD_SINKS: "/h/eventos.jsonl" };
  const $ = {
    clock: {
      now: async () => now,
      // Los plazos corren en milisegundos reales (como mucho 20): el controlador contesta antes, sin esperas.
      after: (ms: number, cb: () => void) => {
        const h = setTimeout(cb, Math.min(ms, 20));
        return { cancel: () => clearTimeout(h) };
      },
    },
    env: { get: async (k: string) => env[k] },
    store: { get: async () => undefined, set: async () => undefined, delete: async () => undefined },
    fs: { read: async (p: string) => (p in files ? files[p] : Promise.reject(new Error("ENOENT"))), write: async (p: string, t: string) => void (files[p] = t) },
    process: {
      run: async (argv: string[]) => {
        if (argv[0] === "/usr/bin/grep") {
          greps.push(now);
          return { exitCode: 0, stdout: transcript };
        }
        return { exitCode: 0, stdout: "" };
      },
    },
    http: { fetch: (url: string, init: any) => ctrl.fetch(url, init) },
    session: { id: async () => "s1", cwd: async () => "/p", version: async () => "2.1.296", repo: async () => undefined, model: async () => undefined, usage: async () => undefined },
    command: { register: async () => undefined },
    ui: { log: () => undefined, status: () => undefined, toast: () => undefined },
    turn: { abort: async () => undefined },
    prompt: { submit: async () => undefined },
  };
  await hooks.get("session.start")($, { cwd: "/p" }, async () => undefined);
  let n = 0;
  const check = async () => {
    const next = Object.assign(async () => ({ decision: "ask" }), { signal: undefined });
    return hooks.get("tool.check")($, { tool: "Bash", input: { command: "touch x" }, tool_use_id: `toolu_${++n}` }, next);
  };
  const prompt = (mode: string) => hooks.get("classic.UserPromptSubmit")($, { permission_mode: mode }, async (e: unknown) => e);
  return { check, prompt, ctrl, greps, advance: (ms: number) => (now += ms) };
}

describe("tool.check en el adaptador", () => {
  it("sin hook clásico: la transcripción manda (auto → no retiene), con caché de 2 s", async () => {
    const a = await adapter('"permissionMode":"default"\n"permissionMode":"auto"');
    expect(await a.check()).toEqual({ decision: "ask" });
    expect(await a.check()).toEqual({ decision: "ask" });
    expect(a.greps.length).toBe(1);
    a.advance(2_500);
    await a.check();
    expect(a.greps.length).toBe(2);
    expect(a.ctrl.approvals.size).toBe(0);
  });

  it("con el hook clásico: su permission_mode manda sobre la transcripción", async () => {
    const a = await adapter('"permissionMode":"auto"');
    await a.prompt("default");
    expect(await a.check()).toEqual({ decision: "allow", reason: "aprobado desde fuera del terminal (Nod Control)" });
    expect(a.greps).toEqual([]);
    await a.prompt("auto");
    expect(await a.check()).toEqual({ decision: "ask" });
    expect(a.ctrl.approvals.size).toBe(1);
  });

  it("modo desconocido (transcripción vacía, sin hook): se retiene", async () => {
    const a = await adapter("");
    expect(await a.check()).toMatchObject({ decision: "allow" });
  });
});
