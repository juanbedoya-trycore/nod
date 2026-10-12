// Modo de permisos de la sesión (SPEC §6.1): el mod no lo recibe por ninguna API (tool.check trae lo mismo en
// default que en auto y los hooks classic.* están cerrados a los mods de usuario), pero Claude Code lo escribe
// en la transcripción: cada mensaje del usuario lleva `"permissionMode":"…"` y cada cambio de modo en el terminal
// añade `{"type":"permission-mode","permissionMode":"…"}`. La última aparición es el modo actual.
//
// En auto mode, lo que las reglas marcan `ask` lo aprueba después el clasificador: el mod no lo retiene ni avisa
// al reloj (si no, cada comando espera 20 s y el reloj se llena de avisos que no piden nada).

/** Carpeta de la sesión dentro de `<config>/projects/`: la ruta real con todo lo que no es letra o número en `-`. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Ruta de la transcripción de una sesión. */
export function transcriptPath(configDir: string, cwd: string, sessionId: string): string {
  return `${configDir.replace(/\/+$/, "")}/projects/${projectSlug(cwd)}/${sessionId}.jsonl`;
}

/** Argumentos de grep que sacan cada `"permissionMode":"…"` de la transcripción. */
export function modeGrepArgs(path: string): string[] {
  return ["/usr/bin/grep", "-o", '"permissionMode":"[A-Za-z]*"', path];
}

/** El último modo en la salida de grep, o undefined si no hay ninguno. */
export function lastMode(stdout: unknown): string | undefined {
  if (typeof stdout !== "string") return undefined;
  const all = [...stdout.matchAll(/"permissionMode":"([A-Za-z]+)"/g)];
  return all.length === 0 ? undefined : all[all.length - 1]![1];
}

/** ¿Hay que retener este `ask` para el reloj? Solo auto mode lo decide otro (el clasificador). */
export function holdsInMode(mode: string | undefined): boolean {
  return mode !== "auto";
}
