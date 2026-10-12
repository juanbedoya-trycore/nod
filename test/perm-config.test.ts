// Configuración de la retención (ORBIT_PERM, ORBIT_PERM_HOLD_MS, ORBIT_FORBIDDEN, ORBIT_FORBIDDEN_ADD).
import { describe, expect, it } from "vitest";
import { parsePermConfig } from "../src/core/config.js";
import { DEFAULT_FORBIDDEN, matchForbidden } from "../src/core/perm/forbidden.js";

describe("parsePermConfig", () => {
  it("por defecto: activa, 90 s y la lista por defecto", () => {
    const r = parsePermConfig({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.perm.enabled).toBe(true);
      expect(r.perm.holdMs).toBe(20_000);
      expect(r.perm.forbidden.map((x) => x.name)).toEqual(DEFAULT_FORBIDDEN.map((x) => x.name));
    }
  });

  it("ORBIT_PERM=off desactiva; un valor raro es error", () => {
    const r = parsePermConfig({ enabled: "off" });
    expect(r.ok && r.perm.enabled).toBe(false);
    expect(parsePermConfig({ enabled: "quizá" }).ok).toBe(false);
  });

  it("ORBIT_PERM_HOLD_MS entre 1000 y 90000", () => {
    const r = parsePermConfig({ holdMs: "5000" });
    expect(r.ok && r.perm.holdMs).toBe(5000);
    expect(parsePermConfig({ holdMs: "999" }).ok).toBe(false);
    expect(parsePermConfig({ holdMs: "90001" }).ok).toBe(false);
    expect(parsePermConfig({ holdMs: "abc" }).ok).toBe(false);
  });

  it("ORBIT_FORBIDDEN sustituye y ORBIT_FORBIDDEN_ADD amplía", () => {
    const rep = parsePermConfig({ forbidden: '["^docker push"]' });
    expect(rep.ok).toBe(true);
    if (rep.ok) {
      expect(matchForbidden("docker push x", rep.perm.forbidden)).toBeDefined();
      expect(matchForbidden("rm -rf x", rep.perm.forbidden)).toBeUndefined();
    }
    const add = parsePermConfig({ forbiddenAdd: '["^docker push"]' });
    expect(add.ok).toBe(true);
    if (add.ok) {
      expect(matchForbidden("docker push x", add.perm.forbidden)).toBeDefined();
      expect(matchForbidden("rm -rf x", add.perm.forbidden)).toBe("rm-rf");
    }
  });

  it("una regex inválida o un JSON roto es error (la retención se desactiva)", () => {
    expect(parsePermConfig({ forbidden: '["("]' }).ok).toBe(false);
    expect(parsePermConfig({ forbiddenAdd: "rm" }).ok).toBe(false);
    expect(parsePermConfig({ forbiddenAdd: "[1]" }).ok).toBe(false);
  });
});
