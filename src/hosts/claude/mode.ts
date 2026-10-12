// Modo de permisos de la sesión (auto, default, plan…), para no retener en auto mode (docs/control-v1.md §4.1).
//
// La fuente buena es `permission_mode` del hook clásico `UserPromptSubmit`. Pero con el mod instalado como
// plugin de usuario, la política integrada de Claude Code (`cc-plugin-sec-default`) puede saltarse los hooks
// `classic.*` de los mods, y `tool.check` trae lo mismo en default que en auto. El respaldo es la transcripción:
// cada mensaje del usuario lleva `"permissionMode":"…"` y cada cambio de modo en el terminal añade
// `{"type":"permission-mode","permissionMode":"…"}`. La última aparición es el modo actual.

/** Carpeta de la sesión dentro de `<config>/projects/`: la ruta real con todo lo que no es letra o cifra en `-`. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function transcriptPath(configDir: string, cwd: string, session: string): string {
  return `${configDir.replace(/\/+$/, "")}/projects/${projectSlug(cwd)}/${session}.jsonl`;
}

/** grep que saca cada `"permissionMode":"…"` de la transcripción (sin leerla entera en el mod). */
export function modeGrepArgs(path: string): string[] {
  return ["/usr/bin/grep", "-o", '"permissionMode":"[A-Za-z]*"', path];
}

/** El último modo en la salida de grep, o undefined si no hay ninguno. */
export function lastMode(stdout: unknown): string | undefined {
  if (typeof stdout !== "string") return undefined;
  const all = [...stdout.matchAll(/"permissionMode":"([A-Za-z]+)"/g)];
  return all.length === 0 ? undefined : all[all.length - 1]![1];
}

/** Cuánto vale una lectura de la transcripción: un turno puede pedir varios permisos seguidos. */
export const MODE_CACHE_MS = 2_000;
