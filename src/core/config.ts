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
  HOME?: string | undefined;
  XDG_CONFIG_HOME?: string | undefined;
  XDG_STATE_HOME?: string | undefined;
}

export interface SinkConfig {
  kind: "file" | "http";
  /** Ruta absoluta (file) o URL base (http, sin /v1/events). */
  target: string;
  token?: string | undefined;
}

export interface Config {
  enabled: boolean;
  instance: string;
  privacy: Privacy;
  sinks: SinkConfig[];
  task: string | undefined;
  /** De dónde salió: para `/nod`. */
  source: string;
}

interface FileSection {
  sinks?: unknown;
  privacy?: unknown;
  instance?: unknown;
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
  if (env.XDG_STATE_HOME) return `${env.XDG_STATE_HOME}/nod/events.jsonl`;
  return env.HOME ? `${env.HOME}/.local/state/nod/events.jsonl` : undefined;
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
    if (typeof parsed === "string") warnings.push(`${where}: ${parsed}`);
    else out.push(parsed);
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
  return { config: { enabled: env.NOD_OFF !== "1", instance, privacy, sinks, task, source }, warnings };
}

/** `personal-3fa9c2d1`: perfil e id aleatorio del perfil en esta máquina, en minúsculas y sin caracteres raros. */
export function defaultInstance(profile: string, anonId: string): string {
  const clean = (x: string) => x.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  const id = clean(anonId).slice(0, 16) || "0";
  const p = (clean(profile) || "claude").slice(0, 63 - id.length);
  return `${p}-${id}`;
}
