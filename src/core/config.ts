// Configuración de Nod: adónde mandar los eventos, con qué privacidad y con qué identidad.
//
// Orden de precedencia: variables NOD_* > sección del perfil en el fichero > fichero > valores por defecto.
// Sin nada configurado, Nod escribe en un fichero local (~/.local/state/nod/events.jsonl) con privacidad
// `completo`: funciona sin servidor y nada sale de la máquina.
import { PRIVACY_LEVELS } from "./events.js";
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
    try {
      const u = new URL(s);
      return { kind: "http", target: u.toString().replace(/\/+$/, ""), token };
    } catch {
      return `destino inválido: ${s}`;
    }
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
 * `profile` el perfil del agente y `machine` el nombre corto de la máquina (para la instancia por defecto).
 */
export function resolveConfig(env: NodEnv, fileText: string | undefined, profile: string, machine: string | undefined): ConfigResult {
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
      const parsed = parseSink(raw, env.HOME, env.NOD_TOKEN || undefined);
      if (typeof parsed === "string") warnings.push(`NOD_SINKS: ${parsed}`);
      else sinks.push(parsed);
    }
  }
  sinks ??= sinksFrom(section.sinks, env.HOME, warnings, `${path} (perfil ${profile})`);
  sinks ??= sinksFrom(file.sinks, env.HOME, warnings, String(path));
  if (sinks === undefined) {
    const log = defaultLogPath(env);
    sinks = log === undefined ? [] : [{ kind: "file", target: log }];
  }
  // NOD_TOKEN vale para los destinos http que no traen el suyo.
  if (env.NOD_TOKEN) for (const s of sinks) if (s.kind === "http" && s.token === undefined) s.token = env.NOD_TOKEN;

  const privacy = privacyFrom(env.NOD_PRIVACY, warnings, "NOD_PRIVACY") ?? privacyFrom(section.privacy, warnings, `${path} (perfil ${profile})`) ?? privacyFrom(file.privacy, warnings, String(path)) ?? "completo";

  const wanted = env.NOD_INSTANCE || (typeof section.instance === "string" ? section.instance : undefined) || (typeof file.instance === "string" ? file.instance : undefined);
  let instance = defaultInstance(machine, profile);
  if (wanted !== undefined) {
    if (INSTANCE_RE.test(wanted)) instance = wanted;
    else warnings.push(`instancia "${wanted}" inválida (minúsculas, cifras, . _ -; hasta 64): uso ${instance}`);
  }

  const source = env.NOD_SINKS ? "variables NOD_*" : fileText !== undefined ? String(path) : "valores por defecto";
  const task = env.NOD_TASK?.trim() || undefined;
  return { config: { enabled: env.NOD_OFF !== "1", instance, privacy, sinks, task, source }, warnings };
}

/** `mbp-personal`: máquina y perfil, en minúsculas y sin caracteres raros. */
export function defaultInstance(machine: string | undefined, profile: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  const m = clean(machine ?? "") || "local";
  const p = clean(profile) || "claude";
  return `${m}-${p}`.slice(0, 64);
}
