import { applyAllowlist } from "./allowlist.js";
import { OfflineQueue, DEFAULT_QUEUE } from "./queue.js";
import type { QueueOptions, QueueSnapshot } from "./queue.js";
import { Sequencer, buildEnvelope } from "./sequencer.js";
import type { SequencerState } from "./sequencer.js";
import type { Config, HookPayload, IngestEvent } from "./types.js";
import { effectiveCtx } from "./types.js";

export const BATCH_WINDOW_MS = 250;
export const MAX_BATCH = 500;
const MAX_BACKOFF_MS = 30_000;

/** Claves de $.store. Contador y cola van por instancia: cambiar de instance_id no pisa el estado de otra. */
export const STORE_KEYS = {
  seq: (instanceId: string) => `orbit.seq.${instanceId}`,
  queue: (instanceId: string) => `orbit.queue.${instanceId}`,
  /** Por instancia: la pausa de una no debe pausar a las demás que comparten el mismo store. */
  paused: (instanceId: string) => `orbit.paused.${instanceId}`,
} as const;

export interface HttpReply {
  status: number;
  ok: boolean;
  text: string;
}

/** Todo lo que el colector necesita del exterior; en el plugin sale de `$`. */
export interface Io {
  now(): number | Promise<number>;
  post(url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<HttpReply>;
  load(key: string): Promise<unknown>;
  save(key: string, value: unknown): Promise<void>;
  log(message: string): void;
}

export interface CollectorOptions {
  queue?: Partial<QueueOptions>;
  batchWindowMs?: number;
  maxBatch?: number;
  /** Tamaño del bloque de reserva de `n`. */
  seqBlock?: number;
}

export interface CollectorStatus {
  state: "connected" | "offline" | "paused" | "pending" | "idle";
  paused: boolean;
  queued: number;
  queuedBytes: number;
  sent: number;
  dropped: number;
  /** Eventos que el servidor dio por repetidos (mismo n ya visto): no se pierden en la red, pero no entran. */
  duplicates: number;
  lastError: string | undefined;
  lastErrorAt: number | undefined;
  lastOkAt: number | undefined;
}

interface PersistedQueue extends QueueSnapshot {
  v: 1;
  instance_id: string;
}

/** Estados HTTP con los que el servidor rechaza el lote para siempre (reenviarlo no lo arregla). */
const REJECTED = new Set([400, 413, 422]);

/**
 * Orquesta: sobre §3.1 con `n` monótono, lista blanca §3.4 antes de encolar, lotes de 250 ms
 * (máx. 500 eventos) y cola offline con reenvío en orden de `n`. No depende de `$`.
 *
 * Uso: `ingest()` encola; `delay()` dice cuándo llamar a `flush()`; `flush()` envía.
 */
export class Collector {
  private seq!: Sequencer;
  private queue: OfflineQueue;
  private paused = false;
  private dirtyAt: number | null = null;
  private fails = 0;
  private nextRetryAt = 0;
  private sent = 0;
  private duplicates = 0;
  private lastError: string | undefined;
  private lastErrorAt: number | undefined;
  private lastOkAt: number | undefined;
  private unreportedDrops = 0;
  private persistedVersion = -1;
  private chain: Promise<void> = Promise.resolve();
  private readonly batchMs: number;
  private readonly maxBatch: number;

  constructor(
    readonly cfg: Config,
    public io: Io,
    private readonly options: CollectorOptions = {},
  ) {
    this.queue = new OfflineQueue({ ...DEFAULT_QUEUE, ...options.queue });
    this.batchMs = options.batchWindowMs ?? BATCH_WINDOW_MS;
    this.maxBatch = Math.min(options.maxBatch ?? MAX_BATCH, MAX_BATCH);
  }

  /** Carga el contador y la cola persistidos. Llamar una vez, antes del primer `ingest`. */
  async init(): Promise<void> {
    const savedSeq = (await this.io.load(STORE_KEYS.seq(this.cfg.instanceId))) as SequencerState | undefined;
    this.seq = new Sequencer(this.cfg.instanceId, savedSeq, this.options.seqBlock, Number(await this.io.now()));
    await this.saveSeq();
    this.paused = (await this.io.load(STORE_KEYS.paused(this.cfg.instanceId))) === true;

    const stored = (await this.io.load(STORE_KEYS.queue(this.cfg.instanceId))) as PersistedQueue | undefined;
    if (stored && Array.isArray(stored.items)) {
      if (stored.instance_id !== this.cfg.instanceId) {
        // Otra instancia tiene otro espacio de n: reenviarlo con esta identidad sería incorrecto.
        this.queue.droppedTotal += stored.items.length;
        this.unreportedDrops += stored.items.length;
        this.io.log(`nod: se descartaron ${stored.items.length} eventos en cola de la instancia "${stored.instance_id}" (ahora es "${this.cfg.instanceId}")`);
      } else {
        // Si ctx pasó a work, lo que se guardó con ctx=personal se vuelve a filtrar antes de reenviarlo.
        const items = stored.items.map((it) => ({ ...it, ev: applyAllowlist(it.ev, effectiveCtx(this.cfg)) }));
        this.unreportedDrops += this.queue.load({ items, dropped: Number(stored.dropped) || 0 });
      }
    }
    this.persistedVersion = -1;
  }

  /** Aplica la lista blanca, asigna `n` y `rx` y encola. Devuelve cuántos eventos entraron. */
  ingest(payloads: HookPayload[], now: number): number {
    for (const payload of payloads) {
      const item: IngestEvent = { n: this.seq.next(), rx: now, ev: applyAllowlist(payload, effectiveCtx(this.cfg)) };
      this.unreportedDrops += this.queue.push(item);
    }
    if (payloads.length > 0 && this.dirtyAt === null) this.dirtyAt = now;
    return payloads.length;
  }

  /** Milisegundos hasta el próximo envío debido, o null si no hay nada que enviar ahora. */
  delay(now: number): number | null {
    if (this.paused || this.queue.length === 0) return null;
    const due = this.dirtyAt !== null ? this.dirtyAt + this.batchMs : now;
    return Math.max(0, Math.max(due, this.nextRetryAt) - now);
  }

  setPaused(paused: boolean): Promise<void> {
    this.paused = paused;
    return this.io.save(STORE_KEYS.paused(this.cfg.instanceId), paused);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Envía lo que haya en cola, en orden de n y en lotes de hasta 500. Las llamadas se serializan. */
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.doFlush()).catch((err) => this.fail(err));
    return this.chain;
  }

  private async doFlush(): Promise<void> {
    this.dirtyAt = null;
    if (!this.paused) {
      if (this.seq.dirty) await this.saveSeq();
      // Tamaño de lote: baja a la mitad cuando el servidor rechaza uno (400/413/422) para aislar
      // el evento culpable en vez de perder hasta 500 por uno solo inválido.
      let size = this.maxBatch;
      while (this.queue.length > 0) {
        const batch = this.queue.peek(size);
        const url = `${this.cfg.url}/v0/ingest`;
        let reply: HttpReply;
        try {
          reply = await this.io.post(url, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.token}` },
            body: JSON.stringify(buildEnvelope(this.cfg, batch)),
          });
        } catch (err) {
          await this.fail(err);
          break;
        }
        if (reply.ok) {
          this.queue.ack(batch.length);
          this.sent += batch.length;
          this.noteDuplicates(reply.text);
          this.fails = 0;
          this.nextRetryAt = 0;
          this.lastOkAt = await this.io.now();
          continue;
        }
        if (REJECTED.has(reply.status)) {
          if (batch.length > 1) {
            size = Math.ceil(batch.length / 2);
            continue;
          }
          const lost = this.queue.reject(1);
          this.unreportedDrops += lost;
          size = this.maxBatch;
          await this.fail(new Error(`el servidor rechazó un evento (HTTP ${reply.status}): se descartó`), false);
          continue;
        }
        await this.fail(new Error(`HTTP ${reply.status}${reply.text ? `: ${reply.text.slice(0, 120)}` : ""}`));
        break;
      }
    }
    this.reportLoss();
    await this.persist();
  }

  /** El servidor responde 200 aunque descarte repetidos: que no pase inadvertido (colisión de `n`). */
  private noteDuplicates(text: string): void {
    let dup = 0;
    try {
      dup = Number((JSON.parse(text) as { duplicates?: unknown }).duplicates) || 0;
    } catch {
      return;
    }
    if (dup <= 0) return;
    this.duplicates += dup;
    this.io.log(`nod: el servidor descartó ${dup} eventos por repetidos (n ya visto; total ${this.duplicates}). Si no es un reenvío, otra sesión usa el mismo instance_id`);
  }

  private async fail(err: unknown, backoff = true): Promise<void> {
    const now = await this.io.now();
    this.lastError = err instanceof Error ? err.message : String(err);
    this.lastErrorAt = now;
    if (backoff) {
      this.fails++;
      this.nextRetryAt = now + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.fails - 1));
    }
  }

  /** Nunca descartar en silencio: cada pérdida acaba en el log con su cuenta. */
  private reportLoss(): void {
    if (this.unreportedDrops === 0) return;
    this.io.log(`nod: se perdieron ${this.unreportedDrops} eventos (cola llena o rechazados; total perdidos: ${this.queue.droppedTotal})`);
    this.unreportedDrops = 0;
  }

  private async saveSeq(): Promise<void> {
    const s = this.seq.snapshot();
    await this.io.save(STORE_KEYS.seq(this.cfg.instanceId), s);
    this.seq.markPersisted(s);
  }

  private async persist(): Promise<void> {
    if (this.queue.version === this.persistedVersion) return;
    const version = this.queue.version;
    try {
      if (this.queue.length === 0 && this.queue.droppedTotal === 0) await this.io.save(STORE_KEYS.queue(this.cfg.instanceId), null);
      else await this.io.save(STORE_KEYS.queue(this.cfg.instanceId), { v: 1, instance_id: this.cfg.instanceId, ...this.queue.toJSON() });
      this.persistedVersion = version;
    } catch (err) {
      this.io.log(`nod: no se pudo guardar la cola (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  status(): CollectorStatus {
    const state: CollectorStatus["state"] = this.paused
      ? "paused"
      : this.fails > 0
        ? "offline"
        : this.queue.length > 0
          ? "pending"
          : this.lastOkAt !== undefined
            ? "connected"
            : "idle";
    return {
      state,
      paused: this.paused,
      queued: this.queue.length,
      queuedBytes: this.queue.byteSize,
      sent: this.sent,
      dropped: this.queue.droppedTotal,
      duplicates: this.duplicates,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      lastOkAt: this.lastOkAt,
    };
  }
}
