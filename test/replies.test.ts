import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPLIES, REPLIES_MAX, REPLY_MAX_BYTES, applyRepliesCommand, cleanReplies, parseRepliesCommand, readReplies, replyProblem, writeReplies,
} from "../src/core/replies.js";

describe("respuestas rápidas (§6.6.1)", () => {
  it("por defecto, en español y dentro de los límites", () => {
    expect(DEFAULT_REPLIES).toEqual(["Continúa", "Sí", "No", "Resume en qué estás", "Prueba otra forma"]);
    expect(cleanReplies(DEFAULT_REPLIES)).toEqual([...DEFAULT_REPLIES]);
  });

  it("valida cada respuesta", () => {
    expect(replyProblem("  ")).toBe("está vacía");
    expect(replyProblem("ñ".repeat(33))).toMatch(`${REPLY_MAX_BYTES} bytes`);
    expect(replyProblem("a\nb")).toMatch(/control/);
    expect(replyProblem("Haz los tests")).toBeUndefined();
  });

  it("sanea: recorta, sin repetidas ni inválidas, como mucho 8", () => {
    expect(cleanReplies([" Sí ", "Sí", "", 3, "a\u0007"])).toEqual(["Sí"]);
    expect(cleanReplies(Array.from({ length: 20 }, (_, i) => `r${i}`))).toHaveLength(REPLIES_MAX);
  });

  it("lee lo guardado como objeto o texto JSON", () => {
    expect(readReplies(undefined)).toBeUndefined();
    expect(readReplies("no es json")).toBeUndefined();
    expect(readReplies({ v: 1, replies: ["Sí", "No"] })).toEqual(["Sí", "No"]);
    expect(readReplies(JSON.stringify(writeReplies(["Vale"])))).toEqual(["Vale"]);
  });

  it("interpreta /nod respuestas", () => {
    expect(parseRepliesCommand("status")).toBeUndefined();
    expect(parseRepliesCommand("respuestas")).toEqual({ kind: "list" });
    expect(parseRepliesCommand("replies list")).toEqual({ kind: "list" });
    expect(parseRepliesCommand("respuestas añadir Haz commit")).toEqual({ kind: "add", text: "Haz commit" });
    expect(parseRepliesCommand('respuestas add "Sí, sigue"')).toEqual({ kind: "add", text: "Sí, sigue" });
    expect(parseRepliesCommand("respuestas quitar 2")).toEqual({ kind: "remove", index: 2 });
    expect(parseRepliesCommand("respuestas restablecer")).toEqual({ kind: "reset" });
    expect(parseRepliesCommand("respuestas añadir " + "x".repeat(65))).toMatchObject({ kind: "invalid" });
    expect(parseRepliesCommand("respuestas bailar")).toMatchObject({ kind: "invalid" });
  });

  it("aplica los cambios sobre la lista configurada o la de por defecto", () => {
    const add = applyRepliesCommand(undefined, { kind: "add", text: "Haz commit" });
    expect(add.changed).toBe(true);
    expect(add.list).toEqual([...DEFAULT_REPLIES, "Haz commit"]);
    expect(add.message).toMatch("Detente y resume");
    const rm = applyRepliesCommand(add.list, { kind: "remove", index: 1 });
    expect(rm.list[0]).toBe("Sí");
    expect(applyRepliesCommand(rm.list, { kind: "remove", index: 99 }).changed).toBe(false);
    expect(applyRepliesCommand(["Sí"], { kind: "add", text: "Sí" }).changed).toBe(false);
    const full = Array.from({ length: REPLIES_MAX }, (_, i) => `r${i}`);
    expect(applyRepliesCommand(full, { kind: "add", text: "otra" }).changed).toBe(false);
    expect(applyRepliesCommand(["x"], { kind: "reset" }).list).toEqual([...DEFAULT_REPLIES]);
    expect(applyRepliesCommand(undefined, { kind: "list" }).message).toMatch("las de por defecto");
  });
});
