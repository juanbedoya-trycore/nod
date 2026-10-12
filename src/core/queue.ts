/** Topes de la cola: se persiste en el almacén del agente (en Claude, `$.store`, con 4 MiB en total). */
export interface QueueOptions {
  maxEvents: number;
  maxBytes: number;
}

export const DEFAULT_QUEUE: QueueOptions = { maxEvents: 5000, maxBytes: 1_000_000 };

interface Entry<T> {
  item: T;
  size: number;
}

export interface QueueSnapshot<T> {
  items: T[];
  dropped: number;
}

/**
 * Cola de pendientes de enviar, en orden de llegada. Al llegar al tope descarta los MÁS VIEJOS y lo cuenta
 * en `droppedTotal`: la pérdida nunca es silenciosa.
 */
export class OfflineQueue<T> {
  private entries: Entry<T>[] = [];
  private bytes = 0;
  droppedTotal = 0;
  /** Se incrementa en cada cambio: dice si hay algo que persistir. */
  version = 0;

  constructor(readonly opts: QueueOptions = DEFAULT_QUEUE) {}

  get length(): number {
    return this.entries.length;
  }

  get byteSize(): number {
    return this.bytes;
  }

  /** Añade uno. Devuelve cuántos viejos tuvo que descartar para caber. */
  push(item: T): number {
    const size = JSON.stringify(item).length;
    this.entries.push({ item, size });
    this.bytes += size;
    this.version++;
    let dropped = 0;
    // Siempre se conserva al menos el más nuevo, aunque él solo supere maxBytes.
    while (this.entries.length > 1 && (this.entries.length > this.opts.maxEvents || this.bytes > this.opts.maxBytes)) {
      this.bytes -= this.entries.shift()!.size;
      dropped++;
    }
    this.droppedTotal += dropped;
    return dropped;
  }

  peek(max: number): T[] {
    return this.entries.slice(0, max).map((e) => e.item);
  }

  /**
   * Quita estos elementos (los entregados), por identidad: si mientras se enviaban la cola descartó cabeza o se
   * reescribió, no se lleva otros por posición.
   */
  ackItems(items: readonly T[]): void {
    if (items.length === 0) return;
    const gone = new Set<T>(items);
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => {
      if (!gone.has(e.item)) return true;
      this.bytes -= e.size;
      return false;
    });
    if (this.entries.length !== before) this.version++;
  }

  /** Quita estos elementos por rechazo definitivo, contándolos como perdidos. */
  rejectItems(items: readonly T[]): number {
    const before = this.entries.length;
    this.ackItems(items);
    const lost = before - this.entries.length;
    this.droppedTotal += lost;
    return lost;
  }

  /** Reescribe o quita (undefined) cada elemento; devuelve cuántos quitó. Sirve para endurecer la privacidad. */
  rewrite(fn: (item: T) => T | undefined): number {
    const kept: Entry<T>[] = [];
    let removed = 0;
    let changed = false;
    for (const e of this.entries) {
      const next = fn(e.item);
      if (next === undefined) {
        removed++;
        continue;
      }
      if (next !== e.item) changed = true;
      kept.push(next === e.item ? e : { item: next, size: JSON.stringify(next).length });
    }
    if (removed > 0 || changed) {
      this.entries = kept;
      this.bytes = kept.reduce((n, e) => n + e.size, 0);
      this.version++;
    }
    return removed;
  }

  toJSON(): QueueSnapshot<T> {
    return { items: this.entries.map((e) => e.item), dropped: this.droppedTotal };
  }

  /** Recarga lo persistido. Lo que no cabe se descarta y se cuenta. */
  load(snapshot: QueueSnapshot<T>): number {
    this.droppedTotal = Math.max(this.droppedTotal, Number(snapshot.dropped) || 0);
    let dropped = 0;
    for (const it of snapshot.items) dropped += this.push(it);
    return dropped;
  }
}
