/** Espacio de `seq` por milisegundo de arranque: dos procesos que arrancan en ms distintos no se solapan. */
export const SEQ_PER_MS = 1024;

export interface CounterState {
  instance: string;
  reserve: number;
}

/**
 * `seq` creciente por instancia (docs/nod-v1.md §1.3). Se reserva por bloques: lo persistido (`reserve`)
 * siempre es >= cualquier `seq` ya dado, y al arrancar se sigue desde ahí (puede haber huecos, nunca repetidos).
 * Además arranca como mínimo en `ahora * 1024`: varios procesos del agente (o un almacén vaciado) con la misma
 * instancia no reutilizan números, y el orden entre reinicios se mantiene (cabe en 2^53 hasta el año 2255).
 */
export class Counter {
  private n: number;
  private reserve: number;
  private persisted: number;

  constructor(readonly instance: string, saved: CounterState | undefined, nowMs: number, readonly block = 1000) {
    const fromStore = saved && saved.instance === instance && Number.isInteger(saved.reserve) ? saved.reserve : 0;
    const fromClock = Number.isFinite(nowMs) && nowMs > 0 ? Math.floor(nowMs) * SEQ_PER_MS : 0;
    const start = Math.min(Math.max(fromStore, fromClock), Number.MAX_SAFE_INTEGER - 2 * block);
    this.n = start;
    this.reserve = start + block;
    this.persisted = start;
  }

  next(): number {
    this.n += 1;
    if (this.n >= this.reserve) this.reserve = this.n + this.block;
    return this.n;
  }

  /** Hay una reserva sin guardar: guardarla antes de entregar nada. */
  get dirty(): boolean {
    return this.reserve !== this.persisted;
  }

  snapshot(): CounterState {
    return { instance: this.instance, reserve: this.reserve };
  }

  markSaved(): void {
    this.persisted = this.reserve;
  }
}
