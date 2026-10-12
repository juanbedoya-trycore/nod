import type { Config } from "./types.js";
import type { CollectorStatus } from "./collector.js";

export type OrbitAction = "status" | "pause" | "resume" | "away" | "back" | "privacy" | "privacy-full" | "privacy-metadata" | "invalid";

export function parseOrbitArgs(args: string): OrbitAction {
  const a = args.trim().toLowerCase();
  if (a === "" || a === "status") return "status";
  if (a === "pause") return "pause";
  if (a === "resume") return "resume";
  if (a === "away") return "away";
  if (a === "back") return "back";
  if (a === "privacidad" || a === "privacy") return "privacy";
  if (/^(privacidad|privacy)\s+(completa|full)$/.test(a)) return "privacy-full";
  if (/^(privacidad|privacy)\s+(metadatos|metadata)$/.test(a)) return "privacy-metadata";
  return "invalid";
}

export const ORBIT_USAGE = "uso: /orbit [status | away | back | privacidad [completa|metadatos] | respuestas [añadir <texto>|quitar <n>|restablecer] | pause | resume | setup | pair | unpair <huella>]";

function ago(now: number, at: number | undefined): string {
  if (at === undefined) return "nunca";
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `hace ${s}s` : `hace ${Math.round(s / 60)}min`;
}

/** Texto de `/orbit`. Nunca incluye el token. */
export function formatStatus(cfg: Config | undefined, errors: string[], status: CollectorStatus | undefined, now: number): string {
  if (cfg === undefined || status === undefined) {
    return ["sin configurar (no se envía nada)", ...errors.map((e) => `  - ${e}`)].join("\n");
  }
  const label: Record<CollectorStatus["state"], string> = {
    connected: "conectado",
    offline: "sin conexión (reintentando)",
    paused: "en pausa",
    pending: "eventos pendientes de enviar",
    idle: "listo (aún no se envió nada)",
  };
  const lines = [
    `estado: ${label[status.state]}`,
    `  servidor: ${cfg.url}`,
    `  instancia: ${cfg.instanceId} (${cfg.ctx})`,
    `  privacidad: ${cfg.privacy === "metadatos" ? "metadatos (sin prompts, comandos ni rutas; el reloj solo ve el verbo)" : "completa"}`,
    `  cola: ${status.queued} eventos (${status.queuedBytes} bytes)`,
    `  enviados: ${status.sent}, perdidos: ${status.dropped}`,
    `  último envío correcto: ${ago(now, status.lastOkAt)}`,
    `  último error: ${status.lastError === undefined ? "ninguno" : `${status.lastError} (${ago(now, status.lastErrorAt)})`}`,
  ];
  if (status.duplicates > 0) lines.push(`  descartados por repetidos en el servidor: ${status.duplicates} (¿otra sesión con el mismo instance_id?)`);
  if (status.paused) lines.push("  el envío está pausado: los eventos se acumulan en la cola; /orbit resume para reanudar");
  return lines.join("\n");
}
