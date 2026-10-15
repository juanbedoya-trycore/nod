import { describe, expect, it } from "vitest";
import { accountFor, claudeAccount } from "../src/core/account.js";

const claudeJson = (oauthAccount: unknown) => JSON.stringify({ numStartups: 3, oauthAccount });

describe("cuenta del perfil de Claude Code", () => {
  it("toma correo, nombre y organización de oauthAccount", () => {
    const a = claudeAccount(claudeJson({ emailAddress: "Ana.Ruiz@Acme.com", fullName: "Ana Ruiz", displayName: "Ana", organizationName: "Acme", accountUuid: "x" }));
    expect(a).toEqual({ email: "ana.ruiz@acme.com", name: "Ana Ruiz", org: "Acme" });
  });

  it("sin nombre completo usa el visible; sin organización no la pone", () => {
    expect(claudeAccount(claudeJson({ emailAddress: "ana@acme.com", displayName: "Ana" }))).toEqual({ email: "ana@acme.com", name: "Ana" });
  });

  it("sin sesión iniciada, sin correo o con JSON roto no hay cuenta", () => {
    expect(claudeAccount(JSON.stringify({ numStartups: 1 }))).toBeUndefined();
    expect(claudeAccount(claudeJson({ displayName: "Ana" }))).toBeUndefined();
    expect(claudeAccount(claudeJson(null))).toBeUndefined();
    expect(claudeAccount("{")).toBeUndefined();
  });

  it("la privacidad decide qué sale", () => {
    const a = { email: "ana@acme.com", name: "Ana Ruiz", org: "Acme" };
    expect(accountFor(a, "completo")).toEqual(a);
    expect(accountFor(a, "trabajo")).toEqual({ email: "ana@acme.com", org: "Acme" });
    const r = accountFor(a, "redactado");
    expect(r.email).toMatch(/^h-[0-9a-f]{8}$/);
    expect(r.org).toMatch(/^h-[0-9a-f]{8}$/);
    expect(r.name).toBeUndefined();
    expect(JSON.stringify(r)).not.toMatch(/ana|acme/i);
    // Estable: se puede agrupar por persona sin leerla.
    expect(accountFor(a, "redactado")).toEqual(r);
  });
});
