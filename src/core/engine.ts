// Nod, sin el agente: recibe lo que pasa en la sesión (ya en nombres neutros), lo normaliza a Nod v1, aplica
// la privacidad, lo numera y lo entrega a cada destino. Cada adaptador (hosts/claude, …) llama a estos métodos
// con su Platform. Los métodos públicos nunca lanzan: un fallo de Nod no puede romper la sesión.
import { resolveConfig, configPath } from "./config.js";
import type { Config } from "./config.js";
import { Counter } from "./counter.js";
import type { CounterState } from "./counter.js";
import { PRIVACY_LEVELS } from "./events.js";
import type { Draft, NodEvent, Privacy, Source, Usage } from "./events.js";
import { Normalizer } from "./normalize.js";
import type { CheckDecision, PromptEdit, SessionInfo, StepInfo, ToolCallInfo, ToolResultInfo, TurnEndInfo, UsageSnapshot } from "./normalize.js";
import { Outbox } from "./outbox.js";
import type { Transport } from "./outbox.js";
import { applyPrivacy, sinkAllowed } from "./privacy.js";
import type { HostInfo, Platform, Timer } from "./platform.js";

export const COMMAND_DESCRIPTION = "Nod: estado de la sesión y de los destinos; /nod tarea <id>, /nod privacidad, /nod pausa, /nod reanuda";

const KEYS = {
  counter: (instance: string) => `nod.seq.${instance}`,
  paused: "nod.paused",
  privacy: "nod.privacy",
} as const;

/** Tipos que se entregan sin esperar a la ventana del lote. */
const URGENT = new Set(["turn.end", "session.end", "permission.request", "agent.end"]);

export const USAGE = [
  "uso: /nod [estado | tarea [<id> [título] | fin] | privacidad [completo|redactado|trabajo] | pausa | reanuda | ayuda]",
].join("\n");

interface Runtime {
  info: HostInfo;
  config: Config;
  warnings: string[];
  privacy: Privacy;
  counter: Counter;
  outboxes: Outbox[];
  paused: boolean;
}

/** Lo que `/nod` cuenta de la sesión en curso. */
interface Stats {
  turns: number;
  aborted: number;
  steps: number;
  usage: Usage;
  agents: number;
  asks: number;
  userWaitMs: number;
  denied: number;
  prompts: number;
  revised: number;
  lastUsage: UsageSnapshot | undefined;
}

const freshStats = (): Stats => ({
  turns: 0, aborted: 0, steps: 0, usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, agents: 0,
  asks: 0, userWaitMs: 0, denied: 0, prompts: 0, revised: 0, lastUsage: undefined,
});

export class NodEngine {
  private runtime: Promise<Runtime> | undefined;
  private readonly norm = new Normalizer();
  private timer: Timer | undefined;
  private stats = freshStats();
  private session: string | undefined;

  // ---------- lo que llama el adaptador ----------

  async sessionStart(p: Platform, session: string, info: SessionInfo): Promise<void> {
    await this.guard(p, "session.start", async (now, rt) => {
      this.session = session;
      this.stats = freshStats();
      const out = this.norm.sessionStart(now, session, info);
      if (rt.config.task !== undefined && this.norm.task === undefined) out.push(...this.norm.setTask(now, session, rt.config.task, undefined, "env"));
      return out;
    });
  }

  async promptEdit(p: Platform, e: PromptEdit): Promise<void> {
    await this.guard(p, "prompt.edit", async (now) => {
      this.norm.promptEdit(now, e);
      return [];
    });
  }

  async promptSubmit(p: Platform, session: string, text: string, origin: string): Promise<void> {
    await this.guard(p, "prompt.submit", async (now) => this.norm.promptSubmit(now, session, { text, origin }));
  }

  async turnStart(p: Platform, session: string, turn: string, agent?: string): Promise<void> {
    await this.guard(p, "turn.start", async (now) => this.norm.turnStart(now, session, turn, agent));
  }

  async step(p: Platform, session: string, s: StepInfo): Promise<void> {
    await this.guard(p, "turn.step", async (now) => this.norm.step(now, session, s));
  }

  /** Fin de turno. En la sesión principal, `usage` (contexto, límites, costo) sale justo después. */
  async turnEnd(p: Platform, session: string, t: TurnEndInfo, usage?: () => Promise<UsageSnapshot | undefined>): Promise<void> {
    await this.guard(p, "turn.end", async (now) => {
      const out = this.norm.turnEnd(now, session, t);
      if (t.agent === undefined && usage !== undefined) {
        const u = await usage().catch(() => undefined);
        if (u !== undefined) out.push(...this.norm.usage(now, session, u));
      }
      return out;
    });
  }

  async toolCall(p: Platform, session: string, c: ToolCallInfo): Promise<void> {
    await this.guard(p, "tool.call", async (now) => this.norm.toolCall(now, session, c));
  }

  async toolCheck(p: Platform, session: string, id: string, tool: string, decision: CheckDecision, reason?: string): Promise<void> {
    await this.guard(p, "tool.check", async (now) => this.norm.toolCheck(now, session, id, tool, decision, reason));
  }

  async toolResult(p: Platform, session: string, r: ToolResultInfo): Promise<void> {
    await this.guard(p, "tool.result", async (now) => this.norm.toolResult(now, session, r));
  }

  async agentSpawn(p: Platform, session: string, a: Parameters<Normalizer["agentSpawn"]>[2]): Promise<void> {
    await this.guard(p, "agent.spawn", async (now) => this.norm.agentSpawn(now, session, a));
  }

  async command(p: Platform, session: string, name: string): Promise<void> {
    await this.guard(p, "command", async (now) => this.norm.command(now, session, name));
  }

  async sessionEnd(p: Platform, session: string, reason: string): Promise<void> {
    await this.guard(p, "session.end", async (now) => this.norm.sessionEnd(now, session, reason));
    // Al cerrar se intenta entregar todo ya: lo que no salga queda en la cola para la siguiente sesión.
    const rt = await this.runtime?.catch(() => undefined);
    if (rt !== undefined && !rt.paused) await Promise.all(rt.outboxes.map((o) => o.flush()));
  }

  /** `/nod …`. Nunca lanza. */
  async runCommand(p: Platform, session: string, args: string): Promise<string> {
    try {
      return await this.doCommand(p, session, args.trim());
    } catch (err) {
      return `nod: error (${String(err)})`;
    }
  }

  // ---------- configuración ----------

  private getRuntime(p: Platform): Promise<Runtime> {
    this.runtime ??= this.loadRuntime(p).catch((err) => {
      this.runtime = undefined;
      throw err;
    });
    return this.runtime;
  }

  private async loadRuntime(p: Platform): Promise<Runtime> {
    const [info, env] = await Promise.all([p.info(), p.env()]);
    const path = configPath(env);
    let text: string | undefined;
    if (path !== undefined) {
      try {
        text = await p.read(path);
      } catch {
        text = undefined; // sin fichero: valores por defecto
      }
    }
    const { config, warnings } = resolveConfig(env, text, info.profile, info.machine);
    for (const w of warnings) p.log(`nod: ${w}`);
    const stored = await p.store.get(KEYS.privacy);
    const privacy = env.NOD_PRIVACY ? config.privacy : (PRIVACY_LEVELS as readonly unknown[]).includes(stored) ? (stored as Privacy) : config.privacy;
    const counter = new Counter(config.instance, (await p.store.get(KEYS.counter(config.instance))) as CounterState | undefined, await p.now());
    const rt: Runtime = { info, config, warnings, privacy, counter, outboxes: [], paused: (await p.store.get(KEYS.paused)) === true };
    for (const sink of config.sinks) {
      const transport: Transport = sink.kind === "file"
        ? async (envelope) => {
            await p.append(sink.target, JSON.stringify(envelope) + "\n");
            return { status: 200 };
          }
        : async (envelope) => {
            const headers: Record<string, string> = { "content-type": "application/json" };
            if (sink.token) headers.authorization = `Bearer ${sink.token}`;
            const r = await p.fetch(`${sink.target}/v1/events`, { method: "POST", headers, body: JSON.stringify(envelope) });
            return { status: r.status, text: r.text };
          };
      const box = new Outbox(sink, (pv) => this.source(rt, pv), transport, this.outboxIo(p), config.instance);
      await box.init();
      rt.outboxes.push(box);
    }
    return rt;
  }

  private source(rt: Runtime, privacy: Privacy): Source {
    const s: Source = { instance: rt.config.instance, host: rt.info.host, profile: rt.info.profile, privacy };
    if (rt.info.hostVersion !== undefined) s.host_version = rt.info.hostVersion;
    if (rt.info.machine !== undefined && privacy === "completo") s.machine = rt.info.machine;
    return s;
  }

  private outboxIo(p: Platform) {
    return {
      now: () => p.now(),
      load: (key: string) => p.store.get(key),
      save: (key: string, value: unknown) => p.store.set(key, value),
      log: (m: string) => p.log(m),
    };
  }

  // ---------- emisión ----------

  /** Normaliza (`work`), numera, filtra y encola. Nunca lanza. */
  private async guard(p: Platform, label: string, work: (now: number, rt: Runtime) => Promise<Draft[]>): Promise<void> {
    try {
      const rt = await this.getRuntime(p);
      if (!rt.config.enabled) return;
      const now = await p.now();
      const drafts = await work(now, rt);
      if (drafts.length > 0) await this.emit(p, rt, drafts, now);
    } catch (err) {
      p.log(`nod: ${label} falló (${String(err)})`);
    }
  }

  private async emit(p: Platform, rt: Runtime, drafts: Draft[], now: number): Promise<void> {
    let urgent = false;
    for (const d of drafts) {
      this.count(d);
      const e: NodEvent = { ...applyPrivacy(d, rt.privacy), seq: rt.counter.next() };
      for (const box of rt.outboxes) if (sinkAllowed(rt.privacy, box.sink)) box.push({ e, p: rt.privacy }, now);
      if (URGENT.has(d.type)) urgent = true;
    }
    if (rt.counter.dirty) {
      await p.store.set(KEYS.counter(rt.config.instance), rt.counter.snapshot());
      rt.counter.markSaved();
    }
    if (urgent) for (const box of rt.outboxes) box.urgent();
    await this.schedule(p, rt);
  }

  private async schedule(p: Platform, rt: Runtime): Promise<void> {
    const now = await p.now();
    const waits = rt.outboxes.map((o) => o.delay(now, rt.paused)).filter((w): w is number => w !== null);
    this.timer?.cancel();
    this.timer = undefined;
    if (waits.length === 0) return;
    this.timer = p.after(Math.min(...waits), () => {
      this.timer = undefined;
      void this.flushDue(p, rt);
    });
  }

  private async flushDue(p: Platform, rt: Runtime): Promise<void> {
    try {
      const now = await p.now();
      for (const box of rt.outboxes) {
        box.io = this.outboxIo(p);
        if (box.delay(now, rt.paused) === 0) await box.flush();
      }
      await this.schedule(p, rt);
    } catch (err) {
      p.log(`nod: fallo al entregar (${String(err)})`);
    }
  }

  private count(d: Draft): void {
    const s = this.stats;
    const data = d.data;
    switch (d.type) {
      case "turn.end":
        if (d.agent === undefined) {
          s.turns++;
          if (data.outcome === "aborted") s.aborted++;
        }
        break;
      case "turn.step": {
        s.steps++;
        const u = data.usage as Usage | undefined;
        if (u !== undefined) s.usage = { input: s.usage.input + u.input, output: s.usage.output + u.output, cache_read: s.usage.cache_read + u.cache_read, cache_write: s.usage.cache_write + u.cache_write };
        break;
      }
      case "agent.spawn":
        s.agents++;
        break;
      case "permission.request":
        s.asks++;
        break;
      case "permission.decision":
        if (data.by === "user" || data.by === "remote") {
          s.userWaitMs += Number(data.wait_ms) || 0;
          if (data.decision === "deny") s.denied++;
        }
        break;
      case "prompt.submit":
        s.prompts++;
        if ((data.edit as { revised?: boolean } | undefined)?.revised) s.revised++;
        break;
      case "usage":
        s.lastUsage = data as UsageSnapshot;
        break;
      default:
        break;
    }
  }

  // ---------- /nod ----------

  private async doCommand(p: Platform, session: string, args: string): Promise<string> {
    const rt = await this.getRuntime(p);
    const [verb = "", ...rest] = args.split(/\s+/).filter(Boolean);
    const v = verb.toLowerCase();
    if (v === "" || v === "estado" || v === "status") return this.statusText(rt, await p.now());
    if (v === "ayuda" || v === "help" || v === "-h" || v === "--help") return HELP;
    if (v === "pausa" || v === "pause" || v === "reanuda" || v === "resume") {
      rt.paused = v === "pausa" || v === "pause";
      await p.store.set(KEYS.paused, rt.paused);
      if (!rt.paused) await this.schedule(p, rt);
      return rt.paused ? "Nod en pausa: los eventos se guardan en la cola y no se entregan (/nod reanuda)." : "Nod entrega de nuevo lo que tenga en cola.";
    }
    if (v === "privacidad" || v === "privacy") {
      const want = rest[0]?.toLowerCase();
      if (want === undefined) return `privacidad en este perfil: ${rt.privacy}\n  ${PRIVACY_HELP}`;
      if (!(PRIVACY_LEVELS as readonly string[]).includes(want)) return `privacidad "${want}" no existe.\n  ${PRIVACY_HELP}`;
      if ((await p.env()).NOD_PRIVACY) return `NOD_PRIVACY=${rt.privacy} manda en este entorno: quítala para elegir con /nod privacidad.`;
      rt.privacy = want as Privacy;
      await p.store.set(KEYS.privacy, rt.privacy);
      const blocked = rt.outboxes.filter((o) => !sinkAllowed(rt.privacy, o.sink)).map((o) => o.sink.target);
      return `privacidad en este perfil: ${rt.privacy}` + (blocked.length > 0 ? `\n  no se entregará a (no son locales): ${blocked.join(", ")}` : "");
    }
    if (v === "tarea" || v === "task") {
      const now = await p.now();
      if (rest.length === 0) return this.norm.task === undefined ? "sin tarea: /nod tarea <id> [título]" : `tarea: ${this.norm.task}`;
      const clear = rest.length === 1 && /^(fin|ninguna|none|clear|-)$/i.test(rest[0]!);
      const id = clear ? undefined : rest[0]!;
      const title = clear || rest.length < 2 ? undefined : rest.slice(1).join(" ");
      if (rt.config.enabled) await this.emit(p, rt, this.norm.setTask(now, this.session ?? session, id, title, "command"), now);
      else this.norm.task = id;
      return id === undefined ? "tarea cerrada: lo que sigue no se asocia a ninguna" : `tarea: ${id}${title ? ` (${title})` : ""}. Todo lo que siga en esta sesión cuenta para ella.`;
    }
    return USAGE;
  }

  private statusText(rt: Runtime, now: number): string {
    const s = this.stats;
    const ago = (at: number | undefined) => (at === undefined ? "nunca" : `hace ${Math.max(0, Math.round((now - at) / 1000))} s`);
    const tok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} M` : n >= 1000 ? `${Math.round(n / 1000)} k` : String(n));
    const lines = [
      rt.config.enabled ? (rt.paused ? "en pausa (los eventos esperan en la cola: /nod reanuda)" : "observando") : "desactivado (NOD_OFF=1)",
      `  instancia ${rt.config.instance} · perfil ${rt.info.profile} · privacidad ${rt.privacy}${this.norm.task ? ` · tarea ${this.norm.task}` : ""}`,
      `  configuración: ${rt.config.source}`,
      "  destinos:",
    ];
    if (rt.outboxes.length === 0) lines.push("    ninguno (define NOD_SINKS o el fichero de configuración)");
    for (const o of rt.outboxes) {
      const st = o.status();
      const blocked = !sinkAllowed(rt.privacy, o.sink);
      lines.push(`    ${st.kind === "file" ? "fichero" : "http"} ${st.target}${blocked ? " (bloqueado por privacidad trabajo)" : ""}`);
      lines.push(`      entregados ${st.sent}, en cola ${st.queued}, perdidos ${st.dropped}; último éxito ${ago(st.lastOkAt)}${st.lastError ? `; último error ${st.lastError} (${ago(st.lastErrorAt)})` : ""}`);
    }
    lines.push(
      "  esta sesión:",
      `    ${s.turns} turnos (${s.aborted} interrumpidos), ${s.steps} llamadas al modelo, ${s.agents} subagentes, ${s.prompts} prompts (${s.revised} reescritos)`,
      `    tokens: ${tok(s.usage.input)} entrada, ${tok(s.usage.output)} salida, ${tok(s.usage.cache_read)} de caché`,
      `    permisos: ${s.asks} preguntados, ${s.denied} negados, ${Math.round(s.userWaitMs / 1000)} s esperándote`,
    );
    const u = s.lastUsage;
    if (u?.context?.percent !== undefined) lines.push(`    contexto: ${u.context.percent}% de ${tok(u.context.window ?? 0)}`);
    for (const l of u?.limits ?? []) lines.push(`    límite ${l.kind === "five_hour" ? "5 h" : l.kind === "seven_day" ? "7 días" : l.kind}: ${l.percent_used}%${renews(l.resets_at, now)}`);
    if (u?.cost_usd !== undefined) lines.push(`    costo: ${u.cost_usd.toFixed(2)} USD`);
    for (const w of rt.warnings) lines.push(`  aviso: ${w}`);
    return lines.join("\n");
  }
}

/** " (se renueva en 4 h 41 min)" a partir de la fecha ISO del agente. */
function renews(at: string | undefined, now: number): string {
  const t = at === undefined ? NaN : Date.parse(at);
  if (!Number.isFinite(t)) return "";
  const min = Math.max(0, Math.round((t - now) / 60_000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  const parts = d > 0 ? [`${d} d`, `${h} h`] : h > 0 ? [`${h} h`, `${m} min`] : [`${m} min`];
  return ` (se renueva en ${parts.join(" ")})`;
}

const PRIVACY_HELP = "completo: todo (texto, comandos, rutas) · redactado: sin texto ni rutas · trabajo: redactado y solo destinos locales";

const HELP = [
  "Nod observa tus sesiones y entrega eventos Nod v1 a tus destinos (fichero, collector, Orbit…).",
  "  /nod                      estado: destinos, cola y cifras de esta sesión",
  "  /nod tarea <id> [título]  asocia lo que sigue a una tarea (historia, ticket); /nod tarea fin la cierra",
  "  /nod privacidad <nivel>   completo, redactado o trabajo (solo destinos locales), en este perfil",
  "  /nod pausa · reanuda      deja de entregar (guarda en cola) y vuelve a entregar",
  "Configuración: NOD_SINKS, NOD_PRIVACY, NOD_TASK… o ~/.config/nod/config.json (README).",
].join("\n");
