// Lo que el núcleo necesita del agente que lo aloja (Claude Code, OpenCode…). Cada adaptador construye una
// `Platform` con lo que le da su motor; el núcleo no conoce a ninguno.
import type { NodEnv } from "./config.js";

export interface HttpResponse {
  status: number;
  ok: boolean;
  text: string;
}

export interface Timer {
  cancel: () => void;
}

/** Quién emite: agente, versión, máquina y perfil. */
export interface HostInfo {
  host: string;
  hostVersion?: string | undefined;
  machine?: string | undefined;
  profile: string;
}

export interface Platform {
  info: () => Promise<HostInfo>;
  env: () => Promise<NodEnv>;
  now: () => Promise<number>;
  after: (ms: number, cb: () => void) => Timer;
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<HttpResponse>;
  /** Almacén por perfil del agente (JSON). Guardar `null` lo borra. */
  store: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
  };
  /** Lee un fichero; lanza si no existe. */
  read: (path: string) => Promise<string>;
  /** Añade texto al final de un fichero, creando el directorio si falta. Lanza si no pudo. */
  append: (path: string, text: string) => Promise<void>;
  log: (message: string) => void;
}
