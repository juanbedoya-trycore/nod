import { describe, expect, it } from "vitest";
import { LINKS_PER_RESULT, WatchNotes, linksOf, profileOf, withContext } from "../src/core/links.js";

describe("linksOf", () => {
  it("Write → archivo con su nombre", () => {
    expect(linksOf("Write", { file_path: "/Users/x/Orbit/out/informe.html", content: "<h1>" }, "ok", false))
      .toEqual([{ kind: "file", name: "informe.html", path: "/Users/x/Orbit/out/informe.html" }]);
  });

  it("artifact de claude.ai y PR de GitHub en el texto del resultado", () => {
    const text = "Publicado: https://claude.ai/code/artifact/abc-123_x\nPR: https://github.com/juan/orbit/pull/42 y https://github.com/juan/orbit/issues/7";
    expect(linksOf("Bash", { command: "gh pr create" }, text, false)).toEqual([
      { kind: "link", name: "Artifact", url: "https://claude.ai/code/artifact/abc-123_x" },
      { kind: "link", name: "PR #42", url: "https://github.com/juan/orbit/pull/42" },
      { kind: "link", name: "Issue #7", url: "https://github.com/juan/orbit/issues/7" },
    ]);
  });

  it("Edit solo de documentos y archivos que genera Bash, con rutas relativas al cwd", () => {
    expect(linksOf("Edit", { file_path: "/r/docs/guia.md" }, "ok", false)).toEqual([{ kind: "file", name: "guia.md", path: "/r/docs/guia.md" }]);
    expect(linksOf("Edit", { file_path: "/r/src/app.ts" }, "ok", false)).toEqual([]);
    expect(linksOf("Bash", { command: "pandoc a.md -o out/informe.pdf && echo ok > /tmp/x.log" }, "", false, "/r")).toEqual([
      { kind: "file", name: "informe.pdf", path: "/r/out/informe.pdf" },
    ]);
    expect(linksOf("Bash", { command: "curl -s https://x --output='/tmp/grafico.png'; cat a >> notas.md" }, "", false, "/r")).toEqual([
      { kind: "file", name: "grafico.png", path: "/tmp/grafico.png" },
      { kind: "file", name: "notas.md", path: "/r/notas.md" },
    ]);
    expect(linksOf("Bash", { command: "echo x > ~/a.md" }, "", false, "/r")).toEqual([]);
    expect(linksOf("Bash", { command: "echo x > a.md" }, "", false)).toEqual([]);
  });

  it("sin repetidos, con tope y nada si la tool falló", () => {
    const many = Array.from({ length: 10 }, (_, i) => `https://github.com/a/b/pull/${i}`).join(" ");
    expect(linksOf("Bash", {}, many + " https://github.com/a/b/pull/0", false)).toHaveLength(LINKS_PER_RESULT);
    expect(linksOf("Write", { file_path: "/a/b.md" }, "https://github.com/a/b/pull/1", true)).toEqual([]);
    expect(linksOf("Read", { file_path: "/a/b.md" }, undefined, false)).toEqual([]);
  });
});

describe("profileOf", () => {
  it("nombre del perfil desde CLAUDE_CONFIG_DIR", () => {
    expect(profileOf("/Users/x/.local/state/ws/claude/trabajo")).toBe("trabajo");
    expect(profileOf("/Users/x/.claude/")).toBe("claude");
    expect(profileOf(undefined)).toBe("claude");
  });
});

describe("WatchNotes", () => {
  it("a mitad de turno sale como contexto; lo que queda, como prompt", () => {
    const n = new WatchNotes();
    expect(n.takeContext()).toBeUndefined();
    n.push("usa 4 workers");
    expect(n.takeContext()).toContain("usa 4 workers");
    expect(n.takeContext()).toBeUndefined();
    n.push("sí");
    n.push("y súbelo");
    expect(n.takePrompt()).toBe("sí\ny súbelo");
    expect(n.size).toBe(0);
  });

  it("withContext añade al context existente sin perder el resultado", () => {
    expect(withContext({ result: 1 }, "x")).toEqual({ result: 1, context: ["x"] });
    expect(withContext({ result: 1, context: "a" }, "x")).toEqual({ result: 1, context: ["a", "x"] });
    expect(withContext({ result: 1, context: ["a"] }, "x")).toEqual({ result: 1, context: ["a", "x"] });
    expect(withContext(undefined, "x")).toBeUndefined();
  });
});
