// Lo que necesita el canal de control para hablar con el controlador: reloj, temporizadores, HTTP y entropía.
// Lo da el motor a partir de su Platform; los tests, con un controlador falso y un reloj propio.
import type { HttpResponse, Timer } from "../platform.js";

export interface ControlIo {
  /** Milisegundos Unix. */
  now: () => Promise<number>;
  after: (ms: number, cb: () => void) => Timer;
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<HttpResponse>;
  /** n bytes de un generador criptográfico. Lanza si no lo hay: sin id aleatorio no se retiene. */
  random: (n: number) => Promise<Uint8Array>;
  log: (message: string) => void;
}

/** Dónde está el controlador y con qué token (docs/control-v1.md §2). `url` sin barra final. */
export interface Controller {
  url: string;
  token?: string | undefined;
}

/** Plazo de cada llamada al controlador (§4); el long-poll tiene `wait` + este margen. */
export const CALL_TIMEOUT_MS = 3_000;

export function headers(c: Controller, json: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (c.token) h.authorization = `Bearer ${c.token}`;
  if (json) h["content-type"] = "application/json";
  return h;
}

/** La respuesta, o undefined si no llega en `ms` o falla la red. Nunca lanza. */
export function call(io: ControlIo, ms: number, url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<HttpResponse | undefined> {
  return within(io, ms, io.fetch(url, init).catch(() => undefined));
}

/** La promesa, o undefined si no se resuelve en `ms`. */
export function within<T>(io: Pick<ControlIo, "after">, ms: number, work: Promise<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = io.after(ms, () => resolve(undefined));
    work.then(
      (v) => {
        timer.cancel();
        resolve(v);
      },
      () => {
        timer.cancel();
        resolve(undefined);
      },
    );
  });
}

export function sleep(io: Pick<ControlIo, "after">, ms: number): Promise<void> {
  return new Promise((resolve) => void io.after(ms, () => resolve()));
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
