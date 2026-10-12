import { describe, expect, it } from "vitest";
import { holdsInMode, lastMode, modeGrepArgs, projectSlug, transcriptPath } from "../src/core/perm/mode.js";

describe("modo de permisos desde la transcripción", () => {
  it("carpeta del proyecto como la escribe Claude Code", () => {
    expect(projectSlug("/Users/juan/Documents/GitHub/Orbit")).toBe("-Users-juan-Documents-GitHub-Orbit");
    expect(projectSlug("/private/tmp")).toBe("-private-tmp");
    expect(projectSlug("/private/tmp/claude-501/-Users-x/scratchpad")).toBe("-private-tmp-claude-501--Users-x-scratchpad");
    expect(transcriptPath("/Users/juan/.claude/", "/private/tmp", "abc")).toBe("/Users/juan/.claude/projects/-private-tmp/abc.jsonl");
    expect(modeGrepArgs("/a b.jsonl")).toEqual(["/usr/bin/grep", "-o", '"permissionMode":"[A-Za-z]*"', "/a b.jsonl"]);
  });

  it("el último modo gana (un cambio con shift+tab añade una entrada)", () => {
    expect(lastMode('"permissionMode":"default"\n"permissionMode":"auto"\n')).toBe("auto");
    expect(lastMode('"permissionMode":"auto"\n"permissionMode":"acceptEdits"\n')).toBe("acceptEdits");
    expect(lastMode("")).toBeUndefined();
    expect(lastMode(undefined)).toBeUndefined();
  });

  it("solo auto mode deja de retener (sin dato, se retiene como siempre)", () => {
    expect(holdsInMode("auto")).toBe(false);
    for (const m of ["default", "acceptEdits", "plan", undefined]) expect(holdsInMode(m)).toBe(true);
  });
});
