// Llaves emparejadas (docs/control-v1.md §2): son de la máquina, no del perfil, y viven en
// `$XDG_STATE_HOME/nod/approvers.json` (`{"v":1,"keys":[{"kid","spki","added_ms","name"?}]}`, binarios en
// base64url). Todos los perfiles de Claude de la máquina las comparten: emparejar el móvil una vez basta.
//
// Las llaves de prueba de vectors/control/key.json tienen el escalar privado publicado: nunca cuentan, aunque
// alguien las meta a mano en el fichero.
import { KID_LEN, b64u, fromB64u, fromHex, hex, kidOf, sameBytes, spkiPoint } from "./crypto.js";
import type { PairedKey } from "./verify.js";

/** `kid` (hex) de las llaves de prueba de vectors/control/key.json. */
export const TEST_KIDS: readonly string[] = ["b4aa8c3df3915b83", "aa4a84512345fdd0"];

/** Tope de llaves: un fichero inflado no puede convertir cada verificación en miles de comprobaciones. */
export const MAX_APPROVERS = 16;
export const NAME_MAX = 64;

export interface ApproverEntry {
  /** base64url de los 8 bytes. */
  kid: string;
  /** base64url del SPKI DER. */
  spki: string;
  added_ms: number;
  name?: string;
}

export interface ApproversFile {
  v: 1;
  keys: ApproverEntry[];
}

export function isTestKid(kid: Uint8Array): boolean {
  return TEST_KIDS.includes(hex(kid));
}

export interface ParsedApprovers {
  entries: ApproverEntry[];
  keys: PairedKey[];
  /** Entradas ignoradas (mal formadas, kid que no es el de su SPKI, llaves de prueba), para /nod. */
  ignored: string[];
}

/** Lee approvers.json. Un fichero ausente o ilegible es "sin llaves": nunca se retiene sin saber con qué verificar. */
export function parseApprovers(text: string | undefined): ParsedApprovers {
  const out: ParsedApprovers = { entries: [], keys: [], ignored: [] };
  if (text === undefined || text.trim() === "") return out;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    out.ignored.push("approvers.json no es JSON");
    return out;
  }
  const list = v !== null && typeof v === "object" && (v as { v?: unknown }).v === 1 ? (v as { keys?: unknown }).keys : undefined;
  if (!Array.isArray(list)) {
    out.ignored.push("approvers.json no tiene el formato {\"v\":1,\"keys\":[…]}");
    return out;
  }
  for (const item of list) {
    const e = item as Partial<ApproverEntry> | null;
    if (typeof e?.kid !== "string" || typeof e.spki !== "string") {
      out.ignored.push("entrada sin kid o spki");
      continue;
    }
    let spki: Uint8Array;
    let kid: Uint8Array;
    try {
      spki = fromB64u(e.spki);
      spkiPoint(spki);
      kid = fromB64u(e.kid);
    } catch (err) {
      out.ignored.push(`${e.kid}: ${String(err)}`);
      continue;
    }
    if (kid.length !== KID_LEN || !sameBytes(kid, kidOf(spki))) {
      out.ignored.push(`${e.kid}: el kid no es el de su llave`);
      continue;
    }
    if (isTestKid(kid)) {
      out.ignored.push(`${e.kid}: llave de prueba (su clave privada es pública)`);
      continue;
    }
    if (out.keys.some((k) => sameBytes(k.kid, kid)) || out.keys.length >= MAX_APPROVERS) continue;
    const entry: ApproverEntry = { kid: e.kid, spki: e.spki, added_ms: typeof e.added_ms === "number" ? e.added_ms : 0 };
    if (typeof e.name === "string" && e.name !== "") entry.name = e.name.slice(0, NAME_MAX);
    out.entries.push(entry);
    out.keys.push({ kid, spki, name: entry.name });
  }
  return out;
}

/** Añade una llave (ya validada). Si ya estaba, solo se actualiza el nombre. Devuelve el fichero nuevo o un error. */
export function addApprover(entries: readonly ApproverEntry[], spki: Uint8Array, name: string | undefined, now: number): { file: ApproversFile; entry: ApproverEntry } | { error: string } {
  try {
    spkiPoint(spki);
  } catch (err) {
    return { error: String(err) };
  }
  const kid = kidOf(spki);
  if (isTestKid(kid)) return { error: "llave de prueba: su clave privada es pública" };
  const entry: ApproverEntry = { kid: b64u(kid), spki: b64u(spki), added_ms: now };
  const clean = cleanName(name);
  if (clean !== undefined) entry.name = clean;
  const rest = entries.filter((e) => e.kid !== entry.kid);
  if (rest.length >= MAX_APPROVERS) return { error: `ya hay ${MAX_APPROVERS} llaves emparejadas: quita alguna con /nod aprobadores quitar <kid>` };
  return { file: { v: 1, keys: [...rest, entry] }, entry };
}

/** Quita la llave `kid` (base64url o hex, como se vea en /nod aprobadores). */
export function removeApprover(entries: readonly ApproverEntry[], kid: string): { file: ApproversFile; removed: ApproverEntry } | undefined {
  const want = normalizeKid(kid);
  if (want === undefined) return undefined;
  const removed = entries.find((e) => e.kid === want);
  if (removed === undefined) return undefined;
  return { file: { v: 1, keys: entries.filter((e) => e !== removed) }, removed };
}

function normalizeKid(kid: string): string | undefined {
  const s = kid.trim();
  try {
    if (/^[0-9a-f]{16}$/i.test(s)) return b64u(fromHex(s.toLowerCase()));
    const b = fromB64u(s);
    return b.length === KID_LEN ? s : undefined;
  } catch {
    return undefined;
  }
}

/** El nombre que propone el aprobador es texto ajeno: una línea, sin caracteres de control, corto. */
export function cleanName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const s = name.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  return s === "" ? undefined : s;
}
