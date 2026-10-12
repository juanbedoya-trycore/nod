/**
 * La misma sesión real (claude 2.1.296) reproducida con Nod Control activo y un aprobador que contesta lo mismo
 * que contestó el humano: niega `touch denegado.txt` y aprueba `touch aprobado.txt`. Lo que sale tiene que contar
 * esas dos decisiones como remotas, seguir siendo Nod v1 válido, y no retener nada en auto mode.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { b64u } from "../src/core/control/crypto.js";
import type { NodEvent } from "../src/core/events.js";
import { FakeController, approver, decide } from "./support/control.js";
import { replay } from "./support/harness.js";
import type { ReplayOptions } from "./support/harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures/claude-2.1.296-interactiva.jsonl");
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(JSON.parse(readFileSync(join(HERE, "../schema/nod-v1.schema.json"), "utf8")));
const A = approver("nod-replay-aprobador");
const APPROVERS = "/Users/dev/.local/state/nod/approvers.json";

function setup(transcript?: string): { ctrl: FakeController; opts: ReplayOptions } {
  const ctrl = new FakeController();
  ctrl.waits = false;
  ctrl.onApproval = (body) => ctrl.queue(body.id, decide(A, body, body.summary === "touch denegado.txt" ? "deny" : "allow"));
  const opts: ReplayOptions = {
    env: { NOD_CONTROL: ctrl.base },
    readable: { [APPROVERS]: JSON.stringify({ v: 1, keys: [{ kid: b64u(A.kid), spki: b64u(A.spki), added_ms: 1 }] }) },
    controller: { base: ctrl.base, fetch: ctrl.fetch },
  };
  if (transcript !== undefined) opts.transcript = transcript;
  return { ctrl, opts };
}

const events = (envs: { events: NodEvent[] }[]) => envs.flatMap((e) => e.events);

describe("sesión real con Nod Control", async () => {
  const { ctrl, opts } = setup('{"type":"user","permissionMode":"default"}');
  const r = await replay(FIXTURE, opts);
  const evs = events(r.envelopes);

  it("los dos permisos preguntados se anuncian con lo que verá el aprobador", () => {
    const bodies = [...ctrl.approvals.values()].map((a) => a.body);
    expect(bodies.map((b) => [b.tool, b.summary, b.wok])).toEqual([
      ["Bash", "touch denegado.txt", true],
      ["Bash", "touch aprobado.txt", true],
    ]);
    expect(bodies[0].instance).toBe(r.envelopes[0]!.source.instance);
    expect(bodies[0].session).toBe(evs[0]!.session);
  });

  it("las decisiones salen como remotas, con lo que decidió el aprobador, y ninguna como del humano", () => {
    const decisions = evs.filter((e) => e.type === "permission.decision" && e.data.by !== "policy");
    expect(decisions.map((e) => [e.data.decision, e.data.by])).toEqual([
      ["deny", "remote"],
      ["allow", "remote"],
    ]);
    expect(evs.filter((e) => e.type === "permission.request").length).toBe(2);
  });

  it("sigue siendo Nod v1 válido y el modo salió de la transcripción", () => {
    for (const env of r.envelopes) expect(validate(env), JSON.stringify(validate.errors)).toBe(true);
    const grep = r.runs.find((a) => a[0] === "/usr/bin/grep")!;
    expect(grep.at(-1)).toBe(`/Users/dev/.local/state/ws/claude/personal/projects/-Users-dev-proyecto/${evs[0]!.session}.jsonl`);
    expect(r.logs.filter((l) => l.includes("falló"))).toEqual([]);
  });

  it("cada permiso se cierra con /resolved", () => {
    expect([...ctrl.approvals.values()].map((a) => a.resolved)).toEqual([
      { by: "remote", decision: "deny" },
      { by: "remote", decision: "allow" },
    ]);
  });
});

describe("sesión real en auto mode", async () => {
  const { ctrl, opts } = setup('{"permissionMode":"default"}\n{"type":"permission-mode","permissionMode":"auto"}');
  const r = await replay(FIXTURE, opts);
  const evs = events(r.envelopes);

  it("no retiene nada: el humano decide como en la sesión original", () => {
    expect(ctrl.approvals.size).toBe(0);
    const decisions = evs.filter((e) => e.type === "permission.decision" && e.data.by !== "policy");
    expect(decisions.map((e) => [e.data.decision, e.data.by])).toEqual([
      ["deny", "user"],
      ["allow", "user"],
    ]);
  });
});
