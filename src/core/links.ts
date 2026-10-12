// Lo que la sesión produce y no cabe en el reloj (SPEC §8.3): enlaces (artifacts de claude.ai, PRs) y
// archivos escritos. El mod los detecta en cada resultado de tool y los manda como `orbit_links` en el
// PostToolUse; el reloj los dibuja como nodos cuadrados y los abre en el teléfono. Funciones puras.

export interface Link {
  kind: "link" | "file";
  /** Lo que se ve en el reloj: "PR #42", "informe.html", "Artifact". */
  name: string;
  url?: string;
  path?: string;
}

/** Como mucho tantos enlaces por resultado de tool (un `gh pr list` no debe llenar el reloj). */
export const LINKS_PER_RESULT = 3;

const ARTIFACT_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/g;
const GITHUB_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(pull|issues)\/(\d+)/g;

/** Lo que se edita o genera por Bash solo cuenta si es un documento que se abre en el teléfono (no código). */
const DOC_RE = /\.(html?|md|pdf|png|jpe?g|gif|svg|webp|csv|mp4)$/i;
/** Salida de un comando a un archivo: `> f`, `>> f`, `-o f`, `--output f`, `--output=f`. */
const BASH_OUT_RE = /(?:>>?|\s-o|--output[= ])\s*(['"]?)([^\s'"|;&<>]+)\1/g;

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter((x) => x !== "");
  return parts[parts.length - 1] ?? p;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function absolute(p: string, cwd: string | undefined): string | undefined {
  if (p.startsWith("/")) return p;
  if (cwd === undefined || p.startsWith("~") || p.startsWith("$")) return undefined;
  return `${cwd.replace(/\/+$/, "")}/${p.replace(/^\.\//, "")}`;
}

/**
 * Enlaces y archivos de un resultado de tool. `resultText` es el texto que devolvió la herramienta; `cwd`,
 * el directorio de la sesión, para las rutas relativas de Bash.
 */
export function linksOf(tool: string, input: unknown, resultText: unknown, isError: boolean, cwd?: string): Link[] {
  if (isError) return [];
  const out: Link[] = [];
  const seen = new Set<string>();
  const add = (l: Link): void => {
    const key = l.url ?? l.path ?? "";
    if (key === "" || seen.has(key) || out.length >= LINKS_PER_RESULT) return;
    seen.add(key);
    out.push(l);
  };
  const inp = (input !== null && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (tool === "Write") {
    const p = str(inp.file_path);
    if (p !== undefined) add({ kind: "file", name: basename(p), path: p });
  }
  if (tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") {
    const p = str(inp.file_path) ?? str(inp.notebook_path);
    if (p !== undefined && DOC_RE.test(p)) add({ kind: "file", name: basename(p), path: p });
  }
  if (tool === "Bash") {
    const cmd = str(inp.command) ?? "";
    for (const m of cmd.matchAll(BASH_OUT_RE)) {
      const p = m[2] !== undefined && DOC_RE.test(m[2]) ? absolute(m[2], cwd) : undefined;
      if (p !== undefined) add({ kind: "file", name: basename(p), path: p });
    }
  }
  const text = typeof resultText === "string" ? resultText.slice(0, 20_000) : "";
  for (const m of text.matchAll(ARTIFACT_RE)) add({ kind: "link", name: "Artifact", url: m[0] });
  for (const m of text.matchAll(GITHUB_RE)) add({ kind: "link", name: `${m[1] === "pull" ? "PR" : "Issue"} #${m[2]}`, url: m[0] });
  return out;
}

/** Perfil de Claude Code a partir de `CLAUDE_CONFIG_DIR` (sin él, el perfil por omisión `~/.claude`). */
export function profileOf(configDir: string | undefined): string {
  const d = str(configDir);
  if (d === undefined) return "claude";
  const b = basename(d);
  return b === ".claude" ? "claude" : b;
}

/**
 * Notas del reloj para la sesión en curso (§6.6): un mensaje que llega a mitad de turno se mete como
 * `context` del siguiente resultado de tool (Claude lo lee sin esperar a terminar). Lo que no haya salido
 * al acabar el turno se manda como prompt.
 */
export class WatchNotes {
  private notes: string[] = [];

  push(text: string): void {
    this.notes.push(text);
  }

  get size(): number {
    return this.notes.length;
  }

  /** Vacía las notas como texto de contexto, o undefined si no hay ninguna. */
  takeContext(): string | undefined {
    if (this.notes.length === 0) return undefined;
    const t = this.notes.map((n) => `Mensaje del usuario desde su reloj (Orbit), mientras trabajas: ${n}`).join("\n");
    this.notes = [];
    return t;
  }

  /** Vacía las notas como un único prompt (fin de turno sin tool de por medio). */
  takePrompt(): string | undefined {
    if (this.notes.length === 0) return undefined;
    const t = this.notes.join("\n");
    this.notes = [];
    return t;
  }
}

/** Añade `extra` al `context` de un resultado de `tool.call` (texto o lista de textos). */
export function withContext(result: unknown, extra: string): unknown {
  if (result === null || typeof result !== "object") return result;
  const r = result as Record<string, unknown>;
  const prev = r.context;
  const list = typeof prev === "string" ? [prev] : Array.isArray(prev) ? prev.filter((x) => typeof x === "string") : [];
  return { ...r, context: [...list, extra] };
}
