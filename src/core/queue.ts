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

  /** Quita los primeros `count` (entregados). */
  ack(count: number): void {
    const gone = this.entries.splice(0, count);
    for (const e of gone) this.bytes -= e.size;
    if (gone.length > 0) this.version++;
  }

  /** Quita los primeros `count` por rechazo definitivo, contándolos como perdidos. */
  reject(count: number): number {
    const before = this.entries.length;
    this.ack(count);
    const lost = before - this.entries.length;
    this.droppedTotal += lost;
    return lost;
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
