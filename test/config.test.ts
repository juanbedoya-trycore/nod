import { describe, expect, it } from "vitest";
import { controlBlocked, defaultInstance, loadTokenFiles, parseSink, resolveConfig } from "../src/core/config.js";
import { applyPrivacy, sinkAllowed } from "../src/core/privacy.js";
import type { Draft } from "../src/core/events.js";

const HOME = { HOME: "/Users/dev" };

describe("resolveConfig", () => {
  it("sin nada: fichero local, privacidad completo, instancia perfil-id (sin el nombre de la máquina)", () => {
    const { config, warnings } = resolveConfig(HOME, undefined, "personal", "3fa9c2d1");
    expect(config).toMatchObject({ enabled: true, privacy: "completo", instance: "personal-3fa9c2d1", source: "valores por defecto" });
    expect(config.sinks).toEqual([{ kind: "file", target: "/Users/dev/.local/state/nod/events.jsonl" }]);
    expect(warnings).toEqual([]);
  });

  it("XDG_STATE_HOME cambia el fichero por defecto", () => {
    expect(resolveConfig({ ...HOME, XDG_STATE_HOME: "/s" }, undefined, "p", "m").config.sinks[0]!.target).toBe("/s/nod/events.jsonl");
  });

  it("variables > perfil > general", () => {
    const file = JSON.stringify({ privacy: "redactado", sinks: ["http://general:1"], profiles: { trabajo: { privacy: "trabajo", sinks: [{ url: "http://127.0.0.1:2", token: "t" }] } } });
    expect(resolveConfig(HOME, file, "personal", "m").config).toMatchObject({ privacy: "redactado", sinks: [{ kind: "http", target: "http://general:1" }] });
    expect(resolveConfig(HOME, file, "trabajo", "m").config).toMatchObject({ privacy: "trabajo", sinks: [{ kind: "http", target: "http://127.0.0.1:2", token: "t" }] });
    const env = resolveConfig({ ...HOME, NOD_PRIVACY: "completo", NOD_SINKS: "~/x.jsonl, https://c.example/" }, file, "trabajo", "m").config;
    expect(env).toMatchObject({ privacy: "completo", source: "variables NOD_*" });
    expect(env.sinks).toEqual([{ kind: "file", target: "/Users/dev/x.jsonl" }, { kind: "http", target: "https://c.example", token: undefined }]);
  });

  it("NOD_TOKEN: solo para los destinos de NOD_SINKS, y nunca por http en claro fuera de la máquina", () => {
    const { config, warnings } = resolveConfig({ ...HOME, NOD_TOKEN: "comun", NOD_SINKS: "https://a.example http://b.example http://127.0.0.1:9" }, undefined, "p", "m");
    expect(config.sinks.map((s) => s.token)).toEqual(["comun", undefined, "comun"]);
    expect(warnings.join()).toContain("NOD_TOKEN no se manda a http://b.example");
    // Los destinos del fichero no heredan el token del entorno.
    const file = JSON.stringify({ sinks: [{ url: "https://tercero.example" }, { url: "https://b:1", token: "propio" }] });
    expect(resolveConfig({ ...HOME, NOD_TOKEN: "comun" }, file, "p", "m").config.sinks.map((s) => s.token)).toEqual([undefined, "propio"]);
  });

  it("una URL con credenciales o parámetros se rechaza sin repetirlos", () => {
    const { config, warnings } = resolveConfig({ ...HOME, NOD_SINKS: "https://user:S3cr3t@c.example/?token=abc" }, undefined, "p", "m");
    expect(config.sinks).toEqual([]);
    expect(warnings.join()).not.toMatch(/S3cr3t|abc/);
    expect(warnings.join()).toContain("https://c.example ignorado");
  });

  it("valores inválidos: avisa y sigue con lo válido", () => {
    const { config, warnings } = resolveConfig({ ...HOME, NOD_PRIVACY: "total", NOD_INSTANCE: "Mi Mac", NOD_SINKS: "relativo.jsonl" }, "{no json", "p", "m");
    expect(config.privacy).toBe("completo");
    expect(config.instance).toBe("p-m");
    expect(config.sinks).toEqual([]);
    expect(warnings.join("\n")).toMatch(/JSON inválido[\s\S]*destino inválido[\s\S]*privacidad "total"[\s\S]*instancia "Mi Mac"/);
  });

  it("NOD_OFF=1 desactiva y NOD_TASK fija la tarea", () => {
    expect(resolveConfig({ ...HOME, NOD_OFF: "1", NOD_TASK: " ABC-1 " }, undefined, "p", "m").config).toMatchObject({ enabled: false, task: "ABC-1" });
  });

  it("parseSink", () => {
    expect(parseSink("file:///tmp/a.jsonl", undefined)).toEqual({ kind: "file", target: "/tmp/a.jsonl" });
    expect(typeof parseSink("ftp://x", undefined)).toBe("string");
  });

  it("defaultInstance limpia y acota", () => {
    expect(defaultInstance(".claude", "3fa9c2d1")).toBe("claude-3fa9c2d1");
    expect(defaultInstance("a".repeat(80), "3fa9c2d1")).toHaveLength(64);
  });
});

describe("privacidad", () => {
  const d: Draft = { ts: 0, type: "session.start", session: "s", data: { cwd: "/Users/dev/x", repo: { root: "/Users/dev/x", remote: "git@cliente:repo", name: "repo" }, interactive: true } };

  it("completo no toca nada", () => {
    expect(applyPrivacy(d, "completo")).toBe(d);
  });

  it("redactado quita rutas y remoto, deja el nombre del repo", () => {
    expect(applyPrivacy(d, "redactado").data).toEqual({ repo: { name: "repo" }, interactive: true });
    expect(d.data.cwd).toBe("/Users/dev/x");
  });

  it("el reason del permiso es texto libre; el de session.end no", () => {
    expect(applyPrivacy({ ts: 0, type: "permission.request", session: "s", data: { tool: "Bash", reason: "touch /Users/dev/x" } }, "trabajo").data).toEqual({ tool: "Bash" });
    expect(applyPrivacy({ ts: 0, type: "session.end", session: "s", data: { reason: "exit", duration_ms: 1 } }, "trabajo").data).toEqual({ reason: "exit", duration_ms: 1 });
  });

  it("trabajo solo deja destinos locales", () => {
    expect(sinkAllowed("trabajo", { kind: "file", target: "/x" })).toBe(true);
    expect(sinkAllowed("trabajo", { kind: "http", target: "http://127.0.0.1:9" })).toBe(true);
    expect(sinkAllowed("trabajo", { kind: "http", target: "http://[::1]:9" })).toBe(true);
    expect(sinkAllowed("trabajo", { kind: "http", target: "https://collector.example" })).toBe(false);
    expect(sinkAllowed("redactado", { kind: "http", target: "https://collector.example" })).toBe(true);
  });
});

describe("redactado: identificadores con hash", () => {
  it("tarea, comandos y subagentes propios y servidores MCP; trabajo los deja legibles", () => {
    const base = { ts: 0, session: "s", task: "ACME-PAYROLL-77" };
    const red = (type: string, data: Record<string, unknown>) => applyPrivacy({ ...base, type: type as never, data }, "redactado");
    expect(red("turn.start", {}).task).toMatch(/^h-[0-9a-f]{8}$/);
    expect(red("command", { name: "acme-release" }).data.name).toMatch(/^h-/);
    expect(red("command", { name: "compact" }).data.name).toBe("compact");
    expect(red("agent.spawn", { type: "acme-auditor", agent: "a" }).data.type).toMatch(/^h-/);
    expect(red("agent.spawn", { type: "Explore", agent: "a" }).data.type).toBe("Explore");
    expect(red("tool.call", { tool: "mcp__acme-jira__search" }).data.tool).toMatch(/^mcp__h-[0-9a-f]{8}__search$/);
    expect(red("turn.step", { tools: ["Read", "mcp__acme-jira__search"] }).data.tools).toEqual(["Read", expect.stringMatching(/^mcp__h-/)]);
    expect(applyPrivacy({ ...base, type: "turn.start", data: {} }, "trabajo").task).toBe("ACME-PAYROLL-77");
  });
});

describe("token_file", () => {
  const files: Record<string, string> = { "/Users/dev/.config/nod/collector.token": "secreto-sink\n", "/Users/dev/.config/nod/control.token": "  secreto-control  \n", "/vacio": "\n" };
  const read = async (path: string) => {
    if (path in files) return files[path]!;
    throw new Error(`ENOENT ${path}`);
  };

  it("destinos HTTP: el token sale del fichero (con ~), nunca del texto de la configuración", async () => {
    const file = JSON.stringify({ sinks: [{ url: "https://c.example", token_file: "~/.config/nod/collector.token" }, { url: "https://d.example", token: "propio", token_file: "/vacio" }, { file: "/x.jsonl", token_file: "/vacio" }] });
    const { config, warnings } = resolveConfig(HOME, file, "p", "m");
    expect(config.sinks[0]).toEqual({ kind: "http", target: "https://c.example", token: undefined, tokenFile: "/Users/dev/.config/nod/collector.token" });
    expect(warnings.join()).toContain('tiene "token" y "token_file": uso "token"');
    await loadTokenFiles(config, read, warnings);
    expect(config.sinks.map((s) => s.token)).toEqual(["secreto-sink", "propio", undefined]);
  });

  it("un token_file que no se lee: el destino queda sin token y se avisa", async () => {
    const { config, warnings } = resolveConfig(HOME, JSON.stringify({ sinks: [{ url: "https://c.example", token_file: "/no/existe" }] }), "p", "m");
    await loadTokenFiles(config, read, warnings);
    expect(config.sinks[0]!.token).toBeUndefined();
    expect(warnings).toContain("token_file /no/existe no se puede leer");
  });
});

describe("control", () => {
  const file = (control: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ control, ...extra });

  it("sin configurar no hay canal", () => {
    expect(resolveConfig(HOME, undefined, "p", "m").config.control).toBeUndefined();
    expect(controlBlocked(undefined, "completo")).toBe("sin configurar");
  });

  it("del fichero: url sin barra final, token_file y hold_ms; por defecto 20 s", async () => {
    const { config, warnings } = resolveConfig(HOME, file({ url: "http://127.0.0.1:7878/", token_file: "~/.config/nod/control.token" }), "p", "m");
    expect(config.control).toEqual({ url: "http://127.0.0.1:7878", tokenFile: "/Users/dev/.config/nod/control.token", holdMs: 20_000 });
    await loadTokenFiles(config, async () => " t0k \n", warnings);
    expect(config.control!.token).toBe("t0k");
    expect(controlBlocked(config.control, "completo")).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("hold_ms fuera de 1000…90000 se ajusta con aviso", () => {
    const hi = resolveConfig(HOME, file({ url: "https://c.example", hold_ms: 500_000 }), "p", "m");
    expect(hi.config.control!.holdMs).toBe(90_000);
    expect(hi.warnings.join()).toContain("entre 1000 y 90000");
    expect(resolveConfig(HOME, file({ url: "https://c.example", hold_ms: 10 }), "p", "m").config.control!.holdMs).toBe(1_000);
    expect(resolveConfig(HOME, file({ url: "https://c.example", hold_ms: 45_000 }), "p", "m").config.control!.holdMs).toBe(45_000);
  });

  it("variables: NOD_CONTROL y NOD_CONTROL_TOKEN mandan; NOD_CONTROL=off lo apaga", () => {
    const env = { ...HOME, NOD_CONTROL: "https://ctl.example", NOD_CONTROL_TOKEN: "envtok" };
    expect(resolveConfig(env, file({ url: "http://127.0.0.1:1", token: "f", hold_ms: 5000 }), "p", "m").config.control).toEqual({ url: "https://ctl.example", token: "envtok", holdMs: 5000 });
    expect(resolveConfig({ ...HOME, NOD_CONTROL: "off" }, file({ url: "http://127.0.0.1:1" }), "p", "m").config.control).toBeUndefined();
  });

  it("por perfil, como el resto", () => {
    const f = file({ url: "https://general.example" }, { profiles: { trabajo: { control: { url: "http://localhost:7878", hold_ms: 30000 } } } });
    expect(resolveConfig(HOME, f, "trabajo", "m").config.control).toEqual({ url: "http://localhost:7878", holdMs: 30_000 });
    expect(resolveConfig(HOME, f, "personal", "m").config.control!.url).toBe("https://general.example");
  });

  it("URL con credenciales o parámetros: no hay canal", () => {
    const { config, warnings } = resolveConfig(HOME, file({ url: "https://u:p@c.example/?t=1" }), "p", "m");
    expect(config.control).toBeUndefined();
    expect(warnings.join()).toContain("el controlador debe ser una URL");
  });

  it("el token no viaja en claro a un controlador remoto: canal apagado", () => {
    const c = resolveConfig(HOME, file({ url: "http://homelab:7878", token: "t" }), "p", "m").config.control;
    expect(controlBlocked(c, "completo")).toBe("el token no se manda en claro a http://homelab:7878 (usa https)");
    expect(controlBlocked(resolveConfig(HOME, file({ url: "http://homelab:7878" }), "p", "m").config.control, "completo")).toBeUndefined();
  });

  it("privacidad trabajo con un controlador que no es local: desactivado; local, activo", () => {
    const remote = resolveConfig(HOME, file({ url: "https://ctl.example" }), "p", "m").config.control;
    const local = resolveConfig(HOME, file({ url: "http://127.0.0.1:7878" }), "p", "m").config.control;
    expect(controlBlocked(remote, "trabajo")).toBe("privacidad trabajo y el controlador no es local");
    expect(controlBlocked(remote, "redactado")).toBeUndefined();
    expect(controlBlocked(local, "trabajo")).toBeUndefined();
  });

  it("token_file del controlador que no se lee: canal apagado", async () => {
    const { config, warnings } = resolveConfig(HOME, file({ url: "https://ctl.example", token_file: "/no/existe" }), "p", "m");
    await loadTokenFiles(config, async () => {
      throw new Error("ENOENT");
    }, warnings);
    expect(controlBlocked(config.control, "completo")).toBe("no se pudo leer el token (/no/existe)");
  });
});
