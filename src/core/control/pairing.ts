// Emparejamiento (docs/control-v1.md §3.3 y §4.3). `/nod emparejar` genera K (32 bytes aleatorios, un solo uso,
// 15 minutos), lo guarda en `$XDG_STATE_HOME/nod/pairing.json` y lo muestra en un QR junto con la dirección del
// controlador. El aprobador lee el QR, calcula `tag = HMAC(K, ["nod-pair", 1, instance, spki])` con su llave y
// publica la oferta en el controlador. Nod empareja la llave de una oferta cuyo `tag` verifica con un K vigente,
// y consume ese K.
//
// Por qué basta: K solo viaja de la pantalla a la cámara del aprobador, nunca al controlador. Ni el controlador
// ni quien publique ofertas puede fabricar un `tag` válido para SU llave: el `tag` dice "esta llave la publicó
// quien leyó el QR que el usuario acaba de enseñar".
import * as qr from "../../vendor/qrcode.js";
import { PAIR_K_LEN, SPKI_LEN, TAG_LEN, b64u, fromB64u, kidOf, spkiPoint, verifyPairTag } from "./crypto.js";
import { CALL_TIMEOUT_MS, call, headers, parseJson } from "./io.js";
import type { ControlIo, Controller } from "./io.js";
import { cleanName, isTestKid } from "./approvers.js";

/** Vida de un K (y del QR que lo lleva). */
export const PAIR_TTL_MS = 15 * 60_000;
/** Cuánto espera `/nod emparejar` la oferta, y cada cuánto la busca. */
export const PAIR_WAIT_MS = 2 * 60_000;
export const PAIR_POLL_MS = 2_000;
/** K vigentes que se guardan como mucho (cada `/nod emparejar` añade uno). */
export const MAX_PAIR_KEYS = 8;

export interface PairKeyEntry {
  /** K en base64url. */
  k: string;
  instance: string;
  expires_ms: number;
}

export interface PairingFile {
  v: 1;
  keys: PairKeyEntry[];
}

/** Lee pairing.json; descarta las entradas mal formadas. */
export function parsePairing(text: string | undefined): PairKeyEntry[] {
  if (text === undefined || text.trim() === "") return [];
  const v = parseJson(text);
  const list = v !== null && typeof v === "object" && (v as { v?: unknown }).v === 1 ? (v as { keys?: unknown }).keys : undefined;
  if (!Array.isArray(list)) return [];
  const out: PairKeyEntry[] = [];
  for (const e of list as Partial<PairKeyEntry>[]) {
    if (typeof e?.k !== "string" || typeof e.instance !== "string" || typeof e.expires_ms !== "number") continue;
    try {
      if (fromB64u(e.k).length !== PAIR_K_LEN) continue;
    } catch {
      continue;
    }
    out.push({ k: e.k, instance: e.instance, expires_ms: e.expires_ms });
  }
  return out;
}

/** Añade un K nuevo para `instance` y quita los caducados. */
export function addPairKey(entries: readonly PairKeyEntry[], k: Uint8Array, instance: string, now: number): PairingFile {
  const live = entries.filter((e) => e.expires_ms > now);
  live.push({ k: b64u(k), instance, expires_ms: now + PAIR_TTL_MS });
  return { v: 1, keys: live.slice(-MAX_PAIR_KEYS) };
}

export function livePairKeys(entries: readonly PairKeyEntry[], instance: string, now: number): PairKeyEntry[] {
  return entries.filter((e) => e.instance === instance && e.expires_ms > now);
}

/** La plantilla `pair_url` del controlador, rellena. Undefined si no lleva `{k}` (el QR no serviría). */
export function fillPairUrl(template: string, instance: string, token: string | undefined, k: Uint8Array): string | undefined {
  if (!template.includes("{k}")) return undefined;
  const enc = (s: string) => encodeURIComponent(s);
  return template.replaceAll("{instance}", enc(instance)).replaceAll("{token}", enc(token ?? "")).replaceAll("{k}", b64u(k));
}

// ---------- ofertas ----------

export interface Offer {
  id: string;
  spki: Uint8Array;
  tag: Uint8Array;
  name: string | undefined;
}

export type OfferCheck = { ok: true; k: string; spki: Uint8Array; name: string | undefined } | { ok: false; reason: "malformed" | "test-key" | "tag" };

/** Lee una oferta del controlador. Undefined si no tiene ni `id` (no se puede ni borrar). */
export function parseOffer(raw: unknown): { id: string; offer?: Offer } | undefined {
  const o = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  if (typeof o?.id !== "string" || o.id === "" || o.id.length > 128) return undefined;
  try {
    if (typeof o.spki !== "string" || typeof o.tag !== "string") return { id: o.id };
    const spki = fromB64u(o.spki);
    const tag = fromB64u(o.tag);
    if (spki.length !== SPKI_LEN || tag.length !== TAG_LEN) return { id: o.id };
    return { id: o.id, offer: { id: o.id, spki, tag, name: cleanName(o.name) } };
  } catch {
    return { id: o.id };
  }
}

/** ¿Con qué K vigente verifica esta oferta? Una llave de prueba nunca se empareja. */
export function checkOffer(offer: Offer, instance: string, live: readonly PairKeyEntry[]): OfferCheck {
  try {
    spkiPoint(offer.spki);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (isTestKid(kidOf(offer.spki))) return { ok: false, reason: "test-key" };
  const match = live.find((e) => e.instance === instance && verifyPairTag(fromB64u(e.k), instance, offer.spki, offer.tag));
  return match === undefined ? { ok: false, reason: "tag" } : { ok: true, k: match.k, spki: offer.spki, name: offer.name };
}

/** Lo que el emparejamiento necesita guardar y leer (approvers.json y pairing.json, vía el motor). */
export interface PairingStore {
  pairKeys: () => Promise<PairKeyEntry[]>;
  /** Quita K de pairing.json: un solo uso. */
  consume: (k: string) => Promise<void>;
  /** Guarda la llave en approvers.json. Devuelve un error si no se pudo. */
  addApprover: (spki: Uint8Array, name: string | undefined) => Promise<string | undefined>;
}

export interface PairResult {
  /** Había algún K vigente (si no, ni se pregunta al controlador). */
  armed: boolean;
  paired: { kid: string; name: string | undefined }[];
  rejected: number;
}

/**
 * Busca ofertas y empareja las que verifican con un K vigente de la instancia. Cada K sirve una vez: se consume
 * antes de guardar la llave. Las ofertas usadas o inválidas se borran del controlador. Nunca lanza.
 */
export async function pairOffers(controller: Controller, io: ControlIo, instance: string, store: PairingStore): Promise<PairResult> {
  const result: PairResult = { armed: false, paired: [], rejected: 0 };
  try {
    const live = livePairKeys(await store.pairKeys(), instance, await io.now());
    if (live.length === 0) return result;
    result.armed = true;
    const r = await call(io, CALL_TIMEOUT_MS, `${controller.url}/v1/control/pair-offers?instance=${encodeURIComponent(instance)}`, { method: "GET", headers: headers(controller, false) });
    if (r?.status !== 200) return result;
    const offers = (parseJson(r.text) as { offers?: unknown } | undefined)?.offers;
    if (!Array.isArray(offers)) return result;
    const used = new Set<string>();
    for (const raw of offers) {
      const parsed = parseOffer(raw);
      if (parsed === undefined) continue;
      const check = parsed.offer === undefined ? ({ ok: false, reason: "malformed" } as const) : checkOffer(parsed.offer, instance, live.filter((e) => !used.has(e.k)));
      if (check.ok) {
        used.add(check.k);
        await store.consume(check.k);
        const err = await store.addApprover(check.spki, check.name);
        if (err === undefined) result.paired.push({ kid: b64u(kidOf(check.spki)), name: check.name });
        else {
          result.rejected++;
          io.log(`nod control: no se pudo guardar la llave (${err})`);
        }
      } else {
        result.rejected++;
        io.log(`nod control: oferta de emparejamiento descartada (${check.reason})`);
      }
      void call(io, CALL_TIMEOUT_MS, `${controller.url}/v1/control/pair-offers/${encodeURIComponent(parsed.id)}`, { method: "DELETE", headers: headers(controller, false) });
    }
  } catch (err) {
    io.log(`nod control: emparejamiento falló (${String(err)})`);
  }
  return result;
}

// ---------- QR ----------

interface QrCode {
  addData(data: string, mode: "Byte"): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}
const qrcode = qr.qrcode as unknown as (typeNumber: number, level: "L" | "M" | "Q" | "H") => QrCode;

/** Matriz del QR (true = módulo oscuro), corrección L y el tamaño mínimo que quepa. */
export function qrMatrix(text: string): boolean[][] {
  const q = qrcode(0, "L");
  q.addData(text, "Byte");
  q.make();
  const n = q.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => Boolean(q.isDark(r, c))));
}

/**
 * QR en caracteres de bloque, dos módulos por línea y margen de 2. Se dibujan los módulos CLAROS (como
 * `qrencode -t UTF8`): en un terminal de fondo oscuro sale con la polaridad correcta.
 */
export function qrText(text: string): string {
  const m = qrMatrix(text);
  const n = m.length;
  const Q = 2;
  const light = (x: number, y: number): boolean => x < 0 || y < 0 || x >= n || y >= n || !m[y]![x];
  const lines: string[] = [];
  for (let y = -Q; y < n + Q; y += 2) {
    let line = "";
    for (let x = -Q; x < n + Q; x++) {
      const top = light(x, y);
      const bottom = light(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
