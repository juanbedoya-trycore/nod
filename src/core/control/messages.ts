// Mensajes de un aprobador a la sesión (docs/control-v1.md §3.2 y §4.2): un texto, "detente" o "detente y
// resume". El bucle pide `GET /v1/control/messages` mientras dure la sesión y haya llaves; cada mensaje se
// verifica (verify.ts) y se convierte en un plan que aplica el motor con lo que le da el agente.
import { sessionSid } from "./crypto.js";
import { CALL_TIMEOUT_MS, call, headers, parseJson, sleep } from "./io.js";
import type { ControlIo, Controller } from "./io.js";
import { verifyMessage } from "./verify.js";
import type { MessageKind, PairedKey } from "./verify.js";

/**
 * El resumen que pide `recap` cuando el aprobador no manda texto propio. Lo escribe Nod, no el controlador: el
 * controlador solo puede repetir o retrasar un mensaje firmado, nunca cambiar lo que pide.
 */
export const RECAP_PROMPT =
  "Detente aquí. Resume en pocas líneas en qué estabas, qué has hecho hasta ahora y qué te bloquea o qué necesitas de mí. No sigas trabajando hasta que te responda.";

/** Cómo le llega al modelo un texto que entra a mitad de turno. */
export const CONTEXT_PREFIX = "Mensaje del usuario desde fuera del terminal (Nod Control), mientras trabajas: ";

/**
 * Qué hacer con un mensaje ya verificado. `turnActive`: hay un turno de la sesión principal en curso.
 * - `text`: con turno, nota para el siguiente resultado de tool; sin turno, prompt.
 * - `stop`: corta el turno (su texto se ignora: "detente" no es un prompt).
 * - `recap`: corta el turno y, al terminar, pide el resumen; sin turno, el resumen sale ya.
 */
export interface MessagePlan {
  abort: boolean;
  note?: string;
  submitNow?: string;
  submitAfterTurn?: string;
}

export function messagePlan(kind: MessageKind, text: string, turnActive: boolean): MessagePlan {
  switch (kind) {
    case "text":
      if (text.trim() === "") return { abort: false };
      return turnActive ? { abort: false, note: text } : { abort: false, submitNow: text };
    case "stop":
      return { abort: turnActive };
    case "recap": {
      const prompt = text.trim() === "" ? RECAP_PROMPT : text;
      return turnActive ? { abort: true, submitAfterTurn: prompt } : { abort: false, submitNow: prompt };
    }
  }
}

/** Textos llegados a mitad de turno: salen como contexto del siguiente resultado de tool o, si no hay, como prompt. */
export class Notes {
  private notes: string[] = [];

  push(text: string): void {
    this.notes.push(text);
  }

  get size(): number {
    return this.notes.length;
  }

  takeContext(): string | undefined {
    if (this.notes.length === 0) return undefined;
    const t = this.notes.map((n) => CONTEXT_PREFIX + n).join("\n");
    this.notes = [];
    return t;
  }

  takePrompt(): string | undefined {
    if (this.notes.length === 0) return undefined;
    const t = this.notes.join("\n");
    this.notes = [];
    return t;
  }

  clear(): void {
    this.notes = [];
  }
}

/** Añade `extra` al `context` del resultado de una tool (texto o lista de textos). */
export function withContext(result: unknown, extra: string): unknown {
  if (result === null || typeof result !== "object") return result;
  const r = result as Record<string, unknown>;
  const prev = r.context;
  const list = typeof prev === "string" ? [prev] : Array.isArray(prev) ? prev.filter((x) => typeof x === "string") : [];
  return { ...r, context: [...list, extra] };
}

export interface Accepted {
  id: string;
  kind: MessageKind;
  text: string;
}

export interface LoopDeps {
  controller: Controller;
  io: ControlIo;
  instance: string;
  /** La sesión que escucha el bucle ahora (cambia tras /clear); undefined = parar. */
  session: () => string | undefined;
  keys: () => Promise<readonly PairedKey[]>;
  onMessage: (m: Accepted) => Promise<void>;
}

/** `wait` del long-poll de mensajes. */
export const MESSAGE_WAIT_MS = 20_000;
/** Sin llaves no se pregunta al controlador: se vuelve a mirar al rato (puede emparejarse a mitad de sesión). */
const NO_KEYS_MS = 30_000;
const ERROR_MS = 5_000;
/** Un 204 más rápido que esto no esperó en el controlador. */
const QUICK_MS = 1_000;
const SEEN_MEMORY = 1000;

/** Bucle de mensajes. Un solo bucle por proceso; `run` vuelve cuando `session()` da undefined. Nunca lanza. */
export class MessageLoop {
  private readonly seen = new Set<string>();
  running = false;
  /** Motivos de los últimos descartes (para /nod). */
  rejected = 0;

  constructor(private readonly deps: LoopDeps) {}

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const { io, controller } = this.deps;
    try {
      for (;;) {
        const session = this.deps.session();
        if (session === undefined) return;
        const keys = await this.deps.keys();
        if (keys.length === 0) {
          await sleep(io, NO_KEYS_MS);
          continue;
        }
        const url = `${controller.url}/v1/control/messages?session=${encodeURIComponent(session)}&wait=${MESSAGE_WAIT_MS}`;
        const t0 = await io.now();
        const r = await call(io, MESSAGE_WAIT_MS + CALL_TIMEOUT_MS, url, { method: "GET", headers: headers(controller, false) });
        if (r?.status === 204) {
          // Un controlador que no respeta `wait` y contesta 204 al momento no puede tener a Nod girando en vacío.
          if ((await io.now()) - t0 < QUICK_MS) await sleep(io, QUICK_MS);
          continue;
        }
        if (r?.status !== 200) {
          await sleep(io, ERROR_MS);
          continue;
        }
        // La sesión pudo cambiar o acabar mientras esperaba: los mensajes eran para la otra.
        if (this.deps.session() !== session) continue;
        const list = (parseJson(r.text) as { messages?: unknown } | undefined)?.messages;
        if (!Array.isArray(list)) {
          await sleep(io, ERROR_MS);
          continue;
        }
        await this.consider(list, session, await this.deps.keys());
      }
    } catch (err) {
      io.log(`nod control: bucle de mensajes parado (${String(err)})`);
    } finally {
      this.running = false;
    }
  }

  /** Verifica y aplica una tanda de mensajes de `session`, en orden. */
  async consider(list: readonly unknown[], session: string, keys: readonly PairedKey[]): Promise<void> {
    const ctx = { instance: this.deps.instance, sid: sessionSid(this.deps.instance, session) };
    for (const raw of list) {
      const v = verifyMessage(raw, ctx, keys, (await this.deps.io.now()) / 1000, this.seen);
      if (!v.ok) {
        // Un mensaje ya aplicado que el controlador repite no es un fallo: no se registra.
        if (v.reason !== "replay") {
          this.rejected++;
          this.deps.io.log(`nod control: mensaje descartado (${v.reason})`);
        }
        continue;
      }
      this.seen.add(v.id);
      if (this.seen.size > SEEN_MEMORY) this.seen.delete(this.seen.values().next().value!);
      await this.deps.onMessage({ id: v.id, kind: v.kind, text: v.text });
    }
  }
}
