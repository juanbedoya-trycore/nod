// Entrega a un destino (docs/nod-v1.md §1): cola persistente, lotes, reintentos con espera y aislamiento del
// evento que el destino rechaza. Una Outbox por destino; no sabe si escribe en un fichero o por HTTP.
//
// Varias sesiones del agente con el mismo perfil comparten el almacén: cada proceso guarda su cola en su propia
// clave (por ejecución) y apunta la clave en un índice; al arrancar, adopta las colas de ejecuciones que llevan
// un rato sin guardar (procesos que murieron con eventos pendientes). Así ninguna pisa la de otra.
import { NOD_VERSION } from "./events.js";
import type { Envelope, NodEvent, Privacy, Source } from "./events.js";
import { applyPrivacy, isStricter, shortHash } from "./privacy.js";
import { OfflineQueue } from "./queue.js";
import type { QueueOptions, QueueSnapshot } from "./queue.js";
import type { SinkConfig } from "./config.js";

export const BATCH_WINDOW_MS = 250;
export const MAX_BATCH = 500;
const MAX_BACKOFF_MS = 30_000;
/** Cada cuánto, como mucho, se guarda la cola mientras crece (además de tras cada entrega o fallo). */
const PERSIST_EVERY_MS = 2_000;
/** Una cola ajena sin guardar desde hace tanto es de un proceso que ya no está: se adopta. */
export const ORPHAN_AFTER_MS = 10 * 60_000;
/** Rechazo definitivo: reenviar el mismo lote no lo arregla. */
const REJECTED = new Set([400, 413, 422]);

/** Lo que guarda la cola: el evento ya filtrado, el perfil con el que se filtró y la ejecución que lo emitió. */
export interface Queued {
  e: NodEvent;
  p: Privacy;
  r: string;
}

export interface Delivery {
  status: number;
  text?: string;
}

/** Entrega un sobre. Lanza si no pudo (red, disco, plazo): la Outbox reintenta. */
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
  adopted: number;
  lastOkAt: number | undefined;
  lastError: string | undefined;
  lastErrorAt: number | undefined;
}

interface Saved extends QueueSnapshot<Queued> {
  at: number;
}

/** Id corto y estable de un destino: parte de la clave de su cola en el almacén. */
export function sinkId(s: SinkConfig): string {
  return shortHash(`${s.kind}:${s.target}`);
}

export class Outbox {
  readonly queue: OfflineQueue<Queued>;
  private dirtyAt: number | null = null;
  private fails = 0;
  private nextRetryAt = 0;
  private sent = 0;
  private duplicates = 0;
  private adopted = 0;
  private lastOkAt: number | undefined;
  private lastError: string | undefined;
  private lastErrorAt: number | undefined;
  private reportedDrops = 0;
  private savedVersion = -1;
  private savedAt = 0;
  private chain: Promise<void> = Promise.resolve();
  /** Prefijo común a todas las ejecuciones; `key` es la de esta. */
  readonly base: string;
  readonly key: string;

  constructor(
    readonly sink: SinkConfig,
    private readonly source: (p: Privacy, run: string) => Source,
    private readonly transport: Transport,
    public io: OutboxIo,
    instance: string,
    readonly run: string,
    queue?: Partial<QueueOptions>,
  ) {
    this.queue = new OfflineQueue<Queued>({ maxEvents: 5000, maxBytes: 1_000_000, ...queue });
    this.base = `nod.outbox.${instance}.${sinkId(sink)}`;
    this.key = `${this.base}.${run}`;
  }

  /** Se apunta en el índice y adopta las colas de ejecuciones muertas. Nunca lanza. */
  async init(): Promise<void> {
    try {
      const now = await this.io.now();
      const index = await this.loadIndex();
      const keep: string[] = [];
      for (const run of index) {
        if (run === this.run) continue;
        const saved = (await this.io.load(`${this.base}.${run}`)) as Saved | undefined;
        if (saved === undefined || saved === null || !Array.isArray(saved.items)) continue; // vacía: fuera del índice
        if (now - (Number(saved.at) || 0) < ORPHAN_AFTER_MS) {
          keep.push(run); // otra sesión viva: su cola es suya
          continue;
        }
        this.queue.load({ items: saved.items, dropped: 0 });
        this.adopted += saved.items.length;
        await this.io.save(`${this.base}.${run}`, null);
      }
      await this.io.save(`${this.base}.runs`, [...keep, this.run]);
      // Formato anterior (una sola clave compartida): se adopta tal cual.
      const legacy = (await this.io.load(this.base)) as QueueSnapshot<Queued> | undefined;
      if (legacy && Array.isArray(legacy.items)) {
        this.queue.load({ items: legacy.items.filter((q) => typeof q?.r === "string"), dropped: 0 });
        await this.io.save(this.base, null);
      }
      if (this.adopted > 0) this.io.log(`nod: ${this.adopted} eventos pendientes de sesiones anteriores hacia ${this.sink.target}`);
      if (this.queue.length > 0) this.dirtyAt = now;
      await this.persist(true);
    } catch (err) {
      this.io.log(`nod: no se pudo recuperar la cola de ${this.sink.target} (${String(err)})`);
    }
  }

  private async loadIndex(): Promise<string[]> {
    const v = await this.io.load(`${this.base}.runs`);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(-50) : [];
  }

  push(item: Queued, now: number): void {
    this.queue.push(item);
    if (this.dirtyAt === null) this.dirtyAt = now;
  }

  /**
   * Deja la cola como si todo se hubiera encolado con `privacy`: lo que entró con un perfil más laxo se vuelve
   * a filtrar; si el destino ya no puede recibir nada (`allowed` = false), se vacía. Devuelve cuántos quitó.
   */
  async restrict(privacy: Privacy, allowed: boolean): Promise<number> {
    const removed = allowed
      ? this.queue.rewrite((q) => (isStricter(privacy, q.p) ? { e: applyPrivacy(q.e, privacy), p: privacy, r: q.r } : q))
      : this.queue.rewrite(() => undefined);
    await this.persist(true);
    return removed;
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

  /** Guarda la cola si cambió y hace un rato que no se guarda (un cierre brusco no pierde lo encolado). */
  async persistSoon(now: number): Promise<void> {
    if (now - this.savedAt >= PERSIST_EVERY_MS) await this.persist();
  }

  /** Entrega lo que haya, en orden y en lotes. Las llamadas se encadenan; nunca lanza ni rompe la cadena. */
  flush(): Promise<void> {
    this.chain = this.chain
      .catch(() => undefined)
      .then(() => this.doFlush())
      .catch((err) => this.fail(err).catch(() => undefined));
    return this.chain;
  }

  private async doFlush(): Promise<void> {
    this.dirtyAt = null;
    let size = MAX_BATCH;
    while (this.queue.length > 0) {
      const head = this.queue.peek(size);
      // Un sobre declara un perfil y una ejecución: el lote es el tramo inicial que comparte los dos.
      const { p, r } = head[0]!;
      let n = head.findIndex((q) => q.p !== p || q.r !== r);
      if (n < 0) n = head.length;
      const batch = head.slice(0, n);
      let res: Delivery;
      try {
        res = await this.transport({ nod: NOD_VERSION, source: this.source(p, r), events: batch.map((q) => q.e) });
      } catch (err) {
        await this.fail(err);
        break;
      }
      if (res.status >= 200 && res.status < 300) {
        this.queue.ackItems(batch);
        this.sent += batch.length;
        this.noteDuplicates(res.text);
        this.fails = 0;
        this.nextRetryAt = 0;
        this.lastOkAt = await this.io.now();
        size = MAX_BATCH;
        continue;
      }
      if (REJECTED.has(res.status)) {
        if (batch.length > 1) {
          size = Math.max(1, Math.floor(batch.length / 2));
          continue;
        }
        this.queue.rejectItems(batch);
        this.io.log(`nod: ${this.sink.target} rechazó un evento (HTTP ${res.status}); descartado`);
        this.lastError = `HTTP ${res.status} (evento descartado)`;
        this.lastErrorAt = await this.io.now();
        continue;
      }
      await this.fail(new Error(`HTTP ${res.status}`));
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

  private async persist(force = false): Promise<void> {
    if (!force && this.queue.version === this.savedVersion) return;
    try {
      const now = await this.io.now();
      const value: Saved | null = this.queue.length === 0 ? null : { ...this.queue.toJSON(), at: now };
      await this.io.save(this.key, value);
      // Si otra sesión rehízo el índice a la vez, esta clave podría faltar: que esté mientras haya algo guardado.
      if (value !== null) {
        const index = await this.loadIndex();
        if (!index.includes(this.run)) await this.io.save(`${this.base}.runs`, [...index, this.run]);
      }
      this.savedVersion = this.queue.version;
      this.savedAt = now;
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
      adopted: this.adopted,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
    };
  }
}
