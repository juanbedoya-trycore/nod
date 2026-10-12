// El canal de control dentro del motor: une la retención, los mensajes, el emparejamiento y los ficheros de la
// máquina (approvers.json, pairing.json, away.json) sobre una Platform. El motor (engine.ts) lo llama desde los
// mismos métodos que normalizan eventos; aquí no se emite nada salvo a través de `remoteDecision`.
//
// Todo es fail-open: un fallo del canal deja al agente como si el canal no existiera.
import { controlBlocked, HOLD_MS_MAX, stateDir } from "../config.js";
import type { ControlConfig, NodEnv } from "../config.js";
import type { Privacy } from "../events.js";
import type { Platform, Timer } from "../platform.js";
import { hideMcpServer } from "../privacy.js";
import { addApprover, parseApprovers, removeApprover } from "./approvers.js";
import type { ParsedApprovers } from "./approvers.js";
import type { DecisionValue } from "./crypto.js";
import { approvable, forbiddenRules } from "./forbidden.js";
import { Holder } from "./hold.js";
import type { AbortLike, HoldOutcome } from "./hold.js";
import { CALL_TIMEOUT_MS, call, headers, parseJson } from "./io.js";
import type { ControlIo, Controller } from "./io.js";
import { MessageLoop, messagePlan, Notes } from "./messages.js";
import type { Accepted } from "./messages.js";
import { addPairKey, fillPairUrl, PAIR_POLL_MS, PAIR_TTL_MS, PAIR_WAIT_MS, pairOffers, parsePairing, qrText } from "./pairing.js";
import type { PairingStore } from "./pairing.js";
import { summarize } from "./summary.js";

/** Lo que el canal necesita saber del motor en cada llamada. */
export interface ChannelContext {
  enabled: boolean;
  config: ControlConfig | undefined;
  privacy: Privacy;
  instance: string;
  env: NodEnv;
}

export interface CheckInfo {
  toolUseId: string;
  tool: string;
  input: unknown;
  agent?: string | undefined;
}

/** Retención con `/nod lejos`: el humano no está delante del terminal. */
export const AWAY_HOLD_MS = HOLD_MS_MAX;
/** Si el turno cortado por `recap` no llega a cerrarse, el resumen sale igual tras esto. */
const RECAP_FALLBACK_MS = 3_000;

export class ControlChannel {
  private readonly holder = new Holder();
  private loop: MessageLoop | undefined;
  /** La Platform de session.start: el bucle de mensajes vive más que cualquier hook. */
  private loopPlatform: Platform | undefined;
  private listening: string | undefined;
  private mainTurn: string | undefined;
  private readonly notes = new Notes();
  private pendingRecap: string | undefined;
  private pairWatch: Timer | undefined;
  private pairUntil = 0;

  constructor(private readonly remoteDecision: (p: Platform, session: string, toolUseId: string, decision: DecisionValue) => void) {}

  blocked(ctx: ChannelContext): string | undefined {
    if (!ctx.enabled) return "Nod desactivado (NOD_OFF=1)";
    return controlBlocked(ctx.config, ctx.privacy);
  }

  // ---------- sesión y turnos ----------

  sessionStarted(p: Platform, ctx: ChannelContext, session: string): void {
    this.mainTurn = undefined;
    this.notes.clear();
    this.pendingRecap = undefined;
    if (this.blocked(ctx) !== undefined) return;
    const controller = this.controller(ctx);
    // Sin esperar: si hay un QR vigente y el aprobador ya publicó la oferta, queda emparejado.
    void pairOffers(controller, ioOf(p), ctx.instance, this.pairingStore(p, ctx));
    this.listen(p, ctx, session);
  }

  /** El agente cambió de sesión sin session.start (p. ej. /clear): el bucle sigue con la nueva. */
  sessionContinued(p: Platform, ctx: ChannelContext, session: string): void {
    this.mainTurn = undefined;
    this.notes.clear();
    if (this.blocked(ctx) === undefined) this.listen(this.loopPlatform ?? p, ctx, session);
  }

  sessionEnded(): void {
    this.listening = undefined;
    this.mainTurn = undefined;
    this.notes.clear();
    this.pendingRecap = undefined;
  }

  turnStarted(turn: string, agent: string | undefined): void {
    if (agent === undefined) this.mainTurn = turn;
  }

  /** Fin de un turno principal: primero el resumen pedido, luego lo que no salió como contexto. */
  turnEnded(p: Platform, turn: string, agent: string | undefined): void {
    if (agent !== undefined || (this.mainTurn !== undefined && this.mainTurn !== turn)) return;
    this.mainTurn = undefined;
    this.submitRecap(p);
    const left = this.notes.takePrompt();
    if (left !== undefined) this.submit(p, left);
  }

  /** Mensajes llegados a mitad de turno, como contexto del resultado de una tool de la sesión principal. */
  takeNote(agent: string | undefined): string | undefined {
    return agent === undefined ? this.notes.takeContext() : undefined;
  }

  // ---------- permisos ----------

  /**
   * Retiene un permiso preguntado si toca. Devuelve la decisión remota verificada, o undefined: el veredicto
   * original sigue (el terminal pregunta). `mode` se pide solo si el canal está activo. Nunca lanza.
   */
  async check(p: Platform, ctx: ChannelContext, session: string, c: CheckInfo, signal: AbortLike | undefined, mode: () => Promise<string | undefined>): Promise<DecisionValue | undefined> {
    try {
      if (this.blocked(ctx) !== undefined) return undefined;
      // En auto mode lo que se pregunta lo decide después el clasificador del agente: retenerlo solo haría
      // esperar y llenaría el aprobador de avisos que no piden nada. Sin dato del modo, se retiene.
      if ((await mode().catch(() => undefined)) === "auto") return undefined;
      const controller = this.controller(ctx);
      const io = ioOf(p);
      // Un QR recién escaneado: la oferta puede estar esperando. Se empareja antes de decidir si se retiene.
      await pairOffers(controller, io, ctx.instance, this.pairingStore(p, ctx));
      const keys = await this.approvers(p, ctx);
      if (keys.keys.length === 0) return undefined;
      const tool = ctx.privacy === "redactado" ? hideMcpServer(c.tool) : c.tool;
      const s = summarize(ctx.privacy, c.tool, c.input, tool);
      const rules = forbiddenRules(ctx.env.NOD_FORBIDDEN_ADD);
      if (!rules.ok) io.log(`nod control: ${rules.error}: ninguna tool se puede aprobar desde fuera`);
      const wok = s.exact && rules.ok && approvable(c.tool, c.input, rules.rules);
      const out: HoldOutcome = await this.holder.hold({
        instance: ctx.instance,
        session,
        toolUseId: c.toolUseId,
        tool,
        summary: s.summary,
        wok,
        agent: c.agent,
        holdMs: await this.holdMs(p, ctx),
        signal,
        keys: async () => (await this.approvers(p, ctx)).keys,
      }, controller, io);
      if (!out.held) {
        io.log(`nod control: no se retiene ${c.toolUseId} (${out.why})`);
        return undefined;
      }
      if (out.by !== "remote" || out.decision === "none") return undefined;
      this.remoteDecision(p, session, c.toolUseId, out.decision);
      return out.decision;
    } catch (err) {
      p.log(`nod control: retención falló (${String(err)})`);
      return undefined;
    }
  }

  // ---------- mensajes ----------

  private listen(p: Platform, ctx: ChannelContext, session: string): void {
    this.listening = session;
    if (p.session === undefined) return;
    this.loopPlatform = p;
    const controller = this.controller(ctx);
    this.loop ??= new MessageLoop({
      controller,
      io: ioOf(p),
      instance: ctx.instance,
      session: () => this.listening,
      keys: async () => (await this.approvers(this.loopPlatform ?? p, ctx)).keys,
      onMessage: (m) => this.onMessage(m),
    });
    void this.loop.run();
  }

  /** Aplica un mensaje ya verificado (tests: también se llama directamente). */
  async onMessage(m: Accepted): Promise<void> {
    const p = this.loopPlatform;
    if (p?.session === undefined) return;
    const plan = messagePlan(m.kind, m.text, this.mainTurn !== undefined);
    if (plan.submitAfterTurn !== undefined) this.pendingRecap = plan.submitAfterTurn;
    if (plan.abort && this.mainTurn !== undefined) {
      const turn = this.mainTurn;
      await p.session.abortTurn(turn).catch((err: unknown) => p.log(`nod control: no se pudo cortar el turno (${String(err)})`));
      p.log(`nod control: turno cortado desde fuera${m.kind === "recap" ? "; se pedirá un resumen" : ""}`);
      // Si el turno cortado no llega a cerrarse (turn.complete), el resumen sale igual.
      if (this.pendingRecap !== undefined) {
        p.after(RECAP_FALLBACK_MS, () => {
          if (this.mainTurn === turn) this.mainTurn = undefined;
          this.submitRecap(p);
        });
      }
    }
    if (plan.note !== undefined) this.notes.push(plan.note);
    if (plan.submitNow !== undefined) this.submit(p, plan.submitNow);
  }

  private submitRecap(p: Platform): void {
    if (this.pendingRecap === undefined || this.mainTurn !== undefined) return;
    const text = this.pendingRecap;
    this.pendingRecap = undefined;
    this.submit(p, text);
  }

  private submit(p: Platform, text: string): void {
    const s = (this.loopPlatform ?? p).session;
    if (s === undefined) return;
    void s.submitPrompt(text).catch((err: unknown) => p.log(`nod control: no se pudo enviar el prompt (${String(err)})`));
  }

  // ---------- /nod ----------

  /** `/nod emparejar | aprobadores [quitar <kid>] | lejos | cerca`; undefined si el verbo no es del canal. */
  async command(p: Platform, ctx: ChannelContext, verb: string, rest: string[]): Promise<string | undefined> {
    switch (verb) {
      case "emparejar":
      case "pair":
        return this.pairCommand(p, ctx);
      case "aprobadores":
      case "approvers":
        return this.approversCommand(p, ctx, rest);
      case "lejos":
      case "away":
      case "cerca":
      case "back": {
        const away = verb === "lejos" || verb === "away";
        const err = await this.setAway(p, ctx, away);
        if (err !== undefined) return `no pude guardar el modo lejos (${err})`;
        const hold = Math.round((await this.holdMs(p, ctx)) / 1000);
        return away
          ? `lejos: en toda la máquina, un permiso espera ${hold} s una decisión desde fuera antes de preguntar en el terminal (/nod cerca para volver).`
          : `cerca: un permiso espera ${hold} s una decisión desde fuera; luego pregunta el terminal (/nod lejos si te vas).`;
      }
      default:
        return undefined;
    }
  }

  async statusLines(p: Platform, ctx: ChannelContext): Promise<string[]> {
    const blocked = this.blocked(ctx);
    if (ctx.config === undefined) return ["  control: sin configurar (Nod no retiene ni cambia ninguna decisión)"];
    const lines = [`  control: ${ctx.config.url}${blocked === undefined ? "" : ` (desactivado: ${blocked})`}`];
    const a = await this.approvers(p, ctx);
    lines.push(a.keys.length === 0 ? "    aprobadores: ninguno (/nod emparejar)" : `    aprobadores: ${a.entries.map((e) => e.name ?? e.kid).join(", ")} (/nod aprobadores)`);
    for (const w of a.ignored) lines.push(`    aviso: approvers.json: ${w}`);
    const away = await this.isAway(p, ctx);
    lines.push(`    retención: ${Math.round((await this.holdMs(p, ctx)) / 1000)} s (${away ? "lejos: /nod cerca" : "cerca: /nod lejos"})${this.holder.holding > 0 ? ` · ${this.holder.holding} retenido(s) ahora` : ""}`);
    const last = this.holder.last;
    if (last !== undefined) {
      lines.push(last.held ? `    último permiso: ${last.by === "remote" ? `decidido desde fuera (${last.decision})` : last.by === "timeout" ? "venció el plazo" : last.by === "abort" ? "cancelado" : "el controlador lo olvidó"}${last.rejected > 0 ? `; ${last.rejected} decisión(es) descartada(s), la última por ${last.reject}` : ""}` : `    último permiso: no retenido (${last.why})`);
    }
    if (this.loop !== undefined) lines.push(`    mensajes: ${this.loop.running && this.listening !== undefined ? "escuchando" : "parado"}${this.loop.rejected > 0 ? `, ${this.loop.rejected} descartado(s)` : ""}`);
    return lines;
  }

  private async pairCommand(p: Platform, ctx: ChannelContext): Promise<string> {
    const blocked = this.blocked(ctx);
    if (blocked !== undefined) return `Nod Control no está activo (${blocked}): configura "control" en ~/.config/nod/config.json o NOD_CONTROL (README).`;
    const controller = this.controller(ctx);
    const io = ioOf(p);
    const r = await call(io, CALL_TIMEOUT_MS, `${controller.url}/v1/control/info`, { method: "GET", headers: headers(controller, false) });
    if (r === undefined) return `el controlador ${controller.url} no contesta.`;
    if (r.status !== 200) return `el controlador ${controller.url} respondió ${r.status} a /v1/control/info${r.status === 401 || r.status === 403 ? " (¿token?)" : ""}.`;
    const info = parseJson(r.text) as { name?: unknown; pair_url?: unknown } | undefined;
    if (typeof info?.pair_url !== "string") return `el controlador ${controller.url} no da "pair_url": no sé qué poner en el QR.`;
    const k = await p.random(32);
    const link = fillPairUrl(info.pair_url, ctx.instance, controller.token, k);
    if (link === undefined) return `la plantilla "pair_url" del controlador no lleva {k}: el aprobador no podría demostrar que leyó el QR.`;
    const path = this.file(ctx, "pairing.json");
    if (path === undefined) return "no sé dónde guardar el emparejamiento (sin HOME ni XDG_STATE_HOME).";
    const now = await p.now();
    await p.write(path, JSON.stringify(addPairKey(parsePairing(await readOr(p, path)), k, ctx.instance, now), null, 2) + "\n");
    this.watchPairing(p, ctx, now + PAIR_WAIT_MS);
    const name = typeof info.name === "string" && info.name !== "" ? ` (${info.name.slice(0, 64)})` : "";
    return [
      `Empareja un aprobador con ${controller.url}${name}:`,
      qrText(link),
      "",
      "Escanea el QR con el aprobador. Espero su oferta 2 min (barra de estado); si llega después, se empareja al",
      `empezar la siguiente sesión o antes del siguiente permiso. El QR vale ${PAIR_TTL_MS / 60_000} min y una sola vez.`,
      controller.token ? "El QR lleva el token del controlador: no lo compartas." : "",
    ].filter((l, i, all) => l !== "" || i < all.length - 1).join("\n");
  }

  /** Tras `/nod emparejar`: busca la oferta cada 2 s durante 2 min, con la cuenta atrás en la barra de estado. */
  private watchPairing(p: Platform, ctx: ChannelContext, until: number): void {
    this.pairWatch?.cancel();
    this.pairUntil = until;
    const tick = async (): Promise<void> => {
      const r = await pairOffers(this.controller(ctx), ioOf(p), ctx.instance, this.pairingStore(p, ctx));
      const now = await p.now();
      if (r.paired.length > 0 || now >= this.pairUntil) {
        this.pairWatch = undefined;
        quiet(() => p.status?.(undefined));
        if (r.paired.length > 0) {
          const names = r.paired.map((k) => k.name ?? k.kid).join(", ");
          p.log(`nod control: aprobador emparejado: ${names}`);
          quiet(() => p.toast?.(`Nod: aprobador emparejado (${names})`));
        } else {
          quiet(() => p.toast?.("Nod: no llegó la oferta en 2 min. El QR sigue valiendo: se emparejará en la siguiente sesión o permiso."));
        }
        return;
      }
      quiet(() => p.status?.(`Nod: escanea el QR con el aprobador… (${Math.ceil((this.pairUntil - now) / 1000)} s)`));
      this.pairWatch = p.after(PAIR_POLL_MS, () => void tick().catch(() => undefined));
    };
    void tick().catch(() => undefined);
  }

  private async approversCommand(p: Platform, ctx: ChannelContext, rest: string[]): Promise<string> {
    const path = this.file(ctx, "approvers.json");
    const a = await this.approvers(p, ctx);
    const sub = rest[0]?.toLowerCase();
    if (sub === undefined) {
      if (a.entries.length === 0) return `sin aprobadores emparejados (${path ?? "approvers.json"}): /nod emparejar`;
      const lines = [`aprobadores emparejados (${path}), de toda la máquina:`];
      for (const e of a.entries) lines.push(`  ${e.kid}  ${e.name ?? "(sin nombre)"}${e.added_ms > 0 ? `  desde ${new Date(e.added_ms).toISOString().slice(0, 10)}` : ""}`);
      for (const w of a.ignored) lines.push(`  ignorada: ${w}`);
      lines.push("Para revocar uno: /nod aprobadores quitar <kid>");
      return lines.join("\n");
    }
    if ((sub === "quitar" || sub === "remove") && rest[1] !== undefined && path !== undefined) {
      const r = removeApprover(a.entries, rest[1]);
      if (r === undefined) return `no hay ningún aprobador con kid ${rest[1]} (/nod aprobadores los lista).`;
      await p.write(path, JSON.stringify(r.file, null, 2) + "\n");
      return `aprobador ${r.removed.kid}${r.removed.name ? ` (${r.removed.name})` : ""} revocado: sus firmas dejan de contar desde la siguiente decisión.`;
    }
    return "uso: /nod aprobadores [quitar <kid>]";
  }

  // ---------- ficheros de la máquina ----------

  private controller(ctx: ChannelContext): Controller {
    return { url: ctx.config!.url, token: ctx.config!.token };
  }

  private file(ctx: ChannelContext, name: string): string | undefined {
    const dir = stateDir(ctx.env);
    return dir === undefined ? undefined : `${dir}/${name}`;
  }

  async approvers(p: Platform, ctx: ChannelContext): Promise<ParsedApprovers> {
    const path = this.file(ctx, "approvers.json");
    return parseApprovers(path === undefined ? undefined : await readOr(p, path));
  }

  private pairingStore(p: Platform, ctx: ChannelContext): PairingStore {
    const pairing = this.file(ctx, "pairing.json");
    const approvers = this.file(ctx, "approvers.json");
    return {
      pairKeys: async () => (pairing === undefined ? [] : parsePairing(await readOr(p, pairing))),
      consume: async (k) => {
        if (pairing === undefined) return;
        const left = parsePairing(await readOr(p, pairing)).filter((e) => e.k !== k);
        await p.write(pairing, JSON.stringify({ v: 1, keys: left }, null, 2) + "\n");
      },
      addApprover: async (spki, name) => {
        if (approvers === undefined) return "sin HOME ni XDG_STATE_HOME";
        const r = addApprover((await this.approvers(p, ctx)).entries, spki, name, await p.now());
        if ("error" in r) return r.error;
        await p.write(approvers, JSON.stringify(r.file, null, 2) + "\n");
        return undefined;
      },
    };
  }

  private async isAway(p: Platform, ctx: ChannelContext): Promise<boolean> {
    const path = this.file(ctx, "away.json");
    const text = path === undefined ? undefined : await readOr(p, path);
    return (parseJson(text ?? "") as { away?: unknown } | undefined)?.away === true;
  }

  private async setAway(p: Platform, ctx: ChannelContext, away: boolean): Promise<string | undefined> {
    const path = this.file(ctx, "away.json");
    if (path === undefined) return "sin HOME ni XDG_STATE_HOME";
    try {
      await p.write(path, JSON.stringify({ v: 1, away, since_ms: await p.now() }) + "\n");
      return undefined;
    } catch (err) {
      return String(err);
    }
  }

  private async holdMs(p: Platform, ctx: ChannelContext): Promise<number> {
    return (await this.isAway(p, ctx)) ? AWAY_HOLD_MS : (ctx.config?.holdMs ?? 0);
  }
}

function ioOf(p: Platform): ControlIo {
  return { now: () => p.now(), after: (ms, cb) => p.after(ms, cb), fetch: (url, init) => p.fetch(url, init), random: (n) => p.random(n), log: (m) => p.log(m) };
}

async function readOr(p: Platform, path: string): Promise<string | undefined> {
  try {
    return await p.read(path);
  } catch {
    return undefined;
  }
}

function quiet(f: () => void): void {
  try {
    f();
  } catch {
    // sin superficie (p. ej. -p)
  }
}
