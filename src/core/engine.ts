// Nod, sin el agente: recibe lo que pasa en la sesión (ya en nombres neutros), lo normaliza a Nod v1, aplica
// la privacidad, lo numera y lo entrega a cada destino. Cada adaptador (hosts/claude, …) llama a estos métodos
// con su Platform. Los métodos públicos nunca lanzan: un fallo de Nod no puede romper la sesión.
import { resolveConfig, configPath, loadTokenFiles } from "./config.js";
import type { Config, NodEnv } from "./config.js";
import { ControlChannel } from "./control/channel.js";
import type { ChannelContext, CheckInfo } from "./control/channel.js";
import type { AbortLike } from "./control/hold.js";
import { PRIVACY_LEVELS } from "./events.js";
import type { Draft, NodEvent, Privacy, Source, Usage } from "./events.js";
import { Normalizer, taskFromBranch } from "./normalize.js";
import type { CheckDecision, PromptEdit, SessionInfo, StepInfo, ToolCallInfo, ToolResultInfo, TurnEndInfo, UsageSnapshot } from "./normalize.js";
import { Outbox } from "./outbox.js";
import type { Transport } from "./outbox.js";
import { applyPrivacy, isStricter, sinkAllowed, stricter } from "./privacy.js";
import type { HostInfo, Platform, Timer } from "./platform.js";

export const COMMAND_DESCRIPTION = "Nod: estado de la sesión, los destinos y el canal de control; /nod tarea, privacidad, pausa, reanuda, emparejar, aprobadores, lejos, cerca";

const KEYS = {
  /** Id aleatorio y estable de este perfil en esta máquina: la instancia por defecto sin el nombre del equipo. */
  anonId: "nod.id",
  paused: "nod.paused",
  privacy: "nod.privacy",
} as const;

/** Tipos que se entregan sin esperar a la ventana del lote. */
const URGENT = new Set(["turn.end", "session.end", "permission.request", "agent.end"]);

export const USAGE = [
  "uso: /nod [estado | tarea [<id> [título] | fin] | privacidad [completo|redactado|trabajo] | pausa | reanuda | emparejar | aprobadores [quitar <kid>] | lejos | cerca | ayuda]",
].join("\n");

interface Runtime {
  info: HostInfo;
  env: NodEnv;
  config: Config;
  warnings: string[];
  privacy: Privacy;
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
  /** Todo el trabajo va en fila: el adaptador no espera (no retrasa al agente) y el orden se conserva. */
  private chain: Promise<void> = Promise.resolve();
  /** Esta ejecución del agente (un proceso): `seq` empieza en 1 y es único dentro de ella (Nod v1 §1.3). */
  readonly run = randomHex(4);
  private seq = 0;
  /** Desde cuándo esta sesión (para emitir un session.start cuando el agente cambia de sesión sin avisar). */
  private started = new Set<string>();
  /** Nod Control: retención de permisos, mensajes y emparejamiento (docs/control-v1.md). */
  private readonly channel = new ControlChannel((p, session, id, decision) => {
    void this.guard(p, "permission.remote", async (now) => this.norm.remoteDecision(now, session, id, decision));
  });

  // ---------- lo que llama el adaptador ----------

  async sessionStart(p: Platform, session: string, info: SessionInfo): Promise<void> {
    await this.guard(p, "session.start", async (now, rt) => {
      this.session = session;
      this.started.add(session);
      this.stats = freshStats();
      const out = this.norm.sessionStart(now, session, info);
      if (this.norm.task === undefined) {
        // Tarea: NOD_TASK; si no, el id de ticket que lleve el nombre de la rama (docs/nod-v1.md §5).
        const fromBranch = taskFromBranch(info.repo?.branch);
        if (rt.config.task !== undefined) out.push(...this.norm.setTask(now, session, rt.config.task, undefined, "env"));
        else if (fromBranch !== undefined) out.push(...this.norm.setTask(now, session, fromBranch, undefined, "branch"));
      }
      this.channel.sessionStarted(p, this.ctx(rt), session);
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
    await this.guard(p, "turn.start", async (now) => {
      this.channel.turnStarted(turn, agent);
      return this.norm.turnStart(now, session, turn, agent);
    });
  }

  async step(p: Platform, session: string, s: StepInfo): Promise<void> {
    await this.guard(p, "turn.step", async (now) => this.norm.step(now, session, s));
  }

  /** Fin de turno. En la sesión principal, `usage` (contexto, límites, costo) sale justo después. */
  async turnEnd(p: Platform, session: string, t: TurnEndInfo, usage?: () => Promise<UsageSnapshot | undefined>): Promise<void> {
    await this.guard(p, "turn.end", async (now) => {
      const out = this.norm.turnEnd(now, session, t);
      this.channel.turnEnded(p, t.turn, t.agent);
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

  async toolCheck(p: Platform, session: string, id: string, tool: string, decision: CheckDecision, reason?: string, checkMs?: number): Promise<void> {
    await this.guard(p, "tool.check", async (now) => this.norm.toolCheck(now, session, id, tool, decision, reason, checkMs));
  }

  /**
   * Un permiso que el agente va a preguntar: con Nod Control activo, llaves emparejadas y un modo que no sea
   * `auto`, se retiene hasta una decisión remota verificada, el plazo o la cancelación. Devuelve esa decisión
   * (ya emitida como permission.decision by "remote") o undefined: el veredicto original sigue. Es el único sitio
   * donde Nod cambia una decisión. `mode` se consulta solo si hace falta. Nunca lanza.
   */
  async checkPermission(p: Platform, session: string, c: CheckInfo, signal: AbortLike | undefined, mode: () => Promise<string | undefined>): Promise<"allow" | "deny" | undefined> {
    try {
      const rt = await this.getRuntime(p);
      return await this.channel.check(p, this.ctx(rt), session, c, signal, mode);
    } catch (err) {
      p.log(`nod: retención falló (${String(err)})`);
      return undefined;
    }
  }

  /** El agente dice quién decidió un permiso y cuándo (si no lo dice, se deduce del resultado de la tool). */
  async permissionDecided(p: Platform, session: string, id: string, tool: string, decision: "allow" | "deny", by: "user" | "policy"): Promise<void> {
    await this.guard(p, "permission.decision", async (now) => this.norm.decided(now, session, id, tool, decision, by));
  }

  /** Mensaje de un aprobador llegado a mitad de turno, para el resultado de una tool de la sesión principal. */
  takeNote(agent: string | undefined): string | undefined {
    return this.channel.takeNote(agent);
  }

  /** Duración de la ejecución de una tool, si el agente la da (antes de su resultado). */
  async toolExec(p: Platform, id: string, ms: number): Promise<void> {
    await this.guard(p, "tool.exec", async () => {
      this.norm.toolExec(id, ms);
      return [];
    });
  }

  /** Empieza una llamada al modelo (fija el turno en curso del subagente antes de sus tools). */
  async stepBegin(p: Platform, turn: string, agent?: string): Promise<void> {
    await this.guard(p, "turn.step", async () => {
      this.norm.stepBegin(turn, agent);
      return [];
    });
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
    this.channel.sessionEnded();
    this.started.delete(session);
    // Al cerrar se intenta entregar todo ya, con un plazo: lo que no salga queda guardado para la siguiente sesión.
    const rt = await this.runtime?.catch(() => undefined);
    if (rt === undefined) return;
    const boxes = rt.outboxes.filter((o) => sinkAllowed(rt.privacy, o.sink));
    if (!rt.paused) await within(p, CLOSE_TIMEOUT_MS, Promise.all(boxes.map((o) => o.flush())));
    await Promise.all(boxes.map((o) => o.persistSoon(Number.MAX_SAFE_INTEGER)));
  }

  /** `/nod …`. Espera a que la fila esté al día (las cifras incluyen todo lo anterior). Nunca lanza. */
  async runCommand(p: Platform, session: string, args: string): Promise<string> {
    try {
      await this.chain;
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
    let anonId = await p.store.get(KEYS.anonId);
    if (typeof anonId !== "string" || !/^[0-9a-f]{8}$/.test(anonId)) {
      anonId = randomHex(4);
      await p.store.set(KEYS.anonId, anonId);
    }
    const { config, warnings } = resolveConfig(env, text, info.profile, anonId as string);
    await loadTokenFiles(config, (path) => p.read(path), warnings);
    // /nod privacidad solo puede endurecer lo que fija la configuración, nunca relajarlo.
    const stored = await p.store.get(KEYS.privacy);
    let privacy = config.privacy;
    if (!env.NOD_PRIVACY && (PRIVACY_LEVELS as readonly unknown[]).includes(stored)) {
      privacy = stricter(config.privacy, stored as Privacy);
      if (isStricter(config.privacy, stored as Privacy)) warnings.push(`la privacidad guardada (${String(stored)}) es más laxa que la de la configuración: uso ${config.privacy}`);
    }
    for (const w of warnings) p.log(`nod: ${w}`);
    const rt: Runtime = { info, env, config, warnings, privacy, outboxes: [], paused: (await p.store.get(KEYS.paused)) === true };
    for (const sink of config.sinks) {
      const transport: Transport = sink.kind === "file"
        ? async (envelope) => {
            await p.append(sink.target, JSON.stringify(envelope) + "\n");
            return { status: 200 };
          }
        : async (envelope) => {
            const headers: Record<string, string> = { "content-type": "application/json" };
            if (sink.token) headers.authorization = `Bearer ${sink.token}`;
            // Un destino que acepta la conexión y no contesta no puede dejar la entrega colgada.
            const r = await within(p, HTTP_TIMEOUT_MS, p.fetch(`${sink.target}/v1/events`, { method: "POST", headers, body: JSON.stringify(envelope) }));
            if (r === undefined) throw new Error(`sin respuesta en ${HTTP_TIMEOUT_MS / 1000} s`);
            return { status: r.status, text: r.text };
          };
      const box = new Outbox(sink, (pv, run) => this.source(rt, pv, run), transport, this.outboxIo(p), config.instance, this.run);
      await box.init();
      rt.outboxes.push(box);
    }
    // Lo que quedó en cola de una sesión anterior se ajusta al perfil de ahora antes de entregar nada.
    await this.restrictQueues(p, rt);
    return rt;
  }

  /** Vuelve a filtrar las colas con la privacidad actual; vacía las de destinos que ya no la admiten. */
  private async restrictQueues(p: Platform, rt: Runtime): Promise<void> {
    for (const box of rt.outboxes) {
      const removed = await box.restrict(rt.privacy, sinkAllowed(rt.privacy, box.sink));
      if (removed > 0) p.log(`nod: ${removed} eventos en cola hacia ${box.sink.target} descartados (privacidad ${rt.privacy})`);
    }
  }

  private source(rt: Runtime, privacy: Privacy, run: string): Source {
    const s: Source = { instance: rt.config.instance, run, host: rt.info.host, profile: rt.info.profile, privacy };
    if (rt.info.hostVersion !== undefined) s.host_version = rt.info.hostVersion;
    if (rt.info.machine !== undefined && privacy === "completo") s.machine = rt.info.machine;
    return s;
  }

  private ctx(rt: Runtime): ChannelContext {
    return { enabled: rt.config.enabled, config: rt.config.control, privacy: rt.privacy, instance: rt.config.instance, env: rt.env };
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

  /**
   * Normaliza (`work`), numera, filtra y encola, en fila detrás de lo anterior. La hora se toma al llamar (es la
   * del evento, no la de su turno en la fila). Nunca lanza.
   */
  private guard(p: Platform, label: string, work: (now: number, rt: Runtime) => Promise<Draft[]>): Promise<void> {
    const at = p.now();
    at.catch(() => undefined);
    const run = this.chain.then(async () => {
      try {
        const rt = await this.getRuntime(p);
        if (!rt.config.enabled) return;
        const now = await at;
        const drafts = await work(now, rt);
        // El agente cambió de sesión sin session.start (p. ej. /clear): se abre la nueva antes de sus eventos.
        const first = drafts[0];
        if (first !== undefined && first.type !== "session.start" && !this.started.has(first.session)) {
          this.started.add(first.session);
          this.session = first.session;
          this.stats = freshStats();
          this.norm.resetSession();
          this.channel.sessionContinued(p, this.ctx(rt), first.session);
          const opening = this.norm.sessionStart(now, first.session, {});
          opening[0]!.data.continued = true;
          drafts.unshift(...opening);
        }
        if (drafts.length > 0) await this.emit(p, rt, drafts, now);
      } catch (err) {
        p.log(`nod: ${label} falló (${String(err)})`);
      }
    });
    this.chain = run;
    return run;
  }

  private async emit(p: Platform, rt: Runtime, drafts: Draft[], now: number): Promise<void> {
    let urgent = false;
    for (const d of drafts) {
      this.count(d);
      const e: NodEvent = { ...applyPrivacy(d, rt.privacy), seq: ++this.seq };
      for (const box of rt.outboxes) if (sinkAllowed(rt.privacy, box.sink)) box.push({ e, p: rt.privacy, r: this.run }, now);
      if (URGENT.has(d.type)) urgent = true;
    }
    if (urgent) for (const box of rt.outboxes) box.urgent();
    for (const box of rt.outboxes) await box.persistSoon(now);
    await this.schedule(p, rt);
  }

  private async schedule(p: Platform, rt: Runtime): Promise<void> {
    const now = await p.now();
    const waits = rt.outboxes.filter((o) => sinkAllowed(rt.privacy, o.sink)).map((o) => o.delay(now, rt.paused)).filter((w): w is number => w !== null);
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
        if (!sinkAllowed(rt.privacy, box.sink)) continue;
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
    if (v === "" || v === "estado" || v === "status") return [this.statusText(rt, await p.now()), ...(await this.channel.statusLines(p, this.ctx(rt)))].join("\n");
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
      if (isStricter(rt.config.privacy, want as Privacy)) return `la configuración (${rt.config.source}) fija ${rt.config.privacy} en este perfil: /nod privacidad solo puede endurecerla.`;
      rt.privacy = want as Privacy;
      await p.store.set(KEYS.privacy, rt.privacy);
      await this.restrictQueues(p, rt);
      const blocked = rt.outboxes.filter((o) => !sinkAllowed(rt.privacy, o.sink)).map((o) => o.sink.target);
      return `privacidad en este perfil: ${rt.privacy}` + (blocked.length > 0 ? `\n  no se entregará a (no son locales): ${blocked.join(", ")}` : "");
    }
    if (v === "tarea" || v === "task") {
      if (rest.length === 0) return this.norm.task === undefined ? "sin tarea: /nod tarea <id> [título]" : `tarea: ${this.norm.task}`;
      const clear = rest.length === 1 && /^(fin|ninguna|none|clear|-)$/i.test(rest[0]!);
      const id = clear ? undefined : rest[0]!;
      const title = clear || rest.length < 2 ? undefined : rest.slice(1).join(" ");
      if (rt.config.enabled) await this.guard(p, "task.set", async (at) => this.norm.setTask(at, this.session ?? session, id, title, "command"));
      else this.norm.task = id;
      return id === undefined ? "tarea cerrada: lo que sigue no se asocia a ninguna" : `tarea: ${id}${title ? ` (${title})` : ""}. Todo lo que siga en esta sesión cuenta para ella.`;
    }
    return (await this.channel.command(p, this.ctx(rt), v, rest)) ?? USAGE;
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

const HTTP_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 3_000;

/** La promesa, o undefined si no se resuelve en `ms` (con el reloj del agente). */
function within<T>(p: Platform, ms: number, work: Promise<T>): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = p.after(ms, () => resolve(undefined));
    work.then(
      (v) => {
        timer.cancel();
        resolve(v);
      },
      (err) => {
        timer.cancel();
        reject(err);
      },
    );
  });
}

/** n bytes aleatorios en hexadecimal (no es criptográfico: solo separa instancias). */
function randomHex(n: number): string {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  const bytes = c?.getRandomValues ? c.getRandomValues(new Uint8Array(n)) : Uint8Array.from({ length: n }, () => Math.floor(Math.random() * 256));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const PRIVACY_HELP = "completo: todo (texto, comandos, rutas) · redactado: sin texto ni rutas · trabajo: redactado y solo destinos locales";

const HELP = [
  "Nod observa tus sesiones y entrega eventos Nod v1 a tus destinos (fichero, collector, Orbit…).",
  "  /nod                      estado: destinos, cola y cifras de esta sesión",
  "  /nod tarea <id> [título]  asocia lo que sigue a una tarea (historia, ticket); /nod tarea fin la cierra",
  "  /nod privacidad <nivel>   completo, redactado o trabajo (solo destinos locales), en este perfil",
  "  /nod pausa · reanuda      deja de entregar (guarda en cola) y vuelve a entregar",
  "Nod Control (aprobar permisos y mandar mensajes desde fuera, si hay controlador configurado):",
  "  /nod emparejar            QR para emparejar un aprobador (móvil, reloj…)",
  "  /nod aprobadores          llaves emparejadas; /nod aprobadores quitar <kid> revoca una",
  "  /nod lejos · cerca        un permiso espera 90 s o hold_ms una decisión desde fuera (toda la máquina)",
  "Configuración: NOD_SINKS, NOD_PRIVACY, NOD_TASK, NOD_CONTROL… o ~/.config/nod/config.json (README).",
].join("\n");
