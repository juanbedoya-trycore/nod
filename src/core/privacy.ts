// Perfiles de privacidad (docs/nod-v1.md §4). Se aplican antes de encolar, y otra vez a lo que ya estaba en
// cola si el perfil se endurece: lo que no debe salir nunca toca la cola ni el disco, ni sale después.
import type { Draft, Privacy } from "./events.js";

/** Campos de `data` que llevan texto libre o rutas: fuera en `redactado` y `trabajo`. */
const TEXT_FIELDS = ["text", "answer", "input", "description", "cwd", "title", "links", "remote_session"] as const;
/** `reason` es texto libre (con rutas) solo en el permiso; en session.end es un valor fijo (`exit`, `clear`…). */
const FREE_REASON = new Set(["permission.request"]);

/** Comandos de barra de Claude Code: su nombre no dice nada del usuario. Los demás son propios y se ocultan. */
const BUILTIN_COMMANDS = new Set([
  "exit", "quit", "clear", "compact", "model", "resume", "help", "init", "review", "cost", "config", "login", "logout",
  "plan", "agents", "mcp", "memory", "permissions", "status", "doctor", "rewind", "context", "effort", "usage",
  "plugin", "plugins", "hooks", "ide", "vim", "theme", "export", "add-dir", "bug", "feedback", "release-notes", "nod",
]);
/** Tipos de subagente integrados; los demás son definiciones propias y se ocultan. */
const BUILTIN_AGENTS = new Set(["agent", "general-purpose", "Explore", "Plan", "statusline-setup", "claude-code-guide", "output-style-setup"]);

const RANK: Record<Privacy, number> = { completo: 0, redactado: 1, trabajo: 2 };

export function redacts(p: Privacy): boolean {
  return p !== "completo";
}

/** El más estricto de los dos. */
export function stricter(a: Privacy, b: Privacy): Privacy {
  return RANK[a] >= RANK[b] ? a : b;
}

export function isStricter(a: Privacy, than: Privacy): boolean {
  return RANK[a] > RANK[than];
}

/** Id corto y estable (FNV-1a de 32 bits): agrupa sin revelar el original. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const hidden = (s: string) => `h-${shortHash(s)}`;

/** `mcp__acme-jira__search` → `mcp__h-1a2b3c4d__search`: el servidor MCP puede llevar el nombre del cliente. */
export function hideMcpServer(tool: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  return m === null ? tool : `mcp__${hidden(m[1]!)}__${m[2]}`;
}

/** Devuelve el evento tal como puede salir con este perfil (una copia si hay que quitar algo). */
export function applyPrivacy<T extends Draft>(d: T, p: Privacy): T {
  if (!redacts(p)) return d;
  const data: Record<string, unknown> = { ...d.data };
  for (const k of TEXT_FIELDS) delete data[k];
  if (FREE_REASON.has(d.type)) delete data.reason;
  const repo = data.repo as Record<string, unknown> | undefined;
  if (repo !== undefined) {
    // Queda el nombre del repo; la ruta local y la URL del remoto pueden identificar al cliente.
    const { root: _r, remote: _m, ...rest } = repo;
    if (Object.keys(rest).length > 0) data.repo = rest;
    else delete data.repo;
  }
  const out = { ...d, data };
  // `trabajo` no sale de la máquina: los identificadores se quedan legibles. En `redactado` (que puede ir a un
  // destino remoto) los que escribe el usuario se sustituyen por un hash: se puede agrupar, no leer.
  if (p === "redactado") {
    if (typeof out.task === "string") out.task = hidden(out.task);
    if (typeof data.task === "string") data.task = hidden(data.task);
    if (d.type === "command" && typeof data.name === "string" && !BUILTIN_COMMANDS.has(data.name)) data.name = hidden(data.name);
    if (d.type === "agent.spawn" && typeof data.type === "string" && !BUILTIN_AGENTS.has(data.type)) data.type = hidden(data.type);
    if (typeof data.tool === "string") data.tool = hideMcpServer(data.tool);
    // La rama suele llevar el ticket o el cliente; el sha no identifica a nadie y hace falta para cruzar con git.
    if (d.type === "vcs.commit" && typeof data.branch === "string") data.branch = hidden(data.branch);
    const repoAfter = data.repo as Record<string, unknown> | undefined;
    if (repoAfter !== undefined && typeof repoAfter.branch === "string") data.repo = { ...repoAfter, branch: hidden(repoAfter.branch) };
    if (Array.isArray(data.tools)) data.tools = data.tools.map((t) => (typeof t === "string" ? hideMcpServer(t) : t));
  }
  return out;
}

/** ¿Puede este destino recibir eventos con este perfil? `trabajo` solo deja destinos locales. */
export function sinkAllowed(p: Privacy, sink: { kind: "file" | "http"; target: string }): boolean {
  if (p !== "trabajo" || sink.kind === "file") return true;
  return isLocalUrl(sink.target);
}

export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}
