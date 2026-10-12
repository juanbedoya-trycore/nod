import type { Config, Envelope, IngestEvent } from "./types.js";
import { ORBIT_VERSION } from "./types.js";

/** Estado persistente del contador: nada con n <= reserve sin persistir se envía nunca dos veces. */
export interface SequencerState {
  instance_id: string;
  reserve: number;
}

/** Espacio de `n` por milisegundo de arranque: dos procesos que arrancan en ms distintos no solapan. */
export const N_PER_MS = 1024;

/**
 * Contador `n` monótono por instance_id (SPEC §3.1). Para sobrevivir a un reinicio sin guardar
 * cada evento se reserva por bloques: lo persistido (`reserve`) siempre es >= cualquier `n` ya
 * asignado, y al arrancar se continúa desde `reserve` (puede quedar un hueco, nunca un repetido).
 *
 * El contador además arranca como mínimo en `nowMs * 1024`. `$.store` es uno por directorio de
 * configuración, no por proceso ni por máquina: varios procesos de Claude Code (o varios perfiles,
 * o un store vaciado) con el mismo instance_id reutilizarían los mismos `n` y el servidor los
 * descartaría como duplicados en silencio. Con el reloj como base cada arranque cae en su propio
 * tramo (cabe en u53 hasta el año 2255) y, al ser creciente, el orden entre reinicios se mantiene.
 */
export class Sequencer {
  private n: number;
  private reserve: number;
  private persisted: number;

  constructor(
    readonly instanceId: string,
    saved: SequencerState | undefined,
    readonly block = 1000,
    nowMs = 0,
  ) {
    const fromStore = saved && saved.instance_id === instanceId && Number.isInteger(saved.reserve) ? saved.reserve : 0;
    const fromClock = Number.isFinite(nowMs) && nowMs > 0 ? Math.floor(nowMs) * N_PER_MS : 0;
    const start = Math.min(Math.max(fromStore, fromClock), Number.MAX_SAFE_INTEGER - 2 * block);
    this.n = start;
    this.reserve = start + block;
    this.persisted = start;
  }

  /** Siguiente n (≥ 1). */
  next(): number {
    this.n += 1;
    if (this.n >= this.reserve) this.reserve = this.n + this.block;
    return this.n;
  }

  /** true si hay una reserva por escribir antes de enviar nada. */
  get dirty(): boolean {
    return this.reserve !== this.persisted;
  }

  snapshot(): SequencerState {
    return { instance_id: this.instanceId, reserve: this.reserve };
  }

  markPersisted(s: SequencerState): void {
    this.persisted = s.reserve;
  }
}

export function buildEnvelope(cfg: Pick<Config, "instanceId" | "ctx">, events: IngestEvent[]): Envelope {
  return { orbit: ORBIT_VERSION, instance_id: cfg.instanceId, ctx: cfg.ctx, src: "mod", events };
}
