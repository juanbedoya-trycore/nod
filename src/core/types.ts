/** Versión del protocolo de ingesta que habla el mod (SPEC §9). */
export const ORBIT_VERSION = "0.2.0";

export type Ctx = "personal" | "work";

/** Payload canónico de un evento (hook-payload.schema.json). */
export type HookPayload = { session_id: string; hook_event_name: string } & Record<string, unknown>;

/** Un evento del sobre (SPEC §3.1). */
export interface IngestEvent {
  n: number;
  rx: number;
  ev: HookPayload;
}

export interface Envelope {
  orbit: string;
  instance_id: string;
  ctx: Ctx;
  src: "mod";
  events: IngestEvent[];
}

export interface Config {
  url: string;
  token: string;
  instanceId: string;
  ctx: Ctx;
  /**
   * Privacidad elegida en este perfil (`/orbit privacidad`). `metadatos` aplica la lista blanca de
   * ctx=work (§3.4) y el resumen de permisos solo con el verbo (§6.2) aunque la instancia sea personal.
   */
  privacy?: Privacy | undefined;
}

export type Privacy = "completa" | "metadatos";

/** ctx con el que se filtra lo que sale de la máquina: el de la instancia, o work si se pidió privacidad. */
export function effectiveCtx(cfg: Pick<Config, "ctx" | "privacy">): Ctx {
  return cfg.privacy === "metadatos" ? "work" : cfg.ctx;
}
