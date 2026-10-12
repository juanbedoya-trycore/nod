// Lo que el núcleo necesita del agente que lo aloja (Claude Code, OpenCode…). Cada adaptador construye
// una `Platform` con lo que le da su motor; el núcleo no conoce a ninguno.

/** Variables de entorno que lee Orbit. El adaptador las lee una vez (en Claude, con nombres literales). */
export interface OrbitEnv {
  ORBIT_URL?: string | undefined;
  ORBIT_TOKEN?: string | undefined;
  ORBIT_INSTANCE_ID?: string | undefined;
  ORBIT_CTX?: string | undefined;
  ORBIT_STATE_DIR?: string | undefined;
  ORBIT_PHONE_URL?: string | undefined;
  ORBIT_PERM?: string | undefined;
  ORBIT_PERM_HOLD_MS?: string | undefined;
  ORBIT_FORBIDDEN?: string | undefined;
  ORBIT_FORBIDDEN_ADD?: string | undefined;
  ORBIT_WATCH_KEYS?: string | undefined;
  HOME?: string | undefined;
  XDG_CONFIG_HOME?: string | undefined;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  text: string;
}

export interface Timer {
  cancel: () => void;
}

export interface Platform {
  /** Nombre del agente (`claude`, `opencode`…): sale en los registros. */
  host: string;
  env: () => Promise<OrbitEnv>;
  now: () => Promise<number>;
  after: (ms: number, cb: () => void) => Timer;
  fetch: (url: string, init?: Record<string, unknown>) => Promise<HttpResponse>;
  /** Almacén por perfil del agente (JSON). */
  store: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
  /** Lee un fichero; lanza si no existe. */
  read: (path: string) => Promise<string>;
  write: (path: string, text: string) => Promise<void>;
  /** Ejecuta un programa (sin shell). undefined si el agente no puede. */
  run: (argv: string[]) => Promise<{ stdout?: string } | undefined>;
  log: (message: string) => void;
  /** Aviso breve en la interfaz del agente; puede no hacer nada. */
  toast: (message: string) => void;
  /** Línea de estado persistente (undefined la quita); puede no hacer nada. */
  status: (text: string | undefined) => void;
  sessionId: () => Promise<string>;
}

/** Lo que el reloj puede pedirle a la sesión (SPEC §6.6). */
export interface SessionControl {
  abortTurn: (turnId: string) => Promise<void>;
  submitPrompt: (text: string) => Promise<void>;
}
