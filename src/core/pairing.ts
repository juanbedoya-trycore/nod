// Emparejamiento del reloj (SPEC §6.3, protocol/docs/pairing.md). Lógica pura: sin `$`, sin Node, sin DOM.
//
// Modelo de confianza: el servidor y el teléfono NO son de confianza. El servidor solo guarda ofertas
// (SPKI publicadas por el reloj a través del teléfono). El mod recalcula el `kid` de cada SPKI, enseña la
// huella con `/orbit pair` y solo guarda una llave cuando el usuario la confirma con
// `/orbit pair confirm <huella>` tras compararla con la que muestra el reloj. Las llaves emparejadas
// viven en `$.store` (nunca en el servidor) y se revocan con `/orbit unpair <huella>`.
import { kidOf, spkiPoint } from "./perm/verify.js";
import type { PairedKey } from "./perm/verify.js";

/** Palabras de la huella: una por byte del kid. La misma lista que `Fingerprint.kt` y `protocol/vectors/sig/fingerprint.json`. */
export const WORDS: readonly string[] = [
  "abeja", "abeto", "abrigo", "aceite", "acero", "agua", "aguila", "ajo", "ala", "alamo", "alce", "alga", "almeja", "alto", "ancla", "angel",
  "anillo", "anis", "apio", "arbol", "arco", "arena", "arpa", "arroz", "asno", "atun", "aula", "ave", "avena", "azul", "bahia", "balsa",
  "banco", "barco", "barro", "bata", "baul", "bello", "beso", "bici", "boca", "bola", "bolsa", "bosque", "bota", "brisa", "brujo", "buho",
  "burro", "cabra", "cacao", "cactus", "cafe", "caja", "caldo", "calle", "cama", "campo", "canoa", "capa", "carne", "carta", "casa", "cebra",
  "cedro", "cena", "cerdo", "cesta", "cielo", "cine", "cisne", "clavo", "cobre", "coco", "cofre", "coral", "corcho", "cuervo", "cuna", "danza",
  "dardo", "dedo", "delfin", "diente", "disco", "dolar", "dragon", "duna", "eco", "eje", "elfo", "enano", "erizo", "espiga", "faro", "fiesta",
  "flan", "flor", "fresa", "fruta", "fuego", "fuente", "gafas", "gallo", "ganso", "gato", "globo", "gnomo", "gorila", "gorra", "grano", "grillo",
  "grulla", "guante", "haba", "hacha", "hada", "hielo", "hierba", "higo", "hoja", "hongo", "horno", "hueso", "huevo", "iglu", "iman", "isla",
  "jabon", "jade", "jarra", "jaula", "jirafa", "joya", "judia", "jugo", "kayak", "kiwi", "koala", "lago", "lana", "lapiz", "laurel", "leche",
  "lemur", "leon", "libro", "limon", "lince", "lirio", "llama", "llave", "lobo", "loro", "luna", "madera", "maiz", "malva", "mango", "mano",
  "manta", "mapa", "mar", "marco", "mesa", "miel", "mina", "mirlo", "monte", "muro", "nariz", "nave", "nido", "niebla", "nieve", "noche",
  "nogal", "nube", "nuez", "oasis", "ola", "olivo", "olmo", "onda", "orca", "oreja", "oro", "oso", "ostra", "oveja", "pala", "palma",
  "pan", "panda", "pato", "perla", "pez", "piano", "piedra", "pino", "plata", "playa", "pluma", "polen", "pollo", "pomelo", "pozo", "puente",
  "pulpo", "puma", "queso", "quinoa", "rana", "raton", "rayo", "remo", "reno", "roble", "roca", "rosa", "rubi", "rueda", "salmon", "salvia",
  "selva", "silla", "sol", "sopa", "taza", "tejon", "tigre", "tinta", "tomate", "toro", "torre", "tren", "trigo", "trucha", "urraca", "uva",
  "vaca", "valle", "vela", "velero", "verde", "vino", "violin", "volcan", "yate", "yegua", "yeso", "yoyo", "zafiro", "zanja", "zorro", "zumo",
];

/** Máximo de llaves emparejadas por instancia (varios relojes o una llave nueva tras reinstalar). */
export const MAX_PAIRED_KEYS = 8;

/** Clave de `$.store` con las llaves emparejadas de una instancia. */
export const PAIR_STORE_KEY = (instanceId: string): string => `orbit.pair.keys.${instanceId}`;

// ---------------------------------------------------------------- huella

export interface Fingerprint {
  /** 16 cifras hex en 4 grupos: `058f 0152 8618 14b2`. */
  hex: string;
  /** Una palabra por byte del kid. */
  words: string[];
}

export function hexOf(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fingerprint(kid: Uint8Array): Fingerprint {
  if (kid.length !== 8) throw new Error(`kid de ${kid.length} bytes (se esperaban 8)`);
  const h = hexOf(kid);
  return { hex: (h.match(/.{4}/g) ?? []).join(" "), words: Array.from(kid, (b) => WORDS[b]!) };
}

/**
 * Lee una huella escrita por el usuario: 16 cifras hex con espacios, guiones o dos puntos opcionales,
 * o las 8 palabras. Devuelve el kid o `undefined`.
 */
export function parseKidInput(input: string): Uint8Array | undefined {
  const s = input.trim().toLowerCase();
  const compact = s.replace(/[\s:-]/g, "");
  if (/^[0-9a-f]{16}$/.test(compact)) {
    const out = new Uint8Array(8);
    for (let i = 0; i < 8; i++) out[i] = parseInt(compact.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  const words = s.split(/[\s,-]+/).filter((w) => w !== "");
  if (words.length === 8) {
    const out = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      const idx = WORDS.indexOf(words[i]!);
      if (idx < 0) return undefined;
      out[i] = idx;
    }
    return out;
  }
  return undefined;
}

// ---------------------------------------------------------------- base64url

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function b64uEncode(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    const chars = [B64[(n >> 18) & 63], B64[(n >> 12) & 63], B64[(n >> 6) & 63], B64[n & 63]];
    out += chars.slice(0, b.length - i >= 3 ? 4 : b.length - i + 1).join("");
  }
  return out;
}

export function b64uDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error("base64url inválido");
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const c of s) {
    acc = (acc << 6) | B64.indexOf(c);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) throw new Error("base64url no canónico");
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------- llaves emparejadas ($.store)

/** Forma persistida de una llave emparejada (pairing.schema.json#/$defs/storedKey). */
export interface StoredKey {
  kid: string;
  spki: string;
  label: string;
  paired_at: number;
}

export interface StoredKeys {
  v: 1;
  keys: StoredKey[];
}

/**
 * Lee lo guardado en `$.store`. Cada entrada se re-valida (SPKI P-256 bien formado y kid = SHA-256 del
 * SPKI): una entrada corrupta o manipulada se descarta y no cuenta como emparejada.
 */
export function readStoredKeys(raw: unknown): { stored: StoredKey[]; keys: PairedKey[]; invalid: number } {
  const stored: StoredKey[] = [];
  const keys: PairedKey[] = [];
  let invalid = 0;
  const list = raw !== null && typeof raw === "object" && (raw as { v?: unknown }).v === 1 ? (raw as { keys?: unknown }).keys : undefined;
  if (!Array.isArray(list)) return { stored, keys, invalid: raw === undefined || raw === null ? 0 : 1 };
  for (const e of list) {
    try {
      const o = e as StoredKey;
      if (typeof o.kid !== "string" || typeof o.spki !== "string") throw new Error("forma");
      const spki = b64uDecode(o.spki);
      spkiPoint(spki);
      const kid = kidOf(spki);
      if (hexOf(kid) !== o.kid) throw new Error("kid");
      if (keys.some((k) => hexOf(k.kid) === o.kid)) continue;
      stored.push({ kid: o.kid, spki: o.spki, label: sanitizeLabel(o.label), paired_at: Number(o.paired_at) || 0 });
      keys.push({ kid, spki });
    } catch {
      invalid++;
    }
  }
  return { stored, keys, invalid };
}

// ---------------------------------------------------------------- ofertas del servidor

/** Oferta tal como la ve el mod tras validarla (el kid lo calcula el mod, no el servidor). */
export interface Offer {
  kid: Uint8Array;
  spki: Uint8Array;
  label: string;
  createdMs: number;
  expiresMs: number;
  /** Etiqueta del emparejamiento por QR (SPEC §6.3.1), 32 bytes; la verifica `core/setup.ts`. */
  tag?: Uint8Array | undefined;
}

/**
 * Etiqueta que viene del servidor o del teléfono: texto no fiable que se imprime en el terminal. Se
 * quitan caracteres de control (incluidas secuencias ANSI) y se corta a 32 caracteres.
 */
export function sanitizeLabel(v: unknown): string {
  if (typeof v !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return Array.from(v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "")).slice(0, 32).join("");
}

/**
 * Valida la respuesta de `GET /v0/pair/offers` (pairing.schema.json#/$defs/pairOffers). Las ofertas con
 * un SPKI inválido o cuyo `kid` declarado no coincide con el calculado se descartan y se cuentan.
 */
export function parseOffers(text: string): { offers: Offer[]; dropped: number } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("respuesta del servidor que no es JSON");
  }
  const list = body !== null && typeof body === "object" ? (body as { offers?: unknown }).offers : undefined;
  if (!Array.isArray(list)) throw new Error("respuesta del servidor sin 'offers'");
  const offers: Offer[] = [];
  let dropped = 0;
  for (const e of list) {
    try {
      const o = e as Record<string, unknown>;
      const spki = b64uDecode(String(o.spki));
      spkiPoint(spki);
      const kid = kidOf(spki);
      if (typeof o.kid !== "string" || o.kid !== b64uEncode(kid)) throw new Error("kid");
      if (offers.some((x) => hexOf(x.kid) === hexOf(kid))) continue;
      let tag: Uint8Array | undefined;
      if (typeof o.tag === "string") {
        try {
          const t = b64uDecode(o.tag);
          if (t.length === 32) tag = t;
        } catch {
          // etiqueta mal formada: la oferta queda como una sin etiqueta (flujo manual)
        }
      }
      offers.push({ kid, spki, label: sanitizeLabel(o.label), createdMs: Number(o.created_ms) || 0, expiresMs: Number(o.expires_ms) || 0, tag });
    } catch {
      dropped++;
    }
  }
  return { offers, dropped };
}

// ---------------------------------------------------------------- comando

export type PairAction =
  | { kind: "list" }
  | { kind: "confirm"; kid: Uint8Array }
  | { kind: "reject"; kid: Uint8Array }
  | { kind: "keys" }
  | { kind: "unpair"; kid: Uint8Array }
  | { kind: "invalid"; message: string };

export const PAIR_USAGE = [
  "uso:",
  "  /orbit setup                     QR para el teléfono: lo configura y empareja el reloj solo",
  "  /orbit pair                      ofertas pendientes del reloj, con su huella",
  "  /orbit pair confirm <huella>     empareja la llave cuya huella coincide con la del reloj",
  "  /orbit pair reject <huella>      descarta una oferta",
  "  /orbit pair keys                 llaves emparejadas",
  "  /orbit unpair <huella>           revoca una llave emparejada",
].join("\n");

/**
 * Reconoce `/orbit pair …` y `/orbit unpair …` (los argumentos de `/orbit`, sin el nombre). Devuelve
 * `undefined` si no es un comando de emparejamiento, para que el resto de `/orbit` lo trate.
 */
export function parsePairCommand(args: string): PairAction | undefined {
  const parts = args.trim().split(/\s+/);
  const head = (parts[0] ?? "").toLowerCase();
  if (head !== "pair" && head !== "unpair") return undefined;
  const kidArg = (from: number): Uint8Array | undefined => parseKidInput(parts.slice(from).join(" "));
  if (head === "unpair") {
    const kid = kidArg(1);
    return kid === undefined ? { kind: "invalid", message: `huella inválida\n${PAIR_USAGE}` } : { kind: "unpair", kid };
  }
  const sub = (parts[1] ?? "").toLowerCase();
  if (sub === "" || sub === "list") return { kind: "list" };
  if (sub === "keys") return { kind: "keys" };
  if (sub === "confirm" || sub === "reject") {
    const kid = kidArg(2);
    if (kid === undefined) return { kind: "invalid", message: `huella inválida: escribe las 16 cifras hex (o las 8 palabras) que muestra el reloj\n${PAIR_USAGE}` };
    return { kind: sub, kid };
  }
  return { kind: "invalid", message: PAIR_USAGE };
}

export interface PairingIo {
  /** Milisegundos Unix. */
  now(): number | Promise<number>;
  fetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; ok: boolean; text: string }>;
  load(key: string): Promise<unknown>;
  save(key: string, value: unknown): Promise<void>;
}

export interface PairingConfig {
  url: string;
  token: string;
  instanceId: string;
}

function ago(now: number, at: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `hace ${s}s` : s < 3600 ? `hace ${Math.round(s / 60)}min` : `hace ${Math.round(s / 3600)}h`;
}

/** Hora local `HH:MM:SS` de un instante en ms (UTC con sufijo si el sandbox no da la hora local). */
export function clockTime(ms: number): string {
  const two = (n: number): string => String(n).padStart(2, "0");
  try {
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  } catch {
    // sin Date: se calcula en UTC
  }
  const s = Math.floor(ms / 1000) % 86400;
  return `${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)} UTC`;
}

function describe(kid: Uint8Array): string {
  const f = fingerprint(kid);
  return `${f.hex}  (${f.words.join(" ")})`;
}

export async function fetchOffers(cfg: PairingConfig, io: PairingIo): Promise<{ offers: Offer[]; dropped: number }> {
  const r = await io.fetch(`${cfg.url}/v0/pair/offers`, { method: "GET", headers: { authorization: `Bearer ${cfg.token}` } });
  if (r.status === 401) throw new Error("el servidor rechazó el token (401)");
  if (!r.ok) throw new Error(`el servidor respondió ${r.status}`);
  return parseOffers(r.text);
}

export async function deleteOffer(cfg: PairingConfig, io: PairingIo, kid: Uint8Array): Promise<boolean> {
  try {
    const r = await io.fetch(`${cfg.url}/v0/pair/offers/${b64uEncode(kid)}`, { method: "DELETE", headers: { authorization: `Bearer ${cfg.token}` } });
    return r.ok || r.status === 404;
  } catch {
    return false;
  }
}

/** Llaves emparejadas de la instancia, ya validadas (lo que necesita `verifyDecision`). */
export async function loadPairedKeys(instanceId: string, io: Pick<PairingIo, "load">): Promise<PairedKey[]> {
  return readStoredKeys(await io.load(PAIR_STORE_KEY(instanceId))).keys;
}

/**
 * Ejecuta un comando de emparejamiento y devuelve el texto para el terminal. `cfg` puede faltar (mod
 * sin configurar): entonces solo funcionan `keys` y `unpair`, que no hablan con el servidor.
 */
export async function runPairCommand(cfg: PairingConfig | undefined, io: PairingIo, action: PairAction, instanceId?: string): Promise<string> {
  if (action.kind === "invalid") return action.message;
  const inst = cfg?.instanceId ?? instanceId;
  if (inst === undefined) return "orbit sin configurar: no hay instancia (ORBIT_INSTANCE_ID)";
  const storeKey = PAIR_STORE_KEY(inst);
  const current = readStoredKeys(await io.load(storeKey));
  const now = Number(await io.now());
  const save = (stored: StoredKey[]): Promise<void> => io.save(storeKey, stored.length === 0 ? null : ({ v: 1, keys: stored } satisfies StoredKeys));

  if (action.kind === "keys") {
    if (current.stored.length === 0) return "no hay ninguna llave emparejada (el reloj no puede aprobar nada)";
    const lines = [`llaves emparejadas (${current.stored.length}):`];
    for (const k of current.stored) lines.push(`  ${describe(hexToBytes(k.kid))}  ${k.label || "(sin nombre)"}  emparejada ${ago(now, k.paired_at)}`);
    if (current.invalid > 0) lines.push(`  (${current.invalid} entradas inválidas ignoradas)`);
    return lines.join("\n");
  }

  if (action.kind === "unpair") {
    const hex = hexOf(action.kid);
    const rest = current.stored.filter((k) => k.kid !== hex);
    if (rest.length === current.stored.length) return `no hay ninguna llave emparejada con la huella ${fingerprint(action.kid).hex}`;
    await save(rest);
    return `llave revocada: ${describe(action.kid)}. Sus decisiones se rechazan desde ya.`;
  }

  if (cfg === undefined) return "orbit sin configurar: hace falta ORBIT_URL y ORBIT_TOKEN para ver las ofertas del reloj";

  if (action.kind === "list") {
    const { offers, dropped } = await fetchOffers(cfg, io);
    const lines: string[] = [];
    if (offers.length === 0) lines.push("no hay ofertas de emparejamiento pendientes. Lo más fácil: /orbit setup y escanear el QR con el teléfono (o, en el reloj, Orbit > Emparejar).");
    else {
      lines.push(`ofertas pendientes (${offers.length}). Compara la huella con la que muestra el reloj:`);
      for (const o of offers) {
        const paired = current.stored.some((k) => k.kid === hexOf(o.kid)) ? "  [ya emparejada]" : "";
        lines.push(`  ${describe(o.kid)}  ${o.label || "(sin nombre)"}  publicada a las ${clockTime(o.createdMs)} (${ago(now, o.createdMs)})${paired}`);
      }
      // POST /v0/pair/offer no lleva autenticación (SPEC §6.3): quien llegue al servidor puede publicar ofertas.
      if (offers.length > 1) {
        lines.push(
          `AVISO: hay ${offers.length} ofertas pendientes. Si solo has pedido emparejar un reloj, alguna no es tuya: confirma únicamente la que coincide con la huella y la hora que ves en el reloj.`,
        );
      }
      lines.push("Si coincide ENTERA: /orbit pair confirm <huella>. Si no coincide, no la confirmes: /orbit pair reject <huella>.");
    }
    if (dropped > 0) lines.push(`(${dropped} ofertas descartadas: SPKI inválido o kid que no corresponde a su llave)`);
    lines.push(`llaves emparejadas: ${current.stored.length} (/orbit pair keys)`);
    return lines.join("\n");
  }

  const hex = hexOf(action.kid);
  if (action.kind === "reject") {
    const ok = await deleteOffer(cfg, io, action.kid);
    return ok ? `oferta descartada: ${fingerprint(action.kid).hex}` : "no se pudo descartar la oferta en el servidor";
  }

  // confirm: se vuelve a pedir la lista al servidor y se busca la oferta por kid (recalculado aquí).
  if (current.stored.some((k) => k.kid === hex)) return `esa llave ya está emparejada: ${describe(action.kid)}`;
  const { offers } = await fetchOffers(cfg, io);
  const offer = offers.find((o) => hexOf(o.kid) === hex);
  if (offer === undefined) return `no hay ninguna oferta pendiente con la huella ${fingerprint(action.kid).hex}. Lista: /orbit pair`;
  if (current.stored.length >= MAX_PAIRED_KEYS) return `ya hay ${MAX_PAIRED_KEYS} llaves emparejadas: revoca alguna con /orbit unpair <huella>`;
  await save([...current.stored, { kid: hex, spki: b64uEncode(offer.spki), label: offer.label, paired_at: now }]);
  const removed = await deleteOffer(cfg, io, offer.kid);
  return [
    `llave emparejada: ${describe(offer.kid)}  ${offer.label || "(sin nombre)"}`,
    "desde ahora el reloj puede aprobar y denegar permisos de esta instancia.",
    removed ? "" : "(no se pudo borrar la oferta del servidor; caducará sola)",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------------------------------------------------------------- llaves compartidas entre perfiles

/**
 * Fichero del directorio de estado de Orbit (0700) con las llaves emparejadas de cada instancia. Lo
 * comparten todos los perfiles de Claude Code del Mac (cada uno tiene su propio `$.store`), así que un
 * reloj emparejado desde una sesión vale para todas.
 */
export const SHARED_KEYS_FILE = "paired-keys.json";

export interface SharedKeys {
  v: 1;
  instances: Record<string, StoredKey[]>;
}

/** Lee el fichero compartido; algo ilegible cuenta como vacío (las entradas se re-validan al usarlas). */
export function readSharedKeys(text: string | undefined): SharedKeys {
  const out: SharedKeys = { v: 1, instances: {} };
  if (text === undefined) return out;
  try {
    const raw = JSON.parse(text) as { v?: unknown; instances?: unknown };
    if (raw.v !== 1 || raw.instances === null || typeof raw.instances !== "object") return out;
    for (const [inst, list] of Object.entries(raw.instances as Record<string, unknown>)) {
      const { stored } = readStoredKeys({ v: 1, keys: list });
      if (stored.length > 0) out.instances[inst] = stored;
    }
  } catch {
    // corrupto: vacío
  }
  return out;
}

/**
 * Une las llaves del fichero compartido con las que un perfil tenía en su `$.store` (migración): sin
 * duplicados por kid y como mucho `MAX_PAIRED_KEYS`, las más recientes.
 */
export function mergeStoredKeys(a: StoredKey[], b: StoredKey[]): StoredKey[] {
  const byKid = new Map<string, StoredKey>();
  for (const k of [...a, ...b]) if (!byKid.has(k.kid)) byKid.set(k.kid, k);
  return [...byKid.values()].sort((x, y) => y.paired_at - x.paired_at).slice(0, MAX_PAIRED_KEYS);
}

/** Texto del fichero compartido tras poner (o quitar, con `null`) las llaves de una instancia. */
export function writeSharedKeys(current: SharedKeys, instanceId: string, value: StoredKeys | null): string {
  const next: SharedKeys = { v: 1, instances: { ...current.instances } };
  const keys = value === null ? [] : readStoredKeys(value).stored;
  if (keys.length === 0) delete next.instances[instanceId];
  else next.instances[instanceId] = keys;
  return JSON.stringify(next, null, 2) + "\n";
}
