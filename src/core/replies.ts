// Respuestas rápidas del reloj (SPEC §6.6.1): la lista que el reloj ofrece en una sesión. Se configura en el
// mod con `/nod respuestas …` y viaja al servidor en `orbit_replies` (SessionStart y cada Stop de la sesión
// principal, solo ctx=personal); el reloj la recibe en `GET /v0/session` y, sin ella, usa la suya por defecto.
// Cada respuesta sigue siendo un `say` firmado por el reloj: esta lista solo dice qué botones enseñar.

/** Tope de la lista y de cada respuesta (el servidor aplica los mismos, SPEC §6.6.1). */
export const REPLIES_MAX = 8;
export const REPLY_MAX_BYTES = 64;

/** Por defecto: las mismas que trae el reloj. "Detente" y "Detente y resume" son acciones fijas del reloj. */
export const DEFAULT_REPLIES: readonly string[] = ["Continúa", "Sí", "No", "Resume en qué estás", "Prueba otra forma"];

/** Clave de `$.store` (sin directorio de estado) y fichero del directorio de estado (compartido por perfiles). */
export const REPLIES_KEY = "orbit.replies";
export const REPLIES_FILE = "replies.json";

const bytes = (s: string): number => new TextEncoder().encode(s).length;

// Caracteres de control (C0, DEL, C1): una respuesta es una línea corta y visible.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Motivo por el que una respuesta no vale, o undefined si vale. */
export function replyProblem(text: string): string | undefined {
  const t = text.trim();
  if (t === "") return "está vacía";
  if (bytes(t) > REPLY_MAX_BYTES) return `pasa de ${REPLY_MAX_BYTES} bytes`;
  if (CONTROL.test(t)) return "lleva caracteres de control";
  return undefined;
}

/** Lista saneada: recorta espacios, quita las inválidas y las repetidas, y corta a [REPLIES_MAX]. */
export function cleanReplies(list: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const r of list) {
    if (typeof r !== "string" || replyProblem(r) !== undefined) continue;
    const t = r.trim();
    if (!out.includes(t)) out.push(t);
    if (out.length === REPLIES_MAX) break;
  }
  return out;
}

/** Lee lo guardado (`{"v":1,"replies":[...]}`, como objeto o como texto JSON). undefined = sin configurar. */
export function readReplies(raw: unknown): string[] | undefined {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  if (v === null || typeof v !== "object" || !Array.isArray((v as { replies?: unknown }).replies)) return undefined;
  return cleanReplies((v as { replies: unknown[] }).replies);
}

export function writeReplies(list: readonly string[]): { v: 1; replies: string[] } {
  return { v: 1, replies: cleanReplies(list) };
}

export type RepliesCommand =
  | { kind: "list" }
  | { kind: "add"; text: string }
  | { kind: "remove"; index: number }
  | { kind: "reset" }
  | { kind: "invalid"; why: string };

export const REPLIES_USAGE =
  "uso: /nod respuestas [añadir <texto> | quitar <n> | restablecer]";

/** `/nod respuestas …` (también `replies`, `add`, `remove`, `reset`). undefined si no es este comando. */
export function parseRepliesCommand(args: string): RepliesCommand | undefined {
  const m = /^\s*(respuestas|replies)(?:\s+([\s\S]*))?$/i.exec(args);
  if (m === null) return undefined;
  const rest = (m[2] ?? "").trim();
  if (rest === "" || /^(lista|list)$/i.test(rest)) return { kind: "list" };
  if (/^(restablecer|reset)$/i.test(rest)) return { kind: "reset" };
  const add = /^(añadir|anadir|add)\s+([\s\S]+)$/i.exec(rest);
  if (add !== null) {
    const text = add[2]!.trim().replace(/^"(.*)"$/s, "$1").trim();
    const why = replyProblem(text);
    return why === undefined ? { kind: "add", text } : { kind: "invalid", why: `la respuesta ${why}` };
  }
  const rm = /^(quitar|remove|rm)\s+(\d+)$/i.exec(rest);
  if (rm !== null) return { kind: "remove", index: Number(rm[2]) };
  return { kind: "invalid", why: REPLIES_USAGE };
}

export type RepliesResult = { list: string[]; changed: boolean; message: string };

/** Aplica el comando sobre la lista actual (la configurada o, si no hay, la de por defecto). Pura. */
export function applyRepliesCommand(current: readonly string[] | undefined, cmd: RepliesCommand): RepliesResult {
  const list = [...(current ?? DEFAULT_REPLIES)];
  const show = (l: readonly string[]): string =>
    [`respuestas rápidas del reloj (${l.length}/${REPLIES_MAX})${current === undefined ? ", las de por defecto" : ""}:`, ...l.map((r, i) => `  ${i + 1}. ${r}`), "  además, siempre: Detente y Detente y resume"].join("\n");
  switch (cmd.kind) {
    case "list":
      return { list, changed: false, message: show(list) };
    case "reset":
      return { list: [...DEFAULT_REPLIES], changed: true, message: `restablecidas\n${show(DEFAULT_REPLIES)}` };
    case "add": {
      if (list.includes(cmd.text)) return { list, changed: false, message: `ya estaba\n${show(list)}` };
      if (list.length >= REPLIES_MAX) return { list, changed: false, message: `ya hay ${REPLIES_MAX}: quita una antes (/nod respuestas quitar <n>)` };
      const next = [...list, cmd.text];
      return { list: next, changed: true, message: `añadida: ${cmd.text}\n${show(next)}` };
    }
    case "remove": {
      if (cmd.index < 1 || cmd.index > list.length) return { list, changed: false, message: `no hay respuesta ${cmd.index}\n${show(list)}` };
      const next = list.filter((_, i) => i !== cmd.index - 1);
      return { list: next, changed: true, message: `quitada: ${list[cmd.index - 1]}\n${show(next)}` };
    }
    case "invalid":
      return { list, changed: false, message: cmd.why };
  }
}
