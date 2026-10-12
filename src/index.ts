/** Versión del protocolo Orbit que implementa este paquete. */
export const PROTOCOL_VERSION = 1;

/** Nombre del comando de barra que registra el plugin. */
export const COMMAND_NAME = "orbit";

/** Devuelve el identificador de instancia a partir de una ruta de proyecto (sin datos sensibles). */
export function instanceLabel(projectPath: string): string {
  const parts = projectPath.split(/[\\/]+/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1]! : "unknown";
}
