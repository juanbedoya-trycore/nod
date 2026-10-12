import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/core/config.js";

const ok = { url: "http://100.64.0.1:8787/", token: "t0k", instanceId: "mac-personal", ctx: "personal" };

describe("parseConfig", () => {
  it("acepta una configuración completa y quita la barra final de la URL", () => {
    const r = parseConfig(ok);
    expect(r).toEqual({ ok: true, config: { url: "http://100.64.0.1:8787", token: "t0k", instanceId: "mac-personal", ctx: "personal" } });
  });

  it("lista todos los errores cuando falta todo", () => {
    const r = parseConfig({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(4);
  });

  it("no asume ctx: sin ORBIT_CTX no se envía nada", () => {
    const r = parseConfig({ ...ok, ctx: undefined });
    expect(r.ok).toBe(false);
  });

  it.each([["Mac"], ["-x"], ["a".repeat(33)], ["con espacio"]])("rechaza instance_id %s", (instanceId) => {
    expect(parseConfig({ ...ok, instanceId }).ok).toBe(false);
  });

  it("rechaza ctx desconocido y URL sin esquema", () => {
    expect(parseConfig({ ...ok, ctx: "otro" }).ok).toBe(false);
    expect(parseConfig({ ...ok, url: "100.64.0.1:8787" }).ok).toBe(false);
  });
});

import { parseOrbitArgs } from "../src/core/command.js";

describe("/nod away y back", () => {
  it("se reconocen como acciones", () => {
    expect(parseOrbitArgs("away")).toBe("away");
    expect(parseOrbitArgs(" BACK ")).toBe("back");
    expect(parseOrbitArgs("lejos")).toBe("invalid");
  });
});

import { effectiveCtx } from "../src/core/types.js";
import { applyAllowlist } from "../src/core/allowlist.js";

describe("/nod privacidad", () => {
  it("se reconoce en español y en inglés", () => {
    expect(parseOrbitArgs("privacidad")).toBe("privacy");
    expect(parseOrbitArgs("privacidad metadatos")).toBe("privacy-metadata");
    expect(parseOrbitArgs("privacy full")).toBe("privacy-full");
    expect(parseOrbitArgs("privacidad todo")).toBe("invalid");
  });

  it("metadatos filtra como ctx=work aunque la instancia sea personal", () => {
    expect(effectiveCtx({ ctx: "personal" })).toBe("personal");
    expect(effectiveCtx({ ctx: "personal", privacy: "completa" })).toBe("personal");
    expect(effectiveCtx({ ctx: "personal", privacy: "metadatos" })).toBe("work");
    expect(effectiveCtx({ ctx: "work", privacy: "completa" })).toBe("work");
    const ev = { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "texto secreto del cliente", cwd: "/Users/x/cliente" };
    const out = applyAllowlist(ev as never, effectiveCtx({ ctx: "personal", privacy: "metadatos" }));
    expect(JSON.stringify(out)).not.toContain("secreto");
    expect(JSON.stringify(out)).not.toContain("cliente");
  });
});
