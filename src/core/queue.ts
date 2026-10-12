import type { IngestEvent } from "./types.js";

export interface QueueOptions {
  /** Máximo de eventos retenidos. */
  maxEvents: number;
  /** Máximo de bytes (JSON) retenidos: la cola se persiste en $.store, que admite 4 MiB en total. */
  maxBytes: number;
}

export const DEFAULT_QUEUE: QueueOptions = { maxEvents: 5000, maxBytes: 3_000_000 };

interface Entry {
  item: IngestEvent;
  size: number;
}

export interface QueueSnapshot {
  items: IngestEvent[];
  dropped: number;
}

/**
 * Cola de eventos pendientes de enviar, ordenada por n. Al llegar al tope descarta los MÁS
 * VIEJOS y lo cuenta en `dropped`: la pérdida nunca es silenciosa (quien llama lee el valor
 * devuelto por `push` / `droppedTotal` y lo registra).
 */
export class OfflineQueue {
  private entries: Entry[] = [];
  private bytes = 0;
  droppedTotal = 0;
  /** Se incrementa en cada cambio: sirve para saber si hay algo que persistir. */
  version = 0;

  constructor(readonly opts: QueueOptions = DEFAULT_QUEUE) {}

  get length(): number {
    return this.entries.length;
  }

  get byteSize(): number {
    return this.bytes;
  }

  /** Añade un evento. Devuelve cuántos eventos viejos tuvo que descartar para caber. */
  push(item: IngestEvent): number {
    const size = JSON.stringify(item).length;
    this.entries.push({ item, size });
    this.bytes += size;
    this.version++;
    return this.enforce();
  }

  private enforce(): number {
    let dropped = 0;
    // Siempre se conserva al menos el evento más nuevo, aunque él solo supere maxBytes.
    while (this.entries.length > 1 && (this.entries.length > this.opts.maxEvents || this.bytes > this.opts.maxBytes)) {
      const e = this.entries.shift()!;
      this.bytes -= e.size;
      dropped++;
    }
    this.droppedTotal += dropped;
    if (dropped > 0) this.version++;
    return dropped;
  }

  /** Los primeros `max` eventos, sin quitarlos. */
  peek(max: number): IngestEvent[] {
    return this.entries.slice(0, max).map((e) => e.item);
  }

  /** Quita los primeros `count` (ya enviados). */
  ack(count: number): void {
    const gone = this.entries.splice(0, count);
    for (const e of gone) this.bytes -= e.size;
    if (gone.length > 0) this.version++;
  }

  /** Quita los primeros `count` por rechazo definitivo del servidor, contándolos como perdidos. */
  reject(count: number): number {
    const before = this.entries.length;
    this.ack(count);
    const lost = before - this.entries.length;
    this.droppedTotal += lost;
    return lost;
  }

  toJSON(): QueueSnapshot {
    return { items: this.entries.map((e) => e.item), dropped: this.droppedTotal };
  }

  /** Recarga lo persistido (ordenado por n). Los que no caben se descartan y se cuentan. */
  load(snapshot: QueueSnapshot): number {
    this.droppedTotal = Math.max(this.droppedTotal, snapshot.dropped);
    const items = [...snapshot.items].sort((a, b) => a.n - b.n);
    let dropped = 0;
    for (const it of items) dropped += this.push(it);
    return dropped;
  }
}
