import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { Translator } from "../../src/core/translate.js";
import type { HookPayload } from "../../src/core/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROTOCOL = join(HERE, "../../protocol");
export const FIXTURES = join(PROTOCOL, "fixtures/raw/mod");

export interface RawLine {
  ts: number;
  event: string;
  data: Record<string, any>;
}

export function loadFixture(name: string): RawLine[] {
  return readFileSync(join(FIXTURES, `${name}.events.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RawLine);
}

export const FIXTURE_NAMES = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".events.jsonl"))
  .map((f) => f.replace(".events.jsonl", ""));

/**
 * Reproduce una línea del log del spike S1 contra el traductor como lo haría el plugin.
 * El spike añadió a mano `session_id` y `agent` a algunos eventos: se quitan para dejar el evento
 * del motor tal cual lo recibe el mod (y se usan solo como lo que `$.session.id()` y
 * `$.agent.list()` habrían devuelto).
 */
export function replay(lines: RawLine[], translator = new Translator()): HookPayload[] {
  const out: HookPayload[] = [];
  const sid = lines.map((l) => l.data.session_id ?? l.data.sessionId).find((s) => typeof s === "string") ?? "sess-test";
  for (const { event, data } of lines) {
    const { session_id: _s, agent, ...engine } = data;
    switch (event) {
      case "session.start":
        out.push(...translator.sessionStart(sid, engine));
        break;
      case "turn.start":
        out.push(...translator.turnStart(sid, engine));
        break;
      case "agent.spawn":
        out.push(...translator.agentSpawn(engine));
        break;
      case "tool.call":
        out.push(...translator.toolCall(sid, engine, agent ? { id: agent.id, type: agent.type, description: agent.description } : undefined));
        break;
      case "tool.check": {
        const { verdict, ...e } = engine;
        out.push(...translator.toolCheck(sid, e, verdict));
        break;
      }
      case "tool.call.result": {
        const { text, isError, deny, ...e } = engine;
        out.push(...translator.toolResult(sid, e, { text, isError, deny }));
        break;
      }
      case "turn.complete":
        out.push(...translator.turnComplete(sid, engine));
        break;
      case "session.end":
        out.push(...translator.sessionEnd(sid, engine));
        break;
      default:
        break; // prompt.submit, permission.*, etc.: no se emiten (SPEC §3.3)
    }
  }
  return out;
}

export function makeAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false, strictTuples: false });
  ajv.addKeyword("x-unverified");
  for (const n of ["hook-payload", "ingest"]) {
    ajv.addSchema(JSON.parse(readFileSync(join(PROTOCOL, `schema/${n}.schema.json`), "utf8")), `${n}.schema.json`);
  }
  return ajv;
}
