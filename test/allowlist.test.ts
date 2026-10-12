import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORK_ALLOWLIST, applyAllowlist } from "../src/core/allowlist.js";
import type { HookPayload } from "../src/core/types.js";
import { FIXTURE_NAMES, PROTOCOL, loadFixture, makeAjv, replay } from "./support/fixtures.js";

describe("lista blanca ctx=work (SPEC §3.4)", () => {
  it("coincide exactamente con ingest.schema.json#/$defs/workAllowlist", () => {
    const schema = JSON.parse(readFileSync(join(PROTOCOL, "schema/ingest.schema.json"), "utf8"));
    expect([...WORK_ALLOWLIST].sort()).toEqual([...schema.$defs.workAllowlist.propertyNames.enum].sort());
  });

  it("elimina todo lo sensible, también campos desconocidos de versiones futuras", () => {
    const ev = {
      session_id: "s", hook_event_name: "Stop", turn_id: "t", is_aborted: false,
      prompt: "secreto", tool_input: { command: "ls" }, tool_response: "x", last_assistant_message: "hola",
      cwd: "/Users/x", transcript_path: "/t", permission_reason: "r", usage: { input_tokens: 1 }, campo_futuro: 1,
    } as HookPayload;
    expect(applyAllowlist(ev, "work")).toEqual({ session_id: "s", hook_event_name: "Stop", turn_id: "t", is_aborted: false });
  });

  it("ctx=personal no toca el evento", () => {
    const ev = { session_id: "s", hook_event_name: "UserPromptSubmit", prompt: "hola" } as HookPayload;
    expect(applyAllowlist(ev, "personal")).toBe(ev);
  });

  it("no muta la entrada", () => {
    const ev = { session_id: "s", hook_event_name: "UserPromptSubmit", prompt: "hola" } as HookPayload;
    applyAllowlist(ev, "work");
    expect(ev.prompt).toBe("hola");
  });

  it("reason solo en SessionEnd y cortada a 32 code points", () => {
    const end = applyAllowlist({ session_id: "s", hook_event_name: "SessionEnd", reason: "😀".repeat(40) }, "work");
    expect(Array.from(end.reason as string)).toHaveLength(32);
    const other = applyAllowlist({ session_id: "s", hook_event_name: "PermissionRequest", reason: "x" }, "work");
    expect("reason" in other).toBe(false);
  });

  it("source:mod de SessionStart sobrevive; cwd no", () => {
    const r = applyAllowlist({ session_id: "s", hook_event_name: "SessionStart", source: "mod", cwd: "/x" }, "work");
    expect(r).toEqual({ session_id: "s", hook_event_name: "SessionStart", source: "mod" });
  });

  it("todo lo que sale de los fixtures con ctx=work valida contra workAllowlist", () => {
    const ajv = makeAjv();
    const v = ajv.getSchema("ingest.schema.json#/$defs/workAllowlist")!;
    for (const name of FIXTURE_NAMES) {
      for (const ev of replay(loadFixture(name))) {
        const w = applyAllowlist(ev, "work");
        expect(v(w), `${name}/${ev.hook_event_name}: ${JSON.stringify(v.errors)}`).toBe(true);
        expect(JSON.stringify(w)).not.toMatch(/mcp__echo__echo.*from-main|touch /);
      }
    }
  });
});
