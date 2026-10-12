/**
 * La sesión interactiva real que capturó tools/probe (claude 2.1.296: un permiso negado, uno aprobado, un turno
 * interrumpido, un prompt sacado del historial y reescrito, un subagente y /exit), reproducida a través del
 * adaptador de Claude Code. Lo que sale debe ser Nod v1 válido y contar la sesión tal como fue.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import type { NodEvent } from "../src/core/events.js";
import { replay } from "./support/harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures/claude-2.1.296-interactiva.jsonl");
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(JSON.parse(readFileSync(join(HERE, "../schema/nod-v1.schema.json"), "utf8")));
const LOG = "/Users/dev/.local/state/nod/events.jsonl";

const events = (envs: { events: NodEvent[] }[]) => envs.flatMap((e) => e.events);
const ofType = (evs: NodEvent[], t: string) => evs.filter((e) => e.type === t);

describe("sesión interactiva real (claude 2.1.296)", async () => {
  const r = await replay(FIXTURE);
  const evs = events(r.envelopes);

  it("sin configuración escribe Nod v1 válido en el fichero por defecto", () => {
    expect([...r.files.keys()]).toEqual([LOG]);
    expect(r.envelopes.length).toBeGreaterThan(0);
    for (const env of r.envelopes) expect(validate(env), JSON.stringify(validate.errors)).toBe(true);
    const src = r.envelopes[0]!.source;
    expect(src).toMatchObject({ host: "claude", host_version: "2.1.296", machine: "mbp", profile: "personal", privacy: "completo" });
    // La instancia no lleva el nombre de la máquina: perfil + id aleatorio guardado en el almacén.
    expect(src.instance).toMatch(/^personal-[0-9a-f]{8}$/);
    expect(src.instance).toBe(`personal-${String(r.store.get("nod.id"))}`);
    expect(src.run).toMatch(/^[0-9a-f]{8}$/);
    expect(new Set(r.envelopes.map((e) => e.source.run)).size).toBe(1);
    expect(r.logs.filter((l) => l.includes("falló"))).toEqual([]);
  });

  it("seq empieza en 1, crece de uno en uno y todos los eventos son de la misma sesión", () => {
    const seqs = evs.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    expect(new Set(evs.map((e) => e.session))).toEqual(new Set(["6d4bbffb-b890-4286-a3a4-88446add6682"]));
  });

  it("la sesión empieza y termina", () => {
    expect(evs[0]!.type).toBe("session.start");
    expect(evs[0]!.data).toMatchObject({ interactive: true, surface: "terminal", model: "claude-haiku-5-5", cwd: "/Users/dev/proyecto" });
    expect(evs.at(-1)!.type).toBe("session.end");
    expect(Number(evs.at(-1)!.data.duration_ms)).toBeGreaterThan(100_000);
  });

  it("los dos permisos los decidió el humano: uno negado, otro aprobado, con su espera", () => {
    const asks = ofType(evs, "permission.request");
    expect(asks.map((e) => e.data.tool)).toEqual(["Bash", "Bash"]);
    const user = ofType(evs, "permission.decision").filter((e) => e.data.by === "user");
    expect(user.map((e) => e.data.decision)).toEqual(["deny", "allow"]);
    // Negado 19 786 ms después de preguntar. Aprobado: el fin de la tool (997 039) menos su ejecución (738 ms,
    // del hook clásico PostToolUse) menos la pregunta (995 066) = 1 235 ms exactos, sin contar la ejecución.
    expect(user[0]!.data).toMatchObject({ wait_ms: 19_786, exact: true });
    expect(user[1]!.data).toMatchObject({ wait_ms: 1_235, exact: true });
    const results = ofType(evs, "tool.result").filter((e) => e.data.tool === "Bash");
    expect(results.map((e) => [e.data.rejected, e.data.ok, e.data.duration_ms])).toEqual([[true, false, 0], [false, true, 738]]);
    // Antes de preguntar, otro mod retuvo el permiso 20 s: queda medido aparte.
    expect(ofType(evs, "permission.request").map((e) => Math.round(Number(e.data.check_ms) / 1000))).toEqual([20, 20]);
  });

  it("lo que el agente dejó pasar solo cuenta como policy", () => {
    const policy = ofType(evs, "permission.decision").filter((e) => e.data.by === "policy");
    expect(policy.map((e) => e.data.tool).sort()).toEqual(["Agent", "Read"]);
    for (const p of policy) expect(p.data).toMatchObject({ decision: "allow", wait_ms: 0 });
  });

  it("el turno interrumpido con Esc sale como aborted", () => {
    const ends = ofType(evs, "turn.end").filter((e) => e.agent === undefined);
    expect(ends.map((e) => e.data.outcome)).toContain("aborted");
  });

  it("el prompt sacado del historial y ampliado se marca como recalled", () => {
    const all = ofType(evs, "prompt.submit");
    // El sexto lo mete el propio agente al acabar el subagente en segundo plano: no es del humano.
    expect(all.map((p) => p.data.origin)).toEqual(["composer", "composer", "composer", "composer", "composer", "task-notification"]);
    const prompts = all.filter((p) => p.data.origin === "composer");
    // Lo tecleado para /exit no se cuela en el prompt que mete el agente.
    expect(all.at(-1)!.data.edit).toBeUndefined();
    const recalled = prompts.filter((p) => (p.data.edit as any)?.recalled === true);
    expect(recalled.map((p) => p.data.text)).toEqual(["Escribe un ensayo de 2000 palabras sobre la historia de los relojes, sin usar herramientas. Mejor solo 2 frases."]);
  });

  it("el subagente Explore: spawn, sus pasos y su fin con el costo acumulado", () => {
    const [spawn] = ofType(evs, "agent.spawn");
    // El modelo lo lanzó en segundo plano (la tool devolvió async_launched).
    expect(spawn!.data).toMatchObject({ agent: "aa0bd0fdb436e3ef4", type: "Explore", background: true });
    const end = ofType(evs, "agent.end").find((e) => e.agent === "aa0bd0fdb436e3ef4");
    expect(end).toBeDefined();
    expect((end!.data.usage as any).output).toBeGreaterThan(0);
    const read = ofType(evs, "tool.call").find((e) => e.data.tool === "Read")!;
    expect(read.agent).toBe("aa0bd0fdb436e3ef4");
    // Su turno se conoce desde el inicio del paso, antes de la tool.
    expect(read.turn).toBe("86375910-afde-4629-a83a-269bc215c6a2");
    expect(spawn!.turn).toBe("daad7bae-321c-458f-9438-ea1f1deca566");
    expect(spawn!.data).toMatchObject({ fork: false });
  });

  it("cada fin de turno principal trae contexto, límites de 5 h y 7 días y costo", () => {
    const u = ofType(evs, "usage");
    expect(u.length).toBeGreaterThan(0);
    // Cada snapshot es el de su momento: el contexto crece a lo largo de la sesión.
    const tokens = u.map((x) => (x.data.context as { tokens: number }).tokens);
    expect(new Set(tokens).size).toBeGreaterThan(1);
    expect(u.at(-1)!.data).toMatchObject({
      context: { window: 1_000_000 },
      limits: [{ kind: "five_hour", percent_used: 7 }, { kind: "seven_day", percent_used: 1 }],
    });
    expect(typeof u.at(-1)!.data.cost_usd).toBe("number");
  });

  it("el verbo del comando sale de la entrada de Bash", () => {
    const bash = ofType(evs, "tool.call").filter((e) => e.data.tool === "Bash");
    expect(bash.map((e) => e.data.verb)).toEqual(["touch", "touch"]);
  });

  it("/exit cuenta como comando", () => {
    expect(ofType(evs, "command").map((e) => e.data.name)).toContain("exit");
  });

  it("/nod resume la sesión", async () => {
    const text = await r.command("");
    expect(text).toMatch(/^observando/);
    expect(text).toContain("2 preguntados, 1 negados");
    expect(text).toMatch(/límite 5 h: 7% \(se renueva en /);
    expect(text).toContain(LOG);
  });
});

describe("privacidad", () => {
  it("redactado: sin texto, rutas, entradas de tools ni máquina", async () => {
    const r = await replay(FIXTURE, { env: { NOD_PRIVACY: "redactado" } });
    const all = JSON.stringify(r.envelopes);
    for (const env of r.envelopes) expect(validate(env), JSON.stringify(validate.errors)).toBe(true);
    expect(all).not.toContain("touch denegado.txt");
    expect(all).not.toContain("historia de los relojes");
    expect(all).not.toContain("/Users/dev/proyecto");
    expect(all).not.toContain('"machine"');
    // Lo útil para métricas sigue: tipos, verbos, tiempos y tokens.
    const evs = events(r.envelopes);
    expect(ofType(evs, "tool.call").filter((e) => e.data.tool === "Bash").map((e) => e.data.verb)).toEqual(["touch", "touch"]);
    expect(ofType(evs, "permission.decision").filter((e) => e.data.by === "user")).toHaveLength(2);
    expect(r.envelopes.every((e) => e.source.privacy === "redactado")).toBe(true);
  });

  it("trabajo: un destino que no es local no recibe nada; el fichero sí", async () => {
    const r = await replay(FIXTURE, { env: { NOD_PRIVACY: "trabajo", NOD_SINKS: "https://collector.example.com /Users/dev/nod.jsonl" } });
    expect(r.posts).toEqual([]);
    expect(r.envelopes.length).toBeGreaterThan(0);
    expect(await r.command("")).toContain("bloqueado por privacidad trabajo");
  });
});

describe("destino HTTP", () => {
  it("POST /v1/events con el token y todos los eventos en orden", async () => {
    const r = await replay(FIXTURE, { env: { NOD_SINKS: "http://127.0.0.1:8787/", NOD_TOKEN: "secreto" } });
    expect(r.files.size).toBe(0);
    expect(r.posts.length).toBeGreaterThan(0);
    expect(new Set(r.posts.map((p) => p.url))).toEqual(new Set(["http://127.0.0.1:8787/v1/events"]));
    expect(r.posts[0]!.headers.authorization).toBe("Bearer secreto");
    const evs = r.posts.flatMap((p) => p.body.events);
    expect(evs[0]!.type).toBe("session.start");
    expect(evs.at(-1)!.type).toBe("session.end");
  });

  it("si el destino no contesta, nada se pierde: queda en la cola persistente", async () => {
    const r = await replay(FIXTURE, { env: { NOD_SINKS: "http://127.0.0.1:8787" }, httpStatus: 503 });
    const saved = [...r.store.entries()].find(([k]) => k.startsWith("nod.outbox.") && !k.endsWith(".runs"));
    expect(saved).toBeDefined();
    const items = (saved![1] as { items: unknown[] }).items;
    expect(items.length).toBeGreaterThan(50);
    expect(await r.command("")).toMatch(/último error HTTP 503/);
  });
});

describe("configuración por fichero", () => {
  it("el perfil del fichero manda sobre lo general", async () => {
    const configFile = JSON.stringify({ sinks: ["/Users/dev/general.jsonl"], profiles: { personal: { sinks: [{ file: "~/perfil.jsonl" }], privacy: "redactado" } } });
    const r = await replay(FIXTURE, { configFile });
    expect([...r.files.keys()]).toEqual(["/Users/dev/perfil.jsonl"]);
    expect(r.envelopes[0]!.source.privacy).toBe("redactado");
  });
});
