// Entrega a un destino (docs/nod-v1.md §1): cola persistente, lotes, reintentos con espera y aislamiento del
// evento que el destino rechaza. Una Outbox por destino; no sabe si escribe en un fichero o por HTTP.
import { NOD_VERSION } from "./events.js";
import type { Envelope, NodEvent, Privacy, Source } from "./events.js";
import { OfflineQueue } from "./queue.js";
import type { QueueOptions, QueueSnapshot } from "./queue.js";
import type { SinkConfig } from "./config.js";

export const BATCH_WINDOW_MS = 250;
export const MAX_BATCH = 500;
const MAX_BACKOFF_MS = 30_000;
/** Rechazo definitivo: reenviar el mismo lote no lo arregla. */
const REJECTED = new Set([400, 413, 422]);

/** Lo que guarda la cola: el evento ya filtrado y el perfil con el que se filtró. */
export interface Queued {
  e: NodEvent;
  p: Privacy;
}

export interface Delivery {
  status: number;
  text?: string;
}

/** Entrega un sobre. Lanza si no pudo (red, disco): la Outbox reintenta. */
export type Transport = (env: Envelope) => Promise<Delivery>;

export interface OutboxIo {
  now: () => Promise<number>;
  load: (key: string) => Promise<unknown>;
  save: (key: string, value: unknown) => Promise<void>;
  log: (message: string) => void;
}

export interface OutboxStatus {
  kind: "file" | "http";
  target: string;
  queued: number;
  sent: number;
  dropped: number;
  duplicates: number;
  lastOkAt: number | undefined;
  lastError: string | undefined;
  lastErrorAt: number | undefined;
}

/** Id corto y estable de un destino (FNV-1a de 32 bits): clave de su cola en el almacén. */
export function sinkId(s: SinkConfig): string {
  let h = 0x811c9dc5;
  for (const ch of `${s.kind}:${s.target}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export class Outbox {
  readonly queue: OfflineQueue<Queued>;
  private dirtyAt: number | null = null;
  private fails = 0;
  private nextRetryAt = 0;
  private sent = 0;
  private duplicates = 0;
  private lastOkAt: number | undefined;
  private lastError: string | undefined;
  private lastErrorAt: number | undefined;
  private reportedDrops = 0;
  private savedVersion = -1;
  private chain: Promise<void> = Promise.resolve();
  readonly key: string;

  constructor(
    readonly sink: SinkConfig,
    private readonly source: (p: Privacy) => Source,
    private readonly transport: Transport,
    public io: OutboxIo,
    instance: string,
    queue?: Partial<QueueOptions>,
  ) {
    this.queue = new OfflineQueue<Queued>({ maxEvents: 5000, maxBytes: 1_000_000, ...queue });
    this.key = `nod.outbox.${instance}.${sinkId(sink)}`;
  }

  /** Recupera lo que quedó sin entregar en la sesión anterior. */
  async init(): Promise<void> {
    const saved = (await this.io.load(this.key)) as QueueSnapshot<Queued> | undefined;
    if (saved && Array.isArray(saved.items)) this.queue.load(saved);
    this.savedVersion = this.queue.version;
  }

  push(item: Queued, now: number): void {
    this.queue.push(item);
    if (this.dirtyAt === null) this.dirtyAt = now;
  }

  /** Milisegundos hasta el próximo envío, o null si no hay nada pendiente. */
  delay(now: number, paused: boolean): number | null {
    if (paused || this.queue.length === 0) return null;
    const due = this.dirtyAt !== null ? this.dirtyAt + BATCH_WINDOW_MS : now;
    return Math.max(0, Math.max(due, this.nextRetryAt) - now);
  }

  /** Envía ya, sin esperar a la ventana del lote (fin de turno, permiso pendiente…). */
  urgent(): void {
    this.dirtyAt = 0;
  }

  /** Entrega lo que haya, en orden y en lotes. Las llamadas se encadenan; nunca lanza. */
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.doFlush()).catch((err) => this.fail(err));
    return this.chain;
  }

  private async doFlush(): Promise<void> {
    this.dirtyAt = null;
    let size = MAX_BATCH;
    while (this.queue.length > 0) {
      const head = this.queue.peek(size);
      // Un lote lleva un solo perfil de privacidad (el sobre lo declara).
      const p = head[0]!.p;
      let n = head.findIndex((q) => q.p !== p);
      if (n < 0) n = head.length;
      const batch = head.slice(0, n);
      let r: Delivery;
      try {
        r = await this.transport({ nod: NOD_VERSION, source: this.source(p), events: batch.map((q) => q.e) });
      } catch (err) {
        await this.fail(err);
        break;
      }
      if (r.status >= 200 && r.status < 300) {
        this.queue.ack(batch.length);
        this.sent += batch.length;
        this.noteDuplicates(r.text);
        this.fails = 0;
        this.nextRetryAt = 0;
        this.lastOkAt = await this.io.now();
        size = MAX_BATCH;
        continue;
      }
      if (REJECTED.has(r.status)) {
        if (batch.length > 1) {
          size = Math.max(1, Math.floor(batch.length / 2));
          continue;
        }
        this.queue.reject(1);
        this.io.log(`nod: ${this.sink.target} rechazó un evento (HTTP ${r.status}); descartado`);
        this.lastError = `HTTP ${r.status} (evento descartado)`;
        this.lastErrorAt = await this.io.now();
        continue;
      }
      await this.fail(new Error(`HTTP ${r.status}`));
      break;
    }
    await this.persist();
    this.reportDrops();
  }

  private noteDuplicates(text: string | undefined): void {
    if (!text) return;
    try {
      const d = (JSON.parse(text) as { duplicates?: unknown }).duplicates;
      if (typeof d === "number" && d > 0) this.duplicates += d;
    } catch {
      // respuesta sin JSON: vale
    }
  }

  private async fail(err: unknown): Promise<void> {
    this.fails++;
    const wait = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(this.fails - 1, 6));
    const now = await this.io.now();
    this.nextRetryAt = now + wait;
    this.lastError = err instanceof Error ? err.message : String(err);
    this.lastErrorAt = now;
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (this.queue.version === this.savedVersion) return;
    try {
      await this.io.save(this.key, this.queue.length === 0 ? null : this.queue.toJSON());
      this.savedVersion = this.queue.version;
    } catch (err) {
      this.io.log(`nod: no se pudo guardar la cola de ${this.sink.target} (${String(err)})`);
    }
  }

  private reportDrops(): void {
    const lost = this.queue.droppedTotal - this.reportedDrops;
    if (lost <= 0) return;
    this.reportedDrops = this.queue.droppedTotal;
    this.io.log(`nod: se perdieron ${lost} eventos hacia ${this.sink.target} (cola llena o rechazados)`);
  }

  status(): OutboxStatus {
    return {
      kind: this.sink.kind,
      target: this.sink.target,
      queued: this.queue.length,
      sent: this.sent,
      dropped: this.queue.droppedTotal,
      duplicates: this.duplicates,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
    };
  }
}
