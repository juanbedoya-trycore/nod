// Orbit, sin el agente: todo lo que hace el mod en cada momento de la sesión, sobre una `Platform`.
// Cada adaptador (hosts/claude, …) traduce los eventos de su motor a estos métodos y les pasa su
// `Platform`. Un fallo aquí nunca rompe la sesión: los métodos públicos no lanzan.
//
// Configuración: variables ORBIT_URL, ORBIT_TOKEN, ORBIT_INSTANCE_ID, ORBIT_CTX; sin ninguna, `client.json`
// del directorio de estado del servidor (lo escribe orbit-server al arrancar sin ORBIT_CONFIG).
import { Collector } from "./collector.js";
import { ORBIT_USAGE, formatStatus, parseOrbitArgs } from "./command.js";
import { PERM_HOLD_MS_AWAY, parseConfig, parsePermConfig } from "./config.js";
import type { RawConfig } from "./config.js";
import { Translator } from "./translate.js";
import type { Config, HookPayload } from "./types.js";
import { PermHolder, dropTestKeys, k1Verifier, parseWatchKeys } from "./perm/hold.js";
import type { AbortLike, CheckEvent, PermIo, Verdict } from "./perm/hold.js";
import type { PairedKey } from "./perm/verify.js";
import { sayPlan, verifySay } from "./say.js";
import { REPLIES_FILE, REPLIES_KEY, applyRepliesCommand, parseRepliesCommand, readReplies, writeReplies } from "./replies.js";
import { WatchNotes, linksOf, withContext } from "./links.js";
import { toolInputOf } from "./translate.js";
import { b64uDecode } from "./pairing.js";
import { PAIR_STORE_KEY, SHARED_KEYS_FILE, hexOf, loadPairedKeys, mergeStoredKeys, parsePairCommand, readSharedKeys, readStoredKeys, runPairCommand, writeSharedKeys } from "./pairing.js";
import type { PairingIo, StoredKey } from "./pairing.js";
import {
  SETUP_STORE_KEY, SETUP_WAIT_MS, addSetupKey, autoPair, describePaired, liveSetupKeys, parseClientConfig, qrText,
  readSetupKeys, resolvePhoneUrl, setupLink, stateDirCandidates,
} from "./setup.js";
import type { SetupKeyring } from "./setup.js";
import type { Io } from "./collector.js";
import type { Platform, SessionControl, Timer } from "./platform.js";

/** Dónde instalar el servidor si falta: lo muestra `/nod` sin configuración. */
export const SERVER_INSTALL_HINT = "falta el servidor de Orbit en este Mac: instálalo con tools/install/install-mac.sh del repo Orbit y abre una sesión nueva";

/** `/nod privacidad`: por perfil del agente (cada perfil tiene su propio almacén). */
const PRIVACY_KEY = "orbit.privacy";
/** `/nod away`: el usuario no está delante del Mac. Es de la máquina, no de la sesión. */
const AWAY_KEY = "orbit.away";
const AWAY_FILE = "away.json";
const PAIR_KEYS_PREFIX = PAIR_STORE_KEY("");

const SETUP_HELP = "/nod setup [--link]: QR para el teléfono (Orbit > Escanear QR). --link imprime también el enlace orbit://setup.";

export const COMMAND_DESCRIPTION = "Nod: estado, /nod setup (QR para el teléfono), /nod away, /nod back, /nod respuestas, /nod pause, /nod resume, /nod pair, /nod unpair";

interface Runtime {
  config: Config | undefined;
  errors: string[];
  /** De dónde salió la configuración: variables ORBIT_* o la ruta de client.json. */
  source: string;
  /** `phone_url` de client.json (la URL que irá en el QR). */
  phoneUrl: string | undefined;
  collector: Collector | undefined;
  translator: Translator;
}

/** Datos de la sesión que añade el adaptador al SessionStart y al Stop principal (ver SPEC §8.3). */
export type Extra = Record<string, unknown>;

/** El agente de un tool.call de subagente, si el adaptador sabe buscarlo. */
export type AgentLookup = (agentId: string) => Promise<{ id: string; type?: string; description?: string } | undefined>;

export class NodEngine {
  private runtime: Promise<Runtime> | undefined;
  private timer: Timer | undefined;
  private holder: Promise<PermHolder | undefined> | undefined;
  private watchKeys: PairedKey[] = [];
  /** Turno en curso de la sesión principal (para "Detente" desde el reloj, §6.6). */
  private currentTurnId: string | undefined;
  private sayLoopRunning = false;
  private sessionEnded = false;
  /** "Detente y resume" (§6.6, `recap`): el prompt que sale cuando el turno cortado termine. */
  private pendingRecap: string | undefined;
  private readonly saySeen = new Set<string>();
  /** Mensajes del reloj que llegaron a mitad de turno (van como contexto del siguiente resultado de tool). */
  private readonly notes = new WatchNotes();
  private setupWatch: Timer | undefined;

  // ---------- ciclo de la sesión ----------

  async sessionStart(p: Platform, e: unknown, control: SessionControl, extra: Extra = {}): Promise<void> {
    await this.safely(p, "session.start", async () => {
      const rt = await this.getRuntime(p);
      // Sin esperar: si hay un QR vigente y el teléfono ya publicó la oferta, el reloj queda emparejado.
      void this.checkAutoPair(p, "session.start");
      this.sessionEnded = false;
      void this.sayLoop(p, control);
      const evs = rt.translator.sessionStart(await p.sessionId(), e as never);
      Object.assign(evs[0]!, extra, await this.repliesField(p));
      await this.emit(p, evs, false);
    });
  }

  async turnStart(p: Platform, e: { agentId?: unknown; turnId?: unknown }): Promise<void> {
    await this.safely(p, "turn.start", async () => {
      const rt = await this.getRuntime(p);
      if (e.agentId === undefined && typeof e.turnId === "string") this.currentTurnId = e.turnId;
      await this.emit(p, rt.translator.turnStart(await p.sessionId(), e as never), false);
    });
  }

  async agentSpawn(p: Platform, e: unknown): Promise<void> {
    await this.safely(p, "agent.spawn", async () => {
      (await this.getRuntime(p)).translator.agentSpawn(e as never);
    });
  }

  /** Antes de ejecutar un tool. Si el tool se ejecuta, el terminal ya respondió su permiso (U1). */
  async toolCall(p: Platform, e: { tool_use_id?: unknown; agentId?: unknown }, lookup?: AgentLookup): Promise<void> {
    await this.safely(p, "tool.call.terminal", () => this.terminalAnswered(e.tool_use_id));
    await this.safely(p, "tool.call", async () => {
      const rt = await this.getRuntime(p);
      const id = typeof e.agentId === "string" ? e.agentId : undefined;
      const hint = lookup !== undefined && rt.translator.needsAgentLookup(id) ? await lookup(id!) : undefined;
      await this.emit(p, rt.translator.toolCall(await p.sessionId(), e as never, hint), false);
    });
  }

  /**
   * Después de ejecutar un tool. Devuelve el resultado que debe ver el modelo: con un mensaje del reloj
   * llegado a mitad de turno como contexto (solo la sesión principal).
   */
  async toolResult(p: Platform, e: { tool?: unknown; agentId?: unknown }, result: any, cwd?: string): Promise<unknown> {
    await this.safely(p, "tool.call.result", async () => {
      const rt = await this.getRuntime(p);
      const evs = rt.translator.toolResult(await p.sessionId(), e as never, result);
      const post = evs[evs.length - 1];
      const links = linksOf(String(e.tool), toolInputOf(e as never), result?.text, post?.is_error === true, cwd);
      if (post !== undefined && links.length > 0) post.orbit_links = links;
      await this.emit(p, evs, false);
    });
    const note = e.agentId === undefined ? this.notes.takeContext() : undefined;
    return note === undefined ? result : withContext(result, note);
  }

  /**
   * K2: un `ask` se retiene hasta que gane el reloj, el terminal, el plazo o un abort (SPEC §6.1).
   * `holds` = false (p. ej. auto mode) deja pasar el veredicto sin avisar al reloj.
   */
  async toolCheck(p: Platform, e: unknown, verdict: Verdict, signal: AbortLike | undefined, holds = true): Promise<Verdict> {
    if (verdict?.decision === "ask" && !holds) return verdict;
    await this.safely(p, "tool.check", async () => {
      const rt = await this.getRuntime(p);
      await this.emit(p, rt.translator.toolCheck(await p.sessionId(), e as never, verdict as never), true);
    });
    if (verdict?.decision !== "ask") return verdict;
    return this.holdPermission(p, e as CheckEvent, verdict, signal);
  }

  async turnComplete(p: Platform, e: { agentId?: unknown }, control: SessionControl, extra: () => Promise<Extra>): Promise<void> {
    if (e.agentId === undefined) {
      this.currentTurnId = undefined;
      // "Detente y resume": el turno cortado ya terminó; el resumen va antes que las notas sueltas.
      await this.submitRecap(p, control);
      // Lo que el reloj mandó y no alcanzó a salir como contexto: su propio turno.
      const left = this.notes.takePrompt();
      if (left !== undefined) void control.submitPrompt(left).catch(() => undefined);
    }
    await this.safely(p, "turn.complete", async () => {
      const rt = await this.getRuntime(p);
      const evs = rt.translator.turnComplete(await p.sessionId(), e as never);
      // Fin de turno de la sesión principal: cifras y lugar van en el Stop (el último evento).
      const stop = evs[evs.length - 1];
      if (e.agentId === undefined && stop !== undefined) Object.assign(stop, await extra(), await this.repliesField(p));
      await this.emit(p, evs, e.agentId === undefined);
    });
  }

  async sessionEnd(p: Platform, e: { sessionId?: unknown }): Promise<void> {
    this.sessionEnded = true;
    await this.safely(p, "session.end", async () => {
      const rt = await this.getRuntime(p);
      const sid = typeof e.sessionId === "string" ? e.sessionId : await p.sessionId();
      await this.emit(p, rt.translator.sessionEnd(sid, e as never), true);
    });
  }

  /** `/nod …`. Nunca lanza. */
  async command(p: Platform, args: string): Promise<string> {
    try {
      return await this.runOrbitCommand(p, args);
    } catch (err) {
      return `nod: error (${String(err)})`;
    }
  }

  // ---------- configuración y envío ----------

  private async safely(p: Platform, label: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      p.log(`nod: ${label} falló (${String(err)})`);
    }
  }

  private io(p: Platform): Io {
    return {
      now: () => p.now(),
      post: (url, init) => p.fetch(url, init),
      load: (key) => p.store.get(key),
      save: (key, value) => (value === null ? p.store.delete(key) : p.store.set(key, value)),
      log: (message) => p.log(message),
    };
  }

  /** Lee un fichero del directorio de estado del servidor (el primero que exista). */
  private async readStateFile(p: Platform, name: string): Promise<{ path: string; text: string } | undefined> {
    const env = await p.env();
    for (const d of stateDirCandidates({ stateDir: env.ORBIT_STATE_DIR, home: env.HOME, xdg: env.XDG_CONFIG_HOME })) {
      const path = `${d}/${name}`;
      try {
        return { path, text: String(await p.read(path)) };
      } catch {
        // no existe o no se puede leer: siguiente candidato
      }
    }
    return undefined;
  }

  /** Directorio de estado de Orbit que existe (el que tiene client.json); undefined si no hay ninguno. */
  private async stateDir(p: Platform): Promise<string | undefined> {
    const f = await this.readStateFile(p, "client.json");
    return f === undefined ? undefined : f.path.slice(0, f.path.length - "/client.json".length);
  }

  private async loadRuntime(p: Platform): Promise<Runtime> {
    const all = await p.env();
    const env = { url: all.ORBIT_URL, token: all.ORBIT_TOKEN, instanceId: all.ORBIT_INSTANCE_ID, ctx: all.ORBIT_CTX };
    let raw: RawConfig = env;
    let source = "variables ORBIT_*";
    let phoneUrl: string | undefined;
    // Sin ninguna variable ORBIT_*: la configuración automática del servidor (client.json, 0600).
    const fromEnv = !Object.values(env).every((v) => v === undefined || v.trim() === "");
    if (!fromEnv) {
      const f = await this.readStateFile(p, "client.json");
      const c = f === undefined ? undefined : parseClientConfig(f.text);
      if (f !== undefined && c !== undefined) {
        raw = c.raw;
        phoneUrl = c.phoneUrl;
        source = f.path;
      } else {
        const error = f === undefined ? SERVER_INSTALL_HINT : `${f.path}: no es una configuración de Orbit válida (reinicia orbit-server para que la reescriba)`;
        return { config: undefined, errors: [error], source, phoneUrl, collector: undefined, translator: new Translator() };
      }
    }
    const parsed = parseConfig(raw);
    const translator = new Translator();
    if (!parsed.ok) {
      const errors = fromEnv ? parsed.errors : parsed.errors.map((e) => `${source}: ${e}`);
      return { config: undefined, errors, source, phoneUrl, collector: undefined, translator };
    }
    if ((await p.store.get(PRIVACY_KEY)) === "metadatos") parsed.config.privacy = "metadatos";
    const collector = new Collector(parsed.config, this.io(p));
    await collector.init();
    return { config: parsed.config, errors: [], source, phoneUrl, collector, translator };
  }

  private getRuntime(p: Platform): Promise<Runtime> {
    if (this.runtime === undefined) {
      this.runtime = this.loadRuntime(p).catch((err) => {
        this.runtime = undefined;
        throw err;
      });
    }
    return this.runtime;
  }

  /** Programa (o reprograma) el próximo envío según lo que diga el colector. */
  private async schedule(p: Platform, rt: Runtime): Promise<void> {
    const collector = rt.collector;
    if (collector === undefined) return;
    const wait = collector.delay(await p.now());
    this.timer?.cancel();
    this.timer = undefined;
    if (wait === null) return;
    this.timer = p.after(wait, () => {
      this.timer = undefined;
      void this.flushAndReschedule(p, rt);
    });
  }

  private async flushAndReschedule(p: Platform, rt: Runtime): Promise<void> {
    const collector = rt.collector;
    if (collector === undefined) return;
    collector.io = this.io(p);
    try {
      await collector.flush();
      await this.schedule(p, rt);
    } catch (err) {
      p.log(`nod: fallo al enviar (${String(err)})`);
    }
  }

  /** Traduce, encola y programa el envío. `urgent` envía ya (Stop, SessionEnd, PermissionRequest). */
  private async emit(p: Platform, payloads: HookPayload[], urgent: boolean): Promise<void> {
    if (payloads.length === 0) return;
    const rt = await this.getRuntime(p);
    const collector = rt.collector;
    if (collector === undefined) return;
    collector.io = this.io(p);
    collector.ingest(payloads, await p.now());
    if (urgent) await this.flushAndReschedule(p, rt);
    else await this.schedule(p, rt);
  }

  // ---------- llaves del reloj ----------

  /**
   * Llaves emparejadas: en `paired-keys.json` del directorio de estado, compartido por todos los perfiles.
   * Lo que un perfil tuviera aún en su almacén se migra al fichero la primera vez. Sin directorio de
   * estado (configuración por variables) siguen en el almacén.
   */
  private async loadKeys(p: Platform, key: string): Promise<unknown> {
    const dir = await this.stateDir(p);
    if (dir === undefined) return p.store.get(key);
    const inst = key.slice(PAIR_KEYS_PREFIX.length);
    const f = await this.readStateFile(p, SHARED_KEYS_FILE);
    const shared = readSharedKeys(f?.text);
    const local = readStoredKeys(await p.store.get(key)).stored;
    let keys = shared.instances[inst] ?? [];
    if (local.length > 0) {
      keys = mergeStoredKeys(keys, local);
      await p.write(`${dir}/${SHARED_KEYS_FILE}`, writeSharedKeys(shared, inst, { v: 1, keys }));
      await p.store.delete(key);
    }
    return keys.length === 0 ? undefined : { v: 1, keys };
  }

  private async saveKeys(p: Platform, key: string, value: unknown): Promise<void> {
    const dir = await this.stateDir(p);
    if (dir === undefined) {
      await (value === null ? p.store.delete(key) : p.store.set(key, value));
      return;
    }
    const f = await this.readStateFile(p, SHARED_KEYS_FILE);
    await p.write(`${dir}/${SHARED_KEYS_FILE}`, writeSharedKeys(readSharedKeys(f?.text), key.slice(PAIR_KEYS_PREFIX.length), value as never));
    await p.store.delete(key);
  }

  private pairingIo(p: Platform): PairingIo {
    return {
      now: () => p.now(),
      fetch: (url, init) => p.fetch(url, init),
      load: (key) => (key.startsWith(PAIR_KEYS_PREFIX) ? this.loadKeys(p, key) : p.store.get(key)),
      save: (key, value) =>
        key.startsWith(PAIR_KEYS_PREFIX) ? this.saveKeys(p, key, value) : value === null ? p.store.delete(key) : p.store.set(key, value),
    };
  }

  /**
   * Llaves del reloj emparejadas, leídas en cada permiso (un `unpair` cuenta desde la siguiente dec) y,
   * además, las de ORBIT_WATCH_KEYS (atajo para pruebas y despliegues sin interacción).
   */
  private async loadWatchKeys(p: Platform, instanceId: string): Promise<PairedKey[]> {
    // Las llaves de prueba de protocol/vectors/sig (clave privada pública) nunca cuentan como emparejadas.
    const { keys, dropped } = dropTestKeys(await loadPairedKeys(instanceId, { load: (key) => this.loadKeys(p, key) }));
    if (dropped > 0) p.log(`nod: ${dropped} llave(s) de prueba ignoradas (su clave privada es pública)`);
    const parsed = parseWatchKeys((await p.env()).ORBIT_WATCH_KEYS);
    if (!parsed.ok) {
      p.log(`nod: ORBIT_WATCH_KEYS ignorada (${parsed.error})`);
      return keys;
    }
    for (const k of parsed.keys) if (!keys.some((o) => hexOf(o.kid) === hexOf(k.kid))) keys.push(k);
    return keys;
  }

  // ---------- emparejamiento automático por QR (SPEC §6.3.1) ----------

  /** K del almacén (los de /nod setup) y de setup.json del directorio de estado (los de orbit-server setup). */
  private keyring(p: Platform, instanceId: string): SetupKeyring {
    const storeKey = SETUP_STORE_KEY(instanceId);
    return {
      list: async () => {
        const fromStore = readSetupKeys(await p.store.get(storeKey));
        const f = await this.readStateFile(p, "setup.json");
        return f === undefined ? fromStore : [...fromStore, ...readSetupKeys(f.text)];
      },
      consume: async (k) => {
        const mine = readSetupKeys(await p.store.get(storeKey));
        if (mine.some((x) => x.k === k)) {
          const rest = mine.filter((x) => x.k !== k);
          if (rest.length === 0) await p.store.delete(storeKey);
          else await p.store.set(storeKey, { v: 1, keys: rest });
        }
        const f = await this.readStateFile(p, "setup.json");
        if (f !== undefined) {
          const all = readSetupKeys(f.text);
          if (all.some((x) => x.k === k)) await p.write(f.path, JSON.stringify({ v: 1, keys: all.filter((x) => x.k !== k) }, null, 2) + "\n");
        }
      },
    };
  }

  /** Busca ofertas del teléfono firmadas con un K vigente y las empareja. Nunca lanza. */
  private async checkAutoPair(p: Platform, why: string): Promise<StoredKey[]> {
    try {
      const rt = await this.getRuntime(p);
      if (rt.config === undefined) return [];
      const cfg = { url: rt.config.url, token: rt.config.token, instanceId: rt.config.instanceId };
      const r = await autoPair(cfg, this.pairingIo(p), this.keyring(p, cfg.instanceId));
      if (r.rejected > 0) p.log(`nod: ${r.rejected} oferta(s) con etiqueta que no verifica (${why}): se quedan para /nod pair`);
      for (const k of r.paired) {
        p.log(`nod: emparejada por QR (${why}): ${describePaired(k)}`);
        p.toast(`Nod: reloj emparejado: ${describePaired(k)}`);
      }
      return r.paired;
    } catch (err) {
      p.log(`nod: emparejamiento automático falló (${String(err)})`);
      return [];
    }
  }

  /** Tras /nod setup: mira cada 2 s durante 2 min si ya llegó la oferta del teléfono. */
  private watchSetup(p: Platform, until: number): void {
    this.setupWatch?.cancel();
    const tick = async (): Promise<void> => {
      const now = Number(await p.now());
      const paired = await this.checkAutoPair(p, "/nod setup");
      if (paired.length > 0 || now >= until) {
        this.setupWatch = undefined;
        p.status(undefined);
        if (paired.length === 0) p.toast("Nod: no llegó la oferta del teléfono en 2 min. El QR sigue valiendo 15 min: se emparejará en la siguiente sesión o con /nod.");
        return;
      }
      p.status(`Nod: escanea el QR con el teléfono… (${Math.ceil((until - now) / 1000)} s)`);
      this.setupWatch = p.after(2000, () => void tick());
    };
    void tick();
  }

  private async runSetupCommand(p: Platform, args: string): Promise<string> {
    const rt = await this.getRuntime(p);
    if (rt.config === undefined) return ["orbit sin configurar: no puedo generar el QR", ...rt.errors.map((e) => `  - ${e}`)].join("\n");
    const cfg = rt.config;
    let clientPhone = rt.phoneUrl;
    if (clientPhone === undefined) {
      const f = await this.readStateFile(p, "client.json");
      const c = f === undefined ? undefined : parseClientConfig(f.text);
      if (c !== undefined && c.raw.instanceId === cfg.instanceId) clientPhone = c.phoneUrl;
    }
    const phone = resolvePhoneUrl((await p.env()).ORBIT_PHONE_URL, clientPhone, cfg.url);
    if (phone === undefined) {
      return `no sé qué dirección usará el teléfono (${cfg.url} es de este Mac). Define ORBIT_PHONE_URL=http://<IP de Tailscale o de la Wi-Fi>:7878 o arranca orbit-server sin ORBIT_CONFIG (calcula la IP solo).`;
    }
    const now = Number(await p.now());
    const k = await randomBytes(p, 32);
    const storeKey = SETUP_STORE_KEY(cfg.instanceId);
    await p.store.set(storeKey, addSetupKey(readSetupKeys(await p.store.get(storeKey)), k, cfg.instanceId, now));
    const link = setupLink(phone, cfg.instanceId, cfg.token, k);
    this.watchSetup(p, now + SETUP_WAIT_MS);
    const lines = [
      "QR para configurar el teléfono:",
      qrText(link),
      "",
      "Escanea el QR con el teléfono… (Orbit > Escanear QR)",
      `  servidor ${phone}, instancia ${cfg.instanceId}. Válido 15 min y una sola vez.`,
      "  El teléfono se configura solo, pide la llave al reloj y el reloj queda emparejado sin comparar huellas.",
      "  Espero la oferta 2 min (barra de estado); después se empareja en la siguiente sesión, en cada permiso o con /nod.",
      "  El QR lleva el token de la instancia: no lo compartas.",
    ];
    if (/(^|\s)--link(\s|$)/.test(args)) lines.push("", link);
    return lines.join("\n");
  }

  private async pairingSummary(p: Platform, instanceId: string): Promise<string> {
    const keys = await loadPairedKeys(instanceId, { load: (key) => this.loadKeys(p, key) });
    const now = Number(await p.now());
    const live = liveSetupKeys(readSetupKeys(await p.store.get(SETUP_STORE_KEY(instanceId))), instanceId, now);
    const lines = [
      keys.length === 0
        ? "  reloj: sin emparejar (/nod setup y escanear el QR con el teléfono)"
        : `  reloj: ${keys.length} llave(s) emparejada(s): ${keys.map((k) => hexOf(k.kid).match(/.{4}/g)!.join(" ")).join(", ")} (/nod pair keys)`,
    ];
    if (live.length > 0) lines.push(`  QR de emparejamiento vigente (${live.length}): esperando la oferta del teléfono`);
    return lines.join("\n");
  }

  // ---------- /nod ----------

  private async runOrbitCommand(p: Platform, args: string): Promise<string> {
    const replies = parseRepliesCommand(args);
    if (replies !== undefined) {
      const r = applyRepliesCommand(await this.loadReplies(p), replies);
      if (r.changed) await this.saveReplies(p, r.list);
      return r.changed ? `${r.message}\n  el reloj las verá al acabar el siguiente turno de cada sesión` : r.message;
    }
    if (/^\s*setup(\s|$)/i.test(args)) {
      if (/(^|\s)(-h|--help|help)(\s|$)/.test(args)) return SETUP_HELP;
      return this.runSetupCommand(p, args);
    }
    // /nod pair [confirm|reject <huella>|keys] y /nod unpair <huella> (K1, emparejamiento del reloj).
    const pair = parsePairCommand(args);
    if (pair !== undefined) {
      const rt = await this.getRuntime(p);
      const instanceId = rt.config?.instanceId ?? (await p.env()).ORBIT_INSTANCE_ID;
      const cfg = rt.config === undefined ? undefined : { url: rt.config.url, token: rt.config.token, instanceId: rt.config.instanceId };
      return runPairCommand(cfg, this.pairingIo(p), pair, typeof instanceId === "string" && instanceId.trim() !== "" ? instanceId.trim() : undefined);
    }
    const action = parseOrbitArgs(args);
    if (action === "invalid") return ORBIT_USAGE;
    const rt = await this.getRuntime(p);
    const collector = rt.collector;
    if (collector !== undefined) {
      collector.io = this.io(p);
      if (action === "pause") await collector.setPaused(true);
      if (action === "resume") {
        await collector.setPaused(false);
        await this.schedule(p, rt);
      }
    }
    if ((action === "privacy-full" || action === "privacy-metadata") && rt.config !== undefined) {
      const priv = action === "privacy-metadata" ? "metadatos" : "completa";
      await p.store.set(PRIVACY_KEY, priv);
      rt.config.privacy = priv;
    }
    if (action === "away") await this.setAway(p, true);
    if (action === "back") await this.setAway(p, false);
    let text = formatStatus(rt.config, rt.errors, collector?.status(), await p.now());
    text += (await this.isAway(p))
      ? "\n  modo lejos: el reloj tiene 90 s para decidir antes de que salga el diálogo del terminal (/nod back para volver)"
      : "\n  modo cerca: el reloj tiene 20 s para decidir; luego decide el terminal (/nod away si te vas del Mac)";
    if (rt.config !== undefined) {
      const paired = await this.checkAutoPair(p, "/nod");
      text += `\n  configuración: ${rt.source}`;
      text += `\n${await this.pairingSummary(p, rt.config.instanceId)}`;
      if (paired.length > 0) text += `\n  emparejado ahora por QR: ${paired.map(describePaired).join(", ")}`;
    }
    if (collector === undefined) return text;
    const prefix: Partial<Record<typeof action, string>> = {
      pause: "envío en pausa",
      resume: "envío reanudado",
      "privacy-full": "privacidad completa en este perfil: se envía todo (prompts, comandos y rutas)",
      "privacy-metadata": "privacidad de metadatos en este perfil: solo estructura, tiempos y verbos; el reloj solo podrá aprobar viendo el verbo",
      away: "lejos del Mac: el reloj espera hasta 90 s",
      back: "de vuelta: el reloj espera 20 s",
    };
    return prefix[action] === undefined ? text : `${prefix[action]}\n${text}`;
  }

  // ---------- permisos desde el reloj (K2, SPEC §6) ----------
  // Env: ORBIT_PERM (on|off), ORBIT_PERM_HOLD_MS (1000..90000), ORBIT_FORBIDDEN / ORBIT_FORBIDDEN_ADD
  // (arrays JSON de regex, §6.4), ORBIT_WATCH_KEYS. Toda la lógica está en perm/hold.ts.

  private permIo(p: Platform): PermIo {
    return {
      now: () => p.now(),
      fetch: (url, init) => p.fetch(url, init as never),
      after: (ms, cb) => p.after(ms, cb),
      random: (n) => randomBytes(p, n),
      log: (message) => p.log(message),
    };
  }

  private async loadHolder(p: Platform, config: Config): Promise<PermHolder | undefined> {
    const env = await p.env();
    const parsed = parsePermConfig({ enabled: env.ORBIT_PERM, holdMs: env.ORBIT_PERM_HOLD_MS, forbidden: env.ORBIT_FORBIDDEN, forbiddenAdd: env.ORBIT_FORBIDDEN_ADD });
    if (!parsed.ok) {
      p.log(`nod: retención de permisos desactivada (${parsed.errors.join("; ")})`);
      return undefined;
    }
    return new PermHolder({ config, perm: parsed.perm, io: this.permIo(p), verify: k1Verifier(() => this.watchKeys) });
  }

  private getHolder(p: Platform, config: Config): Promise<PermHolder | undefined> {
    if (this.holder === undefined) {
      this.holder = this.loadHolder(p, config).catch(() => {
        this.holder = undefined;
        return undefined;
      });
    }
    return this.holder;
  }

  /** §6.1 a partir de `v`. Cualquier fallo devuelve `v`: Orbit nunca bloquea la sesión. */
  private async holdPermission(p: Platform, e: CheckEvent, v: Verdict, signal: AbortLike | undefined): Promise<Verdict> {
    try {
      const rt = await this.getRuntime(p);
      if (rt.config === undefined) return v;
      const h = await this.getHolder(p, rt.config);
      if (h === undefined) return v;
      // Un QR recién escaneado: la oferta del teléfono puede estar esperando. Se empareja antes de decidir.
      await this.checkAutoPair(p, "tool.check");
      this.watchKeys = await this.loadWatchKeys(p, rt.config.instanceId);
      // Sin reloj emparejado ninguna dec se aceptaría: retener solo retrasaría el diálogo del terminal.
      if (this.watchKeys.length === 0) return v;
      const holdMs = (await this.isAway(p)) ? PERM_HOLD_MS_AWAY : undefined;
      return await h.hold(e, v, { sessionId: await p.sessionId(), signal, io: this.permIo(p), holdMs });
    } catch (err) {
      p.log(`nod: retención falló (${String(err)})`);
      return v;
    }
  }

  /** U1: si el tool llega a ejecutarse mientras se retiene su permiso, el terminal ya respondió (allow). */
  private async terminalAnswered(toolUseId: unknown): Promise<void> {
    if (typeof toolUseId !== "string" || this.holder === undefined) return;
    (await this.holder)?.terminal(toolUseId, "allow");
  }

  // ---------- modo lejos y respuestas rápidas (SPEC §6.6.1) ----------

  private async isAway(p: Platform): Promise<boolean> {
    try {
      const f = await this.readStateFile(p, AWAY_FILE);
      if (f !== undefined) return (JSON.parse(f.text) as { away?: unknown }).away === true;
      return (await p.store.get(AWAY_KEY)) === true;
    } catch {
      return false;
    }
  }

  private async setAway(p: Platform, away: boolean): Promise<void> {
    const dir = await this.stateDir(p);
    if (dir === undefined) {
      await p.store.set(AWAY_KEY, away);
      return;
    }
    await p.write(`${dir}/${AWAY_FILE}`, JSON.stringify({ away }) + "\n");
    await p.store.delete(AWAY_KEY);
  }

  /** Lista configurada con `/nod respuestas`; undefined = sin configurar (el reloj usa las suyas). */
  private async loadReplies(p: Platform): Promise<string[] | undefined> {
    try {
      const f = await this.readStateFile(p, REPLIES_FILE);
      if (f !== undefined) return readReplies(f.text);
      return readReplies(await p.store.get(REPLIES_KEY));
    } catch {
      return undefined;
    }
  }

  private async saveReplies(p: Platform, list: string[]): Promise<void> {
    const value = writeReplies(list);
    const dir = await this.stateDir(p);
    if (dir === undefined) {
      await p.store.set(REPLIES_KEY, value);
      return;
    }
    await p.write(`${dir}/${REPLIES_FILE}`, JSON.stringify(value, null, 2) + "\n");
    await p.store.delete(REPLIES_KEY);
  }

  /** Campo `orbit_replies` para SessionStart y el Stop principal (la lista blanca lo quita en work, §3.4). */
  private async repliesField(p: Platform): Promise<Record<string, unknown>> {
    const list = await this.loadReplies(p);
    return list === undefined ? {} : { orbit_replies: list };
  }

  // ---------- respuestas desde el reloj (SPEC §6.6) ----------

  /**
   * Long-poll de `GET /v0/say` mientras dure la sesión y haya un reloj emparejado. Cada `say` se verifica
   * (llave emparejada, instancia, sid de esta sesión, ventana de 120 s, nonce de un solo uso): `text` entra
   * como prompt propio en cuanto la sesión queda libre; `stop` corta el turno en curso. Nunca lanza.
   */
  private async sayLoop(p: Platform, control: SessionControl): Promise<void> {
    if (this.sayLoopRunning) return;
    this.sayLoopRunning = true;
    const sleep = (ms: number) => new Promise<void>((resolve) => p.after(ms, () => resolve()));
    try {
      while (!this.sessionEnded) {
        const rt = await this.getRuntime(p);
        if (rt.config === undefined) return;
        const keys = await this.loadWatchKeys(p, rt.config.instanceId);
        if (keys.length === 0) {
          await sleep(30_000);
          continue;
        }
        const sess = await p.sessionId();
        let r;
        try {
          r = await p.fetch(`${rt.config.url}/v0/say?session_id=${encodeURIComponent(sess)}&wait=20000`, {
            headers: { authorization: `Bearer ${rt.config.token}` },
          });
        } catch {
          await sleep(5_000);
          continue;
        }
        if (r.status === 204) continue;
        if (r.status !== 200) {
          await sleep(5_000);
          continue;
        }
        let list: string[] = [];
        try {
          list = (JSON.parse(String(r.text)) as { say?: string[] }).say ?? [];
        } catch {
          continue;
        }
        for (const b64 of list) await this.onSay(p, control, b64, keys, rt.config.instanceId, sess);
      }
    } catch (err) {
      p.log(`nod: respuestas del reloj desactivadas (${String(err)})`);
    } finally {
      this.sayLoopRunning = false;
    }
  }

  private async onSay(p: Platform, control: SessionControl, b64: string, keys: PairedKey[], instanceId: string, sess: string): Promise<void> {
    const v = verifySay(b64uDecode(b64), keys, Number(await p.now()) / 1000, instanceId, sess, this.saySeen);
    if (!v.ok) {
      p.log(`nod: respuesta del reloj descartada (${v.reason})`);
      return;
    }
    this.saySeen.add(v.nonceHex);
    const plan = sayPlan(v.kind, v.text, this.currentTurnId !== undefined);
    if (plan.submitAfterTurn !== undefined) this.pendingRecap = plan.submitAfterTurn;
    if (plan.abort && this.currentTurnId !== undefined) {
      await control.abortTurn(this.currentTurnId).catch(() => undefined);
      p.log(`nod: el reloj detuvo el turno${v.kind === "recap" ? " y pide un resumen" : ""}`);
      // Si el turno cortado no llega a cerrarse (turn.complete), el resumen sale igual en cuanto quede libre.
      if (this.pendingRecap !== undefined) p.after(3_000, () => void this.submitRecap(p, control));
    } else if (v.kind === "stop") {
      p.log("nod: el reloj detuvo el turno");
    }
    if (plan.note !== undefined) {
      // A mitad de turno: el modelo lo lee junto al siguiente resultado de tool, sin esperar a terminar.
      this.notes.push(plan.note);
      p.log("nod: nota del reloj para el turno en curso");
    }
    if (plan.submitNow !== undefined) {
      void control.submitPrompt(plan.submitNow).catch(() => undefined);
      p.log(`nod: ${v.kind === "recap" ? "resumen pedido" : "prompt"} desde el reloj`);
    }
  }

  /** Envía el "Detente y resume" pendiente si la sesión principal ya está libre. Nunca lanza. */
  private async submitRecap(p: Platform, control: SessionControl): Promise<void> {
    if (this.pendingRecap === undefined || this.currentTurnId !== undefined) return;
    const text = this.pendingRecap;
    this.pendingRecap = undefined;
    try {
      await control.submitPrompt(text);
      p.log("nod: resumen pedido desde el reloj");
    } catch (err) {
      p.log(`nod: no se pudo pedir el resumen (${String(err)})`);
    }
  }
}

/** n bytes de un CSPRNG: `crypto.getRandomValues` si el entorno lo tiene; si no, `openssl rand` (U8). */
export async function randomBytes(p: Platform, n: number): Promise<Uint8Array> {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c !== undefined && typeof c.getRandomValues === "function") return c.getRandomValues(new Uint8Array(n));
  const r = await p.run(["openssl", "rand", "-hex", String(n)]);
  const hex = String(r?.stdout ?? "").trim();
  if (!new RegExp(`^[0-9a-f]{${2 * n}}$`).test(hex)) throw new Error("sin CSPRNG");
  return Uint8Array.from(hex.match(/../g)!.map((h: string) => parseInt(h, 16)));
}
