// Resumen de un permiso: lo que verá el aprobador antes de decidir (docs/control-v1.md §3.1, `summary`).
//
// - `completo`: Bash → el comando; Edit/Write/Read → la ruta; otra tool → la entrada en JSON compacto. Antes
//   de cortarlo a 1000 bytes pasa por un filtro de secretos: el resumen viaja al controlador y al aprobador.
// - `redactado` y `trabajo`: solo el verbo del comando (el mismo `verb` limpio de Nod v1) o el nombre de la
//   tool. Ni rutas ni argumentos.
//
// `exact` dice si el resumen es el texto completo de lo que se va a ejecutar. Si el filtro de secretos lo cambió,
// se cortó o lleva caracteres invisibles, el aprobador no está viendo lo que aprueba: Nod pone `wok: false` y
// solo se puede denegar desde fuera. Con privacidad `redactado` o `trabajo` el resumen es solo el verbo por
// diseño (§2), y `exact` es true: quien elige ese perfil acepta aprobar viendo solo el verbo.
import type { Privacy } from "../events.js";
import { verbOf } from "../normalize.js";

export const SUMMARY_MAX_BYTES = 1000;

const utf8 = new TextEncoder();

/** Corta `s` a `max` bytes UTF-8 sin partir un code point (ni dejar un surrogate suelto). */
export function truncateUtf8(s: string, max: number): string {
  if (utf8.encode(s).length <= max) return s;
  let bytes = 0;
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    // Un surrogate suelto lo codifica TextEncoder como U+FFFD (3 bytes).
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + n > max) break;
    bytes += n;
    out += ch;
  }
  return out;
}

// ---------- filtro de secretos (privacidad completo) ----------

const MASK = "***";
/** Palabras que anuncian un secreto cuando van pegadas a `=`, `:` o a un valor entre comillas. */
const KW =
  "(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth(?:orization)?|credentials?|cookie|session[_-]?id|contrase(?:ñ|n)a|clave|signature|sig)s?(?![a-z0-9])";

const REDACTIONS: readonly [RegExp, string | ((...m: string[]) => string)][] = [
  // Bloques PEM de clave privada.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  // Formas conocidas de tokens (GitHub, OpenAI/Anthropic, Slack, AWS, Google, JWT).
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g, MASK],
  // Credenciales en una URL: esquema://usuario:clave@ y esquema://token@.
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:'"]+):([^\s/@'"]+)@/gi, "$1$2:" + MASK + "@"],
  [/\b([a-z][a-z0-9+.-]*:\/\/)([A-Za-z0-9_-]{16,})@/gi, "$1" + MASK + "@"],
  // Authorization: Bearer/Basic/Token xxx (cabeceras) y "Bearer xxx" suelto.
  [/\b(authorization\s*[:=]\s*(?:bearer|basic|token|digest)?\s*)[^\s"']+/gi, "$1" + MASK],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, "$1" + MASK],
  // curl -u usuario:clave / --user usuario:clave
  [/(\s(?:-u|--user)[\s=]+["']?[^\s:"']+:)[^\s"']+/g, "$1" + MASK],
  // mysql -pCLAVE (pegada), sshpass -p CLAVE, docker/podman/helm login -p CLAVE.
  [/(\bmysql(?:dump|admin)?\b[^;&|\n]*?\s-p)([^\s"']+|"[^"]*"|'[^']*')/g, "$1" + MASK],
  [/(\b(?:sshpass|(?:docker|podman|helm(?:\s+registry)?|nerdctl)\s+login)\b[^;&|\n]*?\s-p\s*)([^\s"']+|"[^"]*"|'[^']*')/g, "$1" + MASK],
  // NOMBRE_CON_PALABRA=valor, palabra: valor, --palabra=valor, -token=valor, "password":"valor" (JSON).
  [new RegExp(`([A-Za-z0-9_.-]*${KW}[A-Za-z0-9_.-]*["']?\\s*[=:]\\s*)(["'\`]?)(?!(?:bearer|basic|digest)\\s)([^\\s"'\`&;|,}]+)`, "gi"), "$1$2" + MASK],
  // --palabra valor (opción con la palabra en el nombre y el valor separado por espacio).
  [new RegExp(`(\\s--?[A-Za-z0-9_-]*${KW}[A-Za-z0-9_-]*\\s+)(["']?)(?!-)([^\\s"']+)`, "gi"), "$1$2" + MASK],
  // palabra "valor", palabra **valor**, palabra es/is valor, contraseña valor (prosa).
  [new RegExp(`(${KW}\\s+(?:(?:es|is|=)\\s+)?)("|'|\`|\\*\\*)([^"'\`*\\n]{1,80})\\2`, "gi"), "$1$2" + MASK + "$2"],
  [new RegExp(`(${KW}\\s+(?:es|is)\\s+)([^\\s"'\`*]+)`, "gi"), "$1" + MASK],
  [/((?:contrase(?:ñ|n)a|clave)\s+)(?!es\b|is\b)([^\s"'`*]+)/gi, "$1" + MASK],
  // Pares `usuario` / `clave` (y con comillas): se oculta el segundo.
  [/(([`'"])[^`'"\s]{1,64}\2\s*\/\s*)([`'"])([^`'"\n]{1,80})\3/g, (_m, pre: string, _q1: string, q: string) => `${pre}${q}${MASK}${q}`],
];

/** Oculta lo que parece un secreto (`***`). Erra a favor de ocultar: es solo un resumen. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, by] of REDACTIONS) {
    re.lastIndex = 0;
    out = typeof by === "string" ? out.replace(re, by) : out.replace(re, by as (...m: string[]) => string);
  }
  return out;
}

/** Caracteres que no se ven o reordenan lo que se ve: formato Unicode (U+200B, bidi…) y control salvo \t y \n. */
const HIDDEN_RE = /[\p{Cf}\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u;

export interface Summary {
  summary: string;
  exact: boolean;
}

const SHELL = new Set(["Bash", "bash"]);
const FILE = new Set(["Edit", "Write", "Read", "edit", "write", "read"]);

function field(input: unknown, key: string): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function compactJson(input: unknown): string {
  try {
    const s = JSON.stringify(input ?? {});
    return typeof s === "string" ? s : "";
  } catch {
    return "";
  }
}

/**
 * Resumen de `tool` con `input` según la privacidad. `label` es el nombre de la tool tal como sale en el
 * permiso (con `redactado`, el servidor MCP ya va oculto).
 */
export function summarize(privacy: Privacy, tool: string, input: unknown, label = tool): Summary {
  // Claude Code las llama Bash, Edit…; OpenCode, bash, edit… (y la ruta va en `filePath`).
  const kind = SHELL.has(tool) ? "shell" : FILE.has(tool) ? "file" : undefined;
  if (privacy !== "completo") {
    const verb = kind === "shell" ? verbOf(field(input, "command")) : undefined;
    return { summary: truncateUtf8(verb ?? label, SUMMARY_MAX_BYTES), exact: true };
  }
  let text: string;
  if (kind === "shell") text = field(input, "command") ?? compactJson(input);
  else if (kind === "file") text = field(input, "file_path") ?? field(input, "filePath") ?? compactJson(input);
  else text = compactJson(input);
  const summary = truncateUtf8(redactSecrets(text), SUMMARY_MAX_BYTES);
  return { summary, exact: summary === text && !HIDDEN_RE.test(text) };
}
