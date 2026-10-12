// La Platform de Nod dentro de OpenCode: el plugin corre en su proceso (Bun, con las APIs de Node), así que los
// ficheros, el reloj y la red son los de siempre. El almacén es un directorio por perfil con un JSON por clave.
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { branchFromHead } from "../../core/normalize.js";
import type { NodEnv } from "../../core/config.js";
import type { HostInfo, Platform } from "../../core/platform.js";
import type { RepoInfo } from "./adapter.js";

type Env = Record<string, string | undefined>;

/** Perfil de OpenCode: el nombre de su directorio de configuración (OPENCODE_CONFIG_DIR) o `opencode`. */
export function profileOf(configDir: string | undefined): string {
  const d = (configDir ?? "").replace(/\/+$/, "");
  const b = d.slice(d.lastIndexOf("/") + 1).replace(/^\./, "");
  return b === "" ? "opencode" : b;
}

/** Cómo se lanzó OpenCode, por su línea de órdenes (`opencode run …`, `opencode serve`, la TUI). */
export function runModeOf(argv: readonly string[]): "tui" | "run" | "serve" {
  const sub = argv.slice(2).find((a) => !a.startsWith("-"));
  if (sub === "run") return "run";
  if (sub === "serve" || sub === "web" || sub === "acp") return "serve";
  return "tui";
}

export function nodEnv(env: Env): NodEnv {
  return {
    NOD_SINKS: env.NOD_SINKS,
    NOD_TOKEN: env.NOD_TOKEN,
    NOD_PRIVACY: env.NOD_PRIVACY,
    NOD_INSTANCE: env.NOD_INSTANCE,
    NOD_TASK: env.NOD_TASK,
    NOD_CONFIG: env.NOD_CONFIG,
    NOD_OFF: env.NOD_OFF,
    NOD_CONTROL: env.NOD_CONTROL,
    NOD_CONTROL_TOKEN: env.NOD_CONTROL_TOKEN,
    NOD_FORBIDDEN_ADD: env.NOD_FORBIDDEN_ADD,
    HOME: env.HOME,
    XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
    XDG_STATE_HOME: env.XDG_STATE_HOME,
  };
}

/** Nombre de fichero para una clave del almacén (las de las colas llevan la URL del destino). */
const keyFile = (key: string) => encodeURIComponent(key).replace(/\*/g, "%2A") + ".json";

export function nodePlatform(env: Env, log: (m: string) => void, toast?: (m: string) => void): Platform {
  const profile = profileOf(env.OPENCODE_CONFIG_DIR);
  const state = env.XDG_STATE_HOME || `${env.HOME ?? ""}/.local/state`;
  const storeDir = join(state, "nod", "opencode", profile);
  const machine = hostname().split(".")[0] ?? "";
  const info: HostInfo = { host: "opencode", profile };
  if (machine !== "") info.machine = machine;
  return {
    info: async () => info,
    env: async () => nodEnv(env),
    now: async () => Date.now(),
    after: (ms, cb) => {
      const h = setTimeout(cb, ms);
      // Un temporizador de Nod no mantiene vivo el proceso: al cerrar, dispose ya entrega lo pendiente.
      (h as { unref?: () => void }).unref?.();
      return { cancel: () => clearTimeout(h) };
    },
    fetch: async (url, init) => {
      const r = await fetch(url, init);
      return { status: r.status, ok: r.ok, text: await r.text().catch(() => "") };
    },
    store: {
      get: async (key) => {
        try {
          return JSON.parse(await readFile(join(storeDir, keyFile(key)), "utf8"));
        } catch {
          return undefined;
        }
      },
      set: async (key, value) => {
        const file = join(storeDir, keyFile(key));
        if (value === null || value === undefined) {
          await rm(file, { force: true });
          return;
        }
        await mkdir(storeDir, { recursive: true });
        // Escritura atómica: otro proceso de OpenCode del mismo perfil nunca lee un fichero a medias.
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(value));
        await rename(tmp, file);
      },
    },
    read: (path) => readFile(path, "utf8"),
    append: async (path, text) => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, text);
    },
    write: async (path, text) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    },
    random: async (n) => {
      const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
      if (c?.getRandomValues === undefined) throw new Error("sin generador aleatorio criptográfico");
      return c.getRandomValues(new Uint8Array(n));
    },
    log,
    toast,
  };
}

/** Repo del proyecto: raíz, rama (`.git/HEAD`) y remoto `origin` (`.git/config`), del que sale el nombre. */
export async function repoOf(worktree: string | undefined): Promise<RepoInfo | undefined> {
  if (worktree === undefined || worktree === "" || worktree === "/") return undefined;
  let gitDir = join(worktree, ".git");
  try {
    // En un worktree de git, `.git` es un fichero que apunta a su directorio.
    const dotGit = await readFile(gitDir, "utf8").catch(() => undefined);
    const pointer = dotGit !== undefined ? /^gitdir: (.+)$/m.exec(dotGit.trim()) : null;
    if (pointer !== null) gitDir = pointer[1]!.startsWith("/") ? pointer[1]! : join(worktree, pointer[1]!);
    const head = await readFile(join(gitDir, "HEAD"), "utf8");
    const repo: RepoInfo = { root: worktree };
    const branch = branchFromHead(head);
    if (branch !== undefined) repo.branch = branch;
    // El config está en el directorio común (en un worktree, el del repo principal).
    const common = await readFile(join(gitDir, "commondir"), "utf8").then((c) => (c.trim().startsWith("/") ? c.trim() : join(gitDir, c.trim())), () => gitDir);
    const config = await readFile(join(common, "config"), "utf8").catch(() => "");
    const remote = /\[remote "origin"\][^[]*?\n\s*url\s*=\s*(\S+)/.exec(config)?.[1];
    if (remote !== undefined) {
      repo.remote = remote;
      const m = /([^/:]+?)(\.git)?$/.exec(remote);
      if (m !== null) repo.name = m[1]!;
    }
    return repo;
  } catch {
    return undefined;
  }
}
