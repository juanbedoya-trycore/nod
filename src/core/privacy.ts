// Perfiles de privacidad (docs/nod-v1.md §4). Se aplican antes de encolar: lo que no debe salir nunca toca la
// cola ni el disco.
import type { Draft, Privacy } from "./events.js";

/** Campos de `data` que llevan texto libre o rutas: fuera en `redactado` y `trabajo`. */
const TEXT_FIELDS = ["text", "answer", "input", "description", "cwd", "title"] as const;
/** `reason` es texto libre (con rutas) solo en el permiso; en session.end es un valor fijo (`exit`, `clear`…). */
const FREE_REASON = new Set(["permission.request"]);

export function redacts(p: Privacy): boolean {
  return p !== "completo";
}

/** Devuelve el evento tal como puede salir con este perfil (una copia si hay que quitar algo). */
export function applyPrivacy(d: Draft, p: Privacy): Draft {
  if (!redacts(p)) return d;
  const data: Record<string, unknown> = { ...d.data };
  for (const k of TEXT_FIELDS) delete data[k];
  if (FREE_REASON.has(d.type)) delete data.reason;
  const repo = data.repo as Record<string, unknown> | undefined;
  if (repo !== undefined) {
    // Queda el nombre del repo; la ruta local y la URL del remoto pueden identificar al cliente.
    const { root: _r, remote: _m, ...rest } = repo;
    if (Object.keys(rest).length > 0) data.repo = rest;
    else delete data.repo;
  }
  return { ...d, data };
}

/** ¿Puede este destino recibir eventos con este perfil? `trabajo` solo deja destinos locales. */
export function sinkAllowed(p: Privacy, sink: { kind: "file" | "http"; target: string }): boolean {
  if (p !== "trabajo" || sink.kind === "file") return true;
  try {
    const host = new URL(sink.target).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}
