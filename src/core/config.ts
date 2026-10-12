// Configuración de Nod: adónde mandar los eventos, con qué privacidad y con qué identidad.
//
// Orden de precedencia: variables NOD_* > sección del perfil en el fichero > fichero > valores por defecto.
// Sin nada configurado, Nod escribe en un fichero local (~/.local/state/nod/events.jsonl) con privacidad
// `completo`: funciona sin servidor y nada sale de la máquina.
import { PRIVACY_LEVELS } from "./events.js";
import { isLocalUrl } from "./privacy.js";
import type { Privacy } from "./events.js";

/** Variables que lee Nod. El adaptador las lee (en Claude, con nombres literales) y las pasa tal cual. */
export interface NodEnv {
  NOD_SINKS?: string | undefined;
  NOD_TOKEN?: string | undefined;
  NOD_PRIVACY?: string | undefined;
  NOD_INSTANCE?: string | undefined;
  NOD_TASK?: string | undefined;
  NOD_CONFIG?: string | undefined;
  NOD_OFF?: string | undefined;
  NOD_CONTROL?: string | undefined;
  NOD_CONTROL_TOKEN?: string | undefined;
  NOD_FORBIDDEN_ADD?: string | undefined;
  HOME?: string | undefined;
  XDG_CONFIG_HOME?: string | undefined;
  XDG_STATE_HOME?: string | undefined;
}

export interface SinkConfig {
  kind: "file" | "http";
  /** Ruta absoluta (file) o URL base (http, sin /v1/events). */
  target: string;
  token?: string | undefined;
  /** Fichero del que se lee el token al arrancar (`token_file`): el token no tiene que ir en la configuración. */
  tokenFile?: string | undefined;
}

/** Canal de control (docs/control-v1.md §2). */
export interface ControlConfig {
  /** URL base del controlador, sin barra final. */
  url: string;
  token?: string | undefined;
  tokenFile?: string | undefined;
  /** Cuánto se retiene un permiso (1000…90000). */
  holdMs: number;
  /** Por qué no se usa, si la configuración lo impide (el token iría en claro, el token_file no se lee…). */
  off?: string | undefined;
}

export const HOLD_MS_DEFAULT = 20_000;
export const HOLD_MS_MIN = 1_000;
export const HOLD_MS_MAX = 90_000;

export interface Config {
  enabled: boolean;
  instance: string;
  privacy: Privacy;
  sinks: SinkConfig[];
  task: string | undefined;
  /** Canal de control; undefined = sin configurar (Nod no retiene ni cambia nada). */
  control: ControlConfig | undefined;
  /** De dónde salió: para `/nod`. */
  source: string;
}

interface FileSection {
  sinks?: unknown;
  privacy?: unknown;
  instance?: unknown;
  control?: unknown;
}

interface ConfigFile extends FileSection {
  profiles?: Record<string, FileSection>;
}

export interface ConfigResult {
  config: Config;
  /** Avisos (valores ignorados): la configuración sigue siendo usable. */
  warnings: string[];
}

const INSTANCE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function configPath(env: NodEnv): string | undefined {
  if (env.NOD_CONFIG) return expandHome(env.NOD_CONFIG, env.HOME);
  if (env.XDG_CONFIG_HOME) return `${env.XDG_CONFIG_HOME}/nod/config.json`;
  return env.HOME ? `${env.HOME}/.config/nod/config.json` : undefined;
}

export function defaultLogPath(env: NodEnv): string | undefined {
  const dir = stateDir(env);
  return dir === undefined ? undefined : `${dir}/events.jsonl`;
}

/** Estado de Nod en la máquina (no del perfil): eventos por defecto, llaves emparejadas, K's, modo lejos. */
export function stateDir(env: NodEnv): string | undefined {
  if (env.XDG_STATE_HOME) return `${env.XDG_STATE_HOME}/nod`;
  return env.HOME ? `${env.HOME}/.local/state/nod` : undefined;
}

function expandHome(p: string, home: string | undefined): string {
  return home !== undefined && (p === "~" || p.startsWith("~/")) ? home + p.slice(1) : p;
}

/** Un destino escrito como texto: `http(s)://…`, `file:/ruta` o una ruta absoluta (o con ~). */
export function parseSink(raw: string, home: string | undefined, token?: string): SinkConfig | string {
  const s = raw.trim();
  if (/^https?:\/\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return "destino http inválido (URL mal formada)";
    }
    // Credenciales o parámetros en la URL acabarían en /nod y en los registros: el token va aparte.
    if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") {
      return `destino ${u.protocol}//${u.host} ignorado: la URL no puede llevar usuario, contraseña, ?parámetros ni #fragmento (usa "token")`;
    }
    return { kind: "http", target: `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, ""), token };
  }
  const path = expandHome(s.startsWith("file:") ? s.slice(5).replace(/^\/\/(?=\/)/, "") : s, home);
  if (path.startsWith("/")) return { kind: "file", target: path };
  return `destino inválido (usa http://…, https://… o una ruta absoluta): ${s}`;
}

function sinksFrom(v: unknown, home: string | undefined, warnings: string[], where: string): SinkConfig[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    warnings.push(`${where}: "sinks" debe ser una lista`);
    return undefined;
  }
  const out: SinkConfig[] = [];
  for (const item of v) {
    const o = (typeof item === "string" ? { url: item } : item) as Record<string, unknown> | null;
    const raw = typeof o?.url === "string" ? o.url : typeof o?.file === "string" ? o.file : undefined;
    if (raw === undefined) {
      warnings.push(`${where}: destino sin "url" ni "file"`);
      continue;
    }
    const parsed = parseSink(raw, home, typeof o?.token === "string" ? o.token : undefined);
    if (typeof parsed === "string") {
      warnings.push(`${where}: ${parsed}`);
      continue;
    }
    if (typeof o?.token_file === "string" && parsed.kind === "http") {
      if (parsed.token !== undefined) warnings.push(`${where}: ${parsed.target} tiene "token" y "token_file": uso "token"`);
      else parsed.tokenFile = expandHome(o.token_file, home);
    }
    out.push(parsed);
  }
  return out;
}

function privacyFrom(v: unknown, warnings: string[], where: string): Privacy | undefined {
  if (v === undefined || v === "") return undefined;
  if (typeof v === "string" && (PRIVACY_LEVELS as readonly string[]).includes(v)) return v as Privacy;
  warnings.push(`${where}: privacidad "${String(v)}" no existe (completo, redactado, trabajo)`);
  return undefined;
}

/**
 * Configuración efectiva. `fileText` es el contenido del fichero de configuración (undefined si no existe),
 * `profile` el perfil del agente y `anonId` un id aleatorio y estable de este perfil en esta máquina (la
 * instancia por defecto es `<perfil>-<anonId>`: única sin revelar el nombre de la máquina).
 */
export function resolveConfig(env: NodEnv, fileText: string | undefined, profile: string, anonId: string): ConfigResult {
  const warnings: string[] = [];
  let file: ConfigFile = {};
  const path = configPath(env);
  if (fileText !== undefined) {
    try {
      const parsed = JSON.parse(fileText) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) file = parsed as ConfigFile;
      else warnings.push(`${path}: no es un objeto JSON`);
    } catch (err) {
      warnings.push(`${path}: JSON inválido (${String(err)})`);
    }
  }
  const section: FileSection = (file.profiles && typeof file.profiles === "object" ? file.profiles[profile] : undefined) ?? {};

  let sinks: SinkConfig[] | undefined;
  if (env.NOD_SINKS !== undefined && env.NOD_SINKS.trim() !== "") {
    sinks = [];
    for (const raw of env.NOD_SINKS.split(/[\s,]+/).filter(Boolean)) {
      const parsed = parseSink(raw, env.HOME);
      if (typeof parsed === "string") {
        warnings.push(`NOD_SINKS: ${parsed}`);
        continue;
      }
      // NOD_TOKEN es para los destinos de NOD_SINKS, y nunca viaja en claro fuera de la máquina.
      if (parsed.kind === "http" && env.NOD_TOKEN) {
        if (parsed.target.startsWith("https://") || isLocalUrl(parsed.target)) parsed.token = env.NOD_TOKEN;
        else warnings.push(`NOD_TOKEN no se manda a ${parsed.target}: es http sin cifrar y no es local (usa https)`);
      }
      sinks.push(parsed);
    }
  }
  sinks ??= sinksFrom(section.sinks, env.HOME, warnings, `${path} (perfil ${profile})`);
  sinks ??= sinksFrom(file.sinks, env.HOME, warnings, String(path));
  if (sinks === undefined) {
    const log = defaultLogPath(env);
    sinks = log === undefined ? [] : [{ kind: "file", target: log }];
  }

  const privacy = privacyFrom(env.NOD_PRIVACY, warnings, "NOD_PRIVACY") ?? privacyFrom(section.privacy, warnings, `${path} (perfil ${profile})`) ?? privacyFrom(file.privacy, warnings, String(path)) ?? "completo";

  const wanted = env.NOD_INSTANCE || (typeof section.instance === "string" ? section.instance : undefined) || (typeof file.instance === "string" ? file.instance : undefined);
  let instance = defaultInstance(profile, anonId);
  if (wanted !== undefined) {
    if (INSTANCE_RE.test(wanted)) instance = wanted;
    else warnings.push(`instancia "${wanted}" inválida (minúsculas, cifras, . _ -; hasta 64): uso ${instance}`);
  }

  const source = env.NOD_SINKS ? "variables NOD_*" : fileText !== undefined ? String(path) : "valores por defecto";
  const task = env.NOD_TASK?.trim() || undefined;
  const control = controlFrom(env, section.control ?? file.control, warnings, String(path));
  return { config: { enabled: env.NOD_OFF !== "1", instance, privacy, sinks, task, control, source }, warnings };
}

/** `NOD_CONTROL=off` (o `0`, `no`) apaga el canal aunque el fichero lo configure. */
const OFF_RE = /^(off|0|no|false)$/i;

function controlFrom(env: NodEnv, raw: unknown, warnings: string[], where: string): ControlConfig | undefined {
  const fromEnv = env.NOD_CONTROL?.trim();
  if (fromEnv !== undefined && OFF_RE.test(fromEnv)) return undefined;
  const o = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  if (raw !== undefined && o === undefined) warnings.push(`${where}: "control" debe ser un objeto`);
  const url = fromEnv || (typeof o?.url === "string" ? o.url : undefined);
  if (url === undefined) return undefined;
  const label = fromEnv ? "NOD_CONTROL" : `${where} (control)`;
  const parsed = parseSink(url, env.HOME);
  if (typeof parsed === "string" || parsed.kind !== "http") {
    warnings.push(`${label}: el controlador debe ser una URL http(s) sin usuario, contraseña ni parámetros`);
    return undefined;
  }
  const c: ControlConfig = { url: parsed.target, holdMs: HOLD_MS_DEFAULT };
  if (env.NOD_CONTROL_TOKEN) c.token = env.NOD_CONTROL_TOKEN;
  else if (typeof o?.token === "string" && o.token !== "") c.token = o.token;
  else if (typeof o?.token_file === "string" && o.token_file !== "") c.tokenFile = expandHome(o.token_file, env.HOME);
  if (o?.hold_ms !== undefined) {
    const n = Number(o.hold_ms);
    if (!Number.isFinite(n)) warnings.push(`${label}: hold_ms "${String(o.hold_ms)}" no es un número: uso ${HOLD_MS_DEFAULT}`);
    else {
      c.holdMs = Math.min(HOLD_MS_MAX, Math.max(HOLD_MS_MIN, Math.round(n)));
      if (c.holdMs !== n) warnings.push(`${label}: hold_ms debe estar entre ${HOLD_MS_MIN} y ${HOLD_MS_MAX}: uso ${c.holdMs}`);
    }
  }
  // Con token, el controlador puede aprobar en nombre del usuario lo que le enseñe un aprobador: no viaja en claro.
  if ((c.token !== undefined || c.tokenFile !== undefined) && !c.url.startsWith("https://") && !isLocalUrl(c.url)) {
    c.off = `el token no se manda en claro a ${c.url} (usa https)`;
    warnings.push(`control: ${c.off}`);
  }
  return c;
}

/** Por qué el canal no se usa con esta privacidad, o undefined si se usa. */
export function controlBlocked(c: ControlConfig | undefined, privacy: Privacy): string | undefined {
  if (c === undefined) return "sin configurar";
  if (c.off !== undefined) return c.off;
  if (privacy === "trabajo" && !isLocalUrl(c.url)) return "privacidad trabajo y el controlador no es local";
  return undefined;
}

/**
 * Lee los `token_file` (de los destinos y del controlador) con `read`. Un fichero que no se lee deja el
 * destino sin token (el destino lo rechazará y la cola espera) y apaga el canal de control.
 */
export async function loadTokenFiles(config: Config, read: (path: string) => Promise<string>, warnings: string[]): Promise<void> {
  const load = async (path: string): Promise<string | undefined> => {
    try {
      const t = (await read(path)).trim();
      if (t !== "") return t;
      warnings.push(`token_file ${path} está vacío`);
    } catch {
      warnings.push(`token_file ${path} no se puede leer`);
    }
    return undefined;
  };
  for (const s of config.sinks) if (s.tokenFile !== undefined && s.token === undefined) s.token = await load(s.tokenFile);
  const c = config.control;
  if (c?.tokenFile !== undefined && c.token === undefined) {
    c.token = await load(c.tokenFile);
    if (c.token === undefined) c.off ??= `no se pudo leer el token (${c.tokenFile})`;
  }
}

/** `personal-3fa9c2d1`: perfil e id aleatorio del perfil en esta máquina, en minúsculas y sin caracteres raros. */
export function defaultInstance(profile: string, anonId: string): string {
  const clean = (x: string) => x.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  const id = clean(anonId).slice(0, 16) || "0";
  const p = (clean(profile) || "claude").slice(0, 63 - id.length);
  return `${p}-${id}`;
}
