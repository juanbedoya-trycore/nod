// La cuenta del agente que emite (docs/nod-v1.md §2): con suscripción, la cuenta de la empresa de quien usa el
// perfil. Es lo que permite saber quién trabajó en cada sesión cuando varias personas envían al mismo destino.
import type { Privacy } from "./events.js";
import { shortHash } from "./privacy.js";

export interface Account {
  email: string;
  name?: string;
  org?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** La cuenta del `.claude.json` de un perfil de Claude Code (`oauthAccount`); `undefined` sin sesión iniciada. */
export function claudeAccount(text: string): Account | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  const a = doc !== null && typeof doc === "object" ? (doc as { oauthAccount?: unknown }).oauthAccount : undefined;
  if (a === null || typeof a !== "object") return undefined;
  const o = a as Record<string, unknown>;
  const email = str(o.emailAddress);
  if (email === undefined) return undefined;
  const out: Account = { email: email.toLowerCase() };
  const name = str(o.fullName) ?? str(o.displayName);
  if (name !== undefined) out.name = name;
  const org = str(o.organizationName);
  if (org !== undefined) out.org = org;
  return out;
}

/**
 * La cuenta según la privacidad: el nombre solo con `completo` (como `machine`); el correo y la organización son
 * identificadores, legibles con `completo` y `trabajo` y como hash con `redactado` (se puede agrupar, no leer).
 */
export function accountFor(a: Account, p: Privacy): Account {
  if (p === "redactado") {
    const out: Account = { email: `h-${shortHash(a.email)}` };
    if (a.org !== undefined) out.org = `h-${shortHash(a.org)}`;
    return out;
  }
  const out: Account = { email: a.email };
  if (p === "completo" && a.name !== undefined) out.name = a.name;
  if (a.org !== undefined) out.org = a.org;
  return out;
}
