// Resumen de un permiso para el reloj (SPEC §6.2, campo `sum` de `perm`/`permPending`).
//
// - ctx=personal: Bash -> `command`; Edit/Write/Read -> `file_path`; otro tool -> `tool_input` en JSON
//   compacto. Siempre <= 200 bytes UTF-8, cortado en frontera de code point.
// - ctx=work: solo el verbo (primer token del comando, sin asignaciones `VAR=valor` ni ruta) o el nombre
//   del tool. Es el único texto que sale de una instancia work.
//
// En ctx=personal se aplica `redactSecrets` antes de truncar: el `sum` viaja por WebSocket, por FCM
// (Google), al SQLite del servidor y a la base del reloj. Es un filtro conservador por forma y por
// proximidad a palabras clave; el filtro completo de G3e (texto bajo demanda) es de la fase 3.
import type { Ctx } from "../types.js";

export const SUM_MAX_BYTES = 200;
export const TOOL_MAX_BYTES = 32;

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

function stringField(input: unknown, key: string): string | undefined {
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

const VERB_RE = /^[A-Za-z0-9._+-]{1,32}$/;
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Verbo de un comando de shell: el primer token que no es una asignación `VAR=valor`, sin su ruta
 * (`/usr/bin/rm` -> `rm`). Si el token tiene caracteres raros (comillas, `$`, ...) no se envía: puede
 * llevar datos. Devuelve undefined si no hay un verbo limpio.
 */
export function commandVerb(command: string): string | undefined {
  for (const token of command.trim().split(/\s+/)) {
    if (token === "") continue;
    if (ASSIGN_RE.test(token)) continue;
    const base = token.slice(token.lastIndexOf("/") + 1);
    return VERB_RE.test(base) ? base : undefined;
  }
  return undefined;
}

// ---------- filtro de secretos (ctx=personal) ----------

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

/** Oculta lo que parece un secreto (`***`). Erra a favor de ocultar: el `sum` es solo un resumen. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, by] of REDACTIONS) {
    re.lastIndex = 0;
    out = typeof by === "string" ? out.replace(re, by) : out.replace(re, by as (...m: string[]) => string);
  }
  return out;
}

/** Nombre del tool como etiqueta (<= 32 bytes, SPEC §2). */
export function toolLabel(tool: string): string {
  return truncateUtf8(tool, TOOL_MAX_BYTES);
}

/** Caracteres que no se ven en pantalla o reordenan lo que se ve: formato Unicode (U+200B, bidi, ...) y control salvo \t y \n. */
const HIDDEN_RE = /[\p{Cf}\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u;

export interface Summary {
  sum: string;
  /**
   * true si `sum` es exactamente el texto que resume (ctx=personal): ni el filtro de secretos lo cambió,
   * ni se truncó, ni lleva caracteres invisibles. Si es false, el reloj no ve el comando completo y el
   * mod pone `wok=false` (§6.4): una aprobación no puede cubrir texto que el usuario no ha visto.
   * En ctx=work siempre es true: ahí `sum` es solo el verbo por diseño (§6.2).
   */
  exact: boolean;
}

export function summarizeExact(ctx: Ctx, tool: string, input: unknown): Summary {
  if (ctx === "work") {
    if (tool === "Bash") {
      const command = stringField(input, "command");
      const verb = command === undefined ? undefined : commandVerb(command);
      return { sum: verb ?? toolLabel(tool), exact: true };
    }
    return { sum: toolLabel(tool), exact: true };
  }
  let text: string;
  if (tool === "Bash") text = stringField(input, "command") ?? compactJson(input);
  else if (tool === "Edit" || tool === "Write" || tool === "Read") text = stringField(input, "file_path") ?? compactJson(input);
  else text = compactJson(input);
  const sum = truncateUtf8(redactSecrets(text), SUM_MAX_BYTES);
  return { sum, exact: sum === text && !HIDDEN_RE.test(text) };
}

export function summarize(ctx: Ctx, tool: string, input: unknown): string {
  return summarizeExact(ctx, tool, input).sum;
}
