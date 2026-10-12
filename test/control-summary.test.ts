/** Lo que ve el aprobador (resumen) según la privacidad, y lo que nunca puede aprobar (wok). */
import { describe, expect, it } from "vitest";
import { approvable, DEFAULT_FORBIDDEN, forbiddenRules } from "../src/core/control/forbidden.js";
import { SUMMARY_MAX_BYTES, redactSecrets, summarize } from "../src/core/control/summary.js";

describe("resumen", () => {
  it("completo: comando, ruta o entrada en JSON", () => {
    expect(summarize("completo", "Bash", { command: "npm test -- --run" })).toEqual({ summary: "npm test -- --run", exact: true });
    expect(summarize("completo", "Edit", { file_path: "/repo/src/a.ts", old_string: "x", new_string: "y" })).toEqual({ summary: "/repo/src/a.ts", exact: true });
    expect(summarize("completo", "mcp__jira__search", { q: "ABC" })).toEqual({ summary: '{"q":"ABC"}', exact: true });
  });

  it("redactado y trabajo: solo el verbo (ni argumentos, ni rutas, ni el cliente)", () => {
    for (const p of ["redactado", "trabajo"] as const) {
      expect(summarize(p, "Bash", { command: "FOO=1 psql postgres://acme:secreto@db/acme -c 'drop table x'" })).toEqual({ summary: "psql", exact: true });
      expect(summarize(p, "Bash", { command: "./deploy-acme.sh prod" }).summary).toBe("Bash");
      expect(summarize(p, "Edit", { file_path: "/clientes/acme/contrato.md" }).summary).toBe("Edit");
    }
    expect(summarize("redactado", "mcp__acme-jira__search", { q: "x" }, "mcp__h-1234abcd__search").summary).toBe("mcp__h-1234abcd__search");
  });

  it("completo con un secreto: se oculta y el resumen deja de ser exacto (wok false)", () => {
    const s = summarize("completo", "Bash", { command: "curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwx' https://api" });
    expect(s.summary).not.toContain("sk-abc");
    expect(s.exact).toBe(false);
    expect(redactSecrets("export GITHUB_TOKEN=ghp_0123456789abcdef0123")).toBe("export GITHUB_TOKEN=***");
  });

  it("cortado a 1000 bytes sin partir caracteres; invisibles → no exacto", () => {
    const long = summarize("completo", "Bash", { command: `echo ${"ñ".repeat(800)}` });
    expect(new TextEncoder().encode(long.summary).length).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
    expect(long.summary.endsWith("ñ")).toBe(true);
    expect(long.exact).toBe(false);
    expect(summarize("completo", "Bash", { command: "ls‮.txt" }).exact).toBe(false);
  });
});

describe("lista prohibida", () => {
  const rules = DEFAULT_FORBIDDEN;
  it("marca lo destructivo aunque se disfrace", () => {
    for (const c of ["rm -rf build", "rm -r -f x", "\\rm -fr x", "r\\m --recur --forc x", "git push --force origin main", "git push origin +main", "kubectl delete pod x", "terraform apply", "npm publish", "ls; rm -Rf /tmp/x"]) {
      expect(approvable("Bash", { command: c }, rules), c).toBe(false);
    }
  });

  it("deja lo normal", () => {
    for (const c of ["rm x.txt", "git push origin main", "npm test", "kubectl get pods"]) {
      expect(approvable("Bash", { command: c }, rules), c).toBe(true);
    }
  });

  it("NOD_FORBIDDEN_ADD amplía la lista; una regex mala la invalida entera", () => {
    const r = forbiddenRules('["^make deploy"]');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(approvable("Bash", { command: "make deploy" }, r.rules)).toBe(false);
      expect(approvable("Bash", { command: "rm -rf x" }, r.rules)).toBe(false);
    }
    expect(forbiddenRules('["("]').ok).toBe(false);
    expect(forbiddenRules("no es json").ok).toBe(false);
    expect(forbiddenRules(undefined)).toEqual({ ok: true, rules: [...DEFAULT_FORBIDDEN] });
  });

  it("otras tools: sobre la entrada serializada", () => {
    expect(approvable("mcp__k8s__run", { cmd: "kubectl delete ns prod" }, rules)).toBe(false);
  });
});
