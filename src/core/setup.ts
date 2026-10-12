// Configuración automática y emparejamiento por QR (SPEC §6.3.1, protocol/docs/pairing.md §2.2).
// Lógica pura: sin `$`, sin Node, sin DOM.
//
// - `client.json` (directorio de estado del servidor) da la URL, el token, la instancia y el ctx al mod
//   cuando no hay variables ORBIT_*.
// - `/nod setup` genera K (32 bytes aleatorios, un solo uso, 15 min), lo guarda en `$.store` y dibuja el QR
//   `orbit://setup?v=1&u&i&t&k`. El teléfono lo escanea, pide la llave al reloj y publica la oferta con
//   `tag = HMAC-SHA256(K, CBOR determinista de ["orbit-pair", 1, instance_id, spki])`.
// - El mod empareja SIN pedir la huella una oferta cuyo `tag` verifica con un K vigente y no usado, y
//   consume el K. Las ofertas sin `tag` (o con uno que no verifica) siguen el flujo manual de `/nod pair`.
//
// Por qué es seguro: K solo viaja del Mac a la cámara del teléfono (nunca hacia el servidor), así que ni el
// servidor ni quien publique ofertas sin autenticar puede fabricar un `tag` válido para SU llave: lo único
// que el `tag` dice es "esta SPKI la publicó quien leyó el QR que el usuario acaba de enseñar en el Mac".
import * as noble from "../vendor/noble-p256.js";
import * as qr from "../vendor/qrcode.js";
import { encode } from "../protocol/cbor.js";
import { MAX_PAIRED_KEYS, PAIR_STORE_KEY, b64uDecode, b64uEncode, fetchOffers, deleteOffer, fingerprint, hexOf, readStoredKeys } from "./pairing.js";
import type { PairingConfig, PairingIo, StoredKey } from "./pairing.js";
import type { RawConfig } from "./config.js";

const sha256 = noble.sha256 as unknown as (msg: Uint8Array) => Uint8Array;
interface QrCode {
  addData(data: string, mode: "Byte"): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}
const qrcode = qr.qrcode as unknown as (typeNumber: number, level: "L" | "M" | "Q" | "H") => QrCode;

export const SETUP_K_LEN = 32;
export const PAIR_TAG_LEN = 32;
/** Vida de un K (y del QR que lo lleva). */
export const SETUP_TTL_MS = 15 * 60_000;
/** Cuánto espera `/nod setup` a que llegue la oferta del teléfono. */
export const SETUP_WAIT_MS = 120_000;
export const MAX_SETUP_KEYS = 8;
/** Clave de `$.store` con los K vigentes de una instancia (pairing.schema.json#/$defs/setupKeys). */
export const SETUP_STORE_KEY = (instanceId: string): string => `orbit.setup.keys.${instanceId}`;

// ---------------------------------------------------------------- HMAC-SHA256 y etiqueta

export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const B = 64;
  let k = key.length > B ? sha256(key) : key;
  const pad = new Uint8Array(B);
  pad.set(k);
  k = pad;
  const ipad = new Uint8Array(B + msg.length);
  const opad = new Uint8Array(B + 32);
  for (let i = 0; i < B; i++) {
    ipad[i] = k[i]! ^ 0x36;
    opad[i] = k[i]! ^ 0x5c;
  }
  ipad.set(msg, B);
  opad.set(sha256(ipad), B);
  return sha256(opad);
}

/** CBOR determinista de `["orbit-pair", 1, instance_id, spki]`. */
export function pairTagInput(instanceId: string, spki: Uint8Array): Uint8Array {
  return encode(["orbit-pair", 1, instanceId, spki]);
}

export function pairTag(k: Uint8Array, instanceId: string, spki: Uint8Array): Uint8Array {
  if (k.length !== SETUP_K_LEN) throw new Error(`K de ${k.length} bytes (se esperaban ${SETUP_K_LEN})`);
  return hmacSha256(k, pairTagInput(instanceId, spki));
}

/** Comparación en tiempo constante (sin cortar al primer byte distinto). */
export function verifyPairTag(k: Uint8Array, instanceId: string, spki: Uint8Array, tag: Uint8Array): boolean {
  if (k.length !== SETUP_K_LEN || tag.length !== PAIR_TAG_LEN) return false;
  const want = pairTag(k, instanceId, spki);
  let diff = 0;
  for (let i = 0; i < PAIR_TAG_LEN; i++) diff |= want[i]! ^ tag[i]!;
  return diff === 0;
}

// ---------------------------------------------------------------- K de un solo uso

export interface SetupKeyEntry {
  /** K en base64url (43 caracteres). */
  k: string;
  instance_id: string;
  expires_ms: number;
}

export interface SetupKeys {
  v: 1;
  keys: SetupKeyEntry[];
}

/** Lee `setupKeys` (de `$.store` o de `setup.json`); descarta entradas mal formadas. */
export function readSetupKeys(raw: unknown): SetupKeyEntry[] {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  const list = v !== null && typeof v === "object" && (v as { v?: unknown }).v === 1 ? (v as { keys?: unknown }).keys : undefined;
  if (!Array.isArray(list)) return [];
  const out: SetupKeyEntry[] = [];
  for (const e of list) {
    const o = e as Partial<SetupKeyEntry>;
    if (typeof o.k !== "string" || typeof o.instance_id !== "string" || typeof o.expires_ms !== "number") continue;
    try {
      if (b64uDecode(o.k).length !== SETUP_K_LEN) continue;
    } catch {
      continue;
    }
    out.push({ k: o.k, instance_id: o.instance_id, expires_ms: o.expires_ms });
  }
  return out;
}

/** Añade un K nuevo y quita los caducados (como mucho [MAX_SETUP_KEYS]). */
export function addSetupKey(keys: SetupKeyEntry[], k: Uint8Array, instanceId: string, now: number): SetupKeys {
  const live = keys.filter((x) => x.expires_ms >= now);
  live.push({ k: b64uEncode(k), instance_id: instanceId, expires_ms: now + SETUP_TTL_MS });
  return { v: 1, keys: live.slice(-MAX_SETUP_KEYS) };
}

/** K vigentes de la instancia. */
export function liveSetupKeys(keys: SetupKeyEntry[], instanceId: string, now: number): SetupKeyEntry[] {
  return keys.filter((x) => x.instance_id === instanceId && x.expires_ms >= now);
}

/**
 * Dónde están los K: `$.store` (los de `/nod setup`) y `setup.json` del directorio de estado (los de
 * `orbit-server setup` y la página /setup). `consume` borra un K de su origen: un solo uso.
 */
export interface SetupKeyring {
  list(): Promise<SetupKeyEntry[]>;
  consume(k: string): Promise<void>;
}

// ---------------------------------------------------------------- enlace y QR

/** `orbit://setup?v=1&u=<url>&i=<instance>&t=<token>&k=<K base64url>` (lo que codifica el QR). */
export function setupLink(phoneUrl: string, instanceId: string, token: string, k: Uint8Array): string {
  const e = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `orbit://setup?v=1&u=${e(phoneUrl)}&i=${e(instanceId)}&t=${e(token)}&k=${b64uEncode(k)}`;
}

/** Matriz del QR (true = módulo oscuro), corrección L. */
export function qrMatrix(text: string): boolean[][] {
  const q = qrcode(0, "L");
  q.addData(text, "Byte");
  q.make();
  const n = q.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => Boolean(q.isDark(r, c))));
}

/**
 * QR en caracteres de bloque, dos módulos por línea. Los módulos CLAROS se dibujan con bloque (como
 * `qrencode -t UTF8` y `orbit-server setup`): en un terminal de fondo oscuro sale con la polaridad correcta.
 * Margen de 2 módulos.
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

// ---------------------------------------------------------------- client.json

export interface ClientConfigFile {
  raw: RawConfig;
  phoneUrl: string | undefined;
}

/** `client.json` (pairing.schema.json#/$defs/clientConfig) → configuración del mod. */
export function parseClientConfig(text: string): ClientConfigFile | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (v === null || typeof v !== "object" || (v as { v?: unknown }).v !== 1) return undefined;
  const o = v as Record<string, unknown>;
  const s = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);
  return { raw: { url: s(o.url), token: s(o.token), instanceId: s(o.instance_id), ctx: s(o.ctx) }, phoneUrl: s(o.phone_url) };
}

/**
 * Directorios donde buscar `client.json` y `setup.json`, en orden: ORBIT_STATE_DIR; macOS
 * (`~/Library/Application Support/Orbit`); Linux (`$XDG_CONFIG_HOME/orbit`, `~/.config/orbit`). El mismo
 * criterio que `server/src/setup.rs` (el mod no sabe en qué sistema corre: prueba en orden).
 */
export function stateDirCandidates(env: { stateDir?: string | undefined; home?: string | undefined; xdg?: string | undefined }): string[] {
  const out: string[] = [];
  const clean = (s: string | undefined): string | undefined => (s === undefined || s.trim() === "" ? undefined : s.replace(/\/+$/, ""));
  const explicit = clean(env.stateDir);
  if (explicit !== undefined) return [explicit];
  const home = clean(env.home);
  if (home !== undefined) out.push(`${home}/Library/Application Support/Orbit`);
  const xdg = clean(env.xdg);
  if (xdg !== undefined) out.push(`${xdg}/orbit`);
  if (home !== undefined) out.push(`${home}/.config/orbit`);
  return out;
}

/** Host de loopback (`127.x`, `localhost`, `::1`): el teléfono no puede usar esa URL. */
export function isLoopbackUrl(url: string): boolean {
  const m = /^https?:\/\/(\[[^\]]*\]|[^/:]+)/i.exec(url.trim());
  if (m === null) return true;
  const h = m[1]!.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\./.test(h) || h === "0.0.0.0";
}

/**
 * URL del servidor para el teléfono: ORBIT_PHONE_URL; si no, `phone_url` de `client.json` (la IP de
 * Tailscale o de la Wi-Fi que calculó el servidor); si no, ORBIT_URL cuando no es de loopback.
 */
export function resolvePhoneUrl(envPhone: string | undefined, clientPhone: string | undefined, url: string): string | undefined {
  for (const c of [envPhone, clientPhone]) {
    const v = (c ?? "").trim().replace(/\/+$/, "");
    if (/^https?:\/\/[^\s/]+$/.test(v) && !isLoopbackUrl(v)) return v;
  }
  return isLoopbackUrl(url) ? undefined : url;
}

// ---------------------------------------------------------------- emparejamiento automático

export interface AutoPairResult {
  /** Había algún K vigente (si no, ni se pregunta al servidor). */
  armed: boolean;
  paired: StoredKey[];
  /** Ofertas con `tag` que no verificó con ningún K (otro K, caducado, ya usado u otra SPKI). */
  rejected: number;
}

/**
 * Empareja las ofertas cuyo `tag` verifica con un K vigente de la instancia. Cada K sirve una vez: se
 * consume antes de guardar la llave. Sin K vigente no hace nada (ni pide las ofertas).
 */
export async function autoPair(cfg: PairingConfig, io: PairingIo, ring: SetupKeyring): Promise<AutoPairResult> {
  const now = Number(await io.now());
  const keys = liveSetupKeys(await ring.list(), cfg.instanceId, now);
  if (keys.length === 0) return { armed: false, paired: [], rejected: 0 };
  const { offers } = await fetchOffers(cfg, io);
  const storeKey = PAIR_STORE_KEY(cfg.instanceId);
  const paired: StoredKey[] = [];
  let rejected = 0;
  const used = new Set<string>();
  for (const offer of offers) {
    if (offer.tag === undefined) continue;
    const match = keys.find((k) => !used.has(k.k) && verifyPairTag(b64uDecode(k.k), cfg.instanceId, offer.spki, offer.tag!));
    if (match === undefined) {
      rejected++;
      continue;
    }
    used.add(match.k);
    await ring.consume(match.k);
    const current = readStoredKeys(await io.load(storeKey));
    const hex = hexOf(offer.kid);
    const entry: StoredKey = { kid: hex, spki: b64uEncode(offer.spki), label: offer.label, paired_at: now };
    if (!current.stored.some((k) => k.kid === hex)) {
      if (current.stored.length >= MAX_PAIRED_KEYS) {
        rejected++;
        continue;
      }
      await io.save(storeKey, { v: 1, keys: [...current.stored, entry] });
    }
    await deleteOffer(cfg, io, offer.kid);
    paired.push(entry);
  }
  return { armed: true, paired, rejected };
}

export function describePaired(k: StoredKey): string {
  const f = fingerprint(Uint8Array.from(k.kid.match(/../g)!.map((h) => parseInt(h, 16))));
  return `${k.label || "reloj"} (huella ${f.hex})`;
}
