// El slice activo del arnés de Trycore (trycore-spec-build-harness) como tarea de Nod (docs/nod-v1.md §5).
// El arnés es la fuente de verdad de en qué se trabaja: Nod solo lo lee y etiqueta la sesión con la épica.
// Se lee del árbol de la sesión y no del clon principal: en un frente paralelo cada worktree tiene su slice.

/** Ficheros de estado del arnés, por orden: la proyección del hub (modo runtime/dual) y el estado local (legacy). */
export const TRYCORE_STATE = [".claude/state/runtime-projection.json", ".claude/state/build-state.json"] as const;

export interface Slice {
  /** La épica del slice (`EP-003`, `EP-003-a`). */
  task: string;
  /** Título de la épica y sus historias, si el estado los trae. */
  title?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/**
 * El slice activo de un fichero de estado del arnés. `null` si el fichero no tiene slice activo (el arnés dice
 * que no se trabaja en ninguno), `undefined` si no es un estado del arnés.
 */
export function sliceFrom(text: string): Slice | null | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (doc === null || typeof doc !== "object" || !("active_slice" in doc)) return undefined;
  const s = (doc as { active_slice: unknown }).active_slice;
  if (s === null || typeof s !== "object") return null;
  const sl = s as Record<string, unknown>;
  // La proyección del hub usa `epic_code`/`epic_title`; build-state.json, `epica`.
  const task = str(sl.epic_code) ?? str(sl.epica);
  if (task === undefined) return null;
  const hus = (Array.isArray(sl.hus) ? sl.hus : [])
    .map((h) => str(h) ?? (h !== null && typeof h === "object" ? str((h as Record<string, unknown>).code) ?? str((h as Record<string, unknown>).id) : undefined))
    .filter((h): h is string => h !== undefined);
  const title = [str(sl.epic_title), hus.length > 0 ? hus.join(", ") : undefined].filter((t) => t !== undefined).join(" · ");
  return title === "" ? { task } : { task, title };
}

/** El slice activo del proyecto en `root`: manda el primer fichero de estado que exista y se entienda. */
export async function trycoreSlice(read: (path: string) => Promise<string>, root: string): Promise<Slice | undefined> {
  for (const rel of TRYCORE_STATE) {
    const text = await read(`${root.replace(/\/+$/, "")}/${rel}`).catch(() => undefined);
    if (text === undefined) continue;
    const slice = sliceFrom(text);
    if (slice !== undefined) return slice ?? undefined;
  }
  return undefined;
}
