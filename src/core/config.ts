import type { Config, Ctx } from "./types.js";
import { DEFAULT_FORBIDDEN, compileRules } from "./perm/forbidden.js";
import type { ForbiddenRule } from "./perm/forbidden.js";

export const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface RawConfig {
  url?: string | undefined;
  token?: string | undefined;
  instanceId?: string | undefined;
  ctx?: string | undefined;
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; errors: string[] };

/**
 * Valida la configuración que llega de las variables ORBIT_*. No hay valor por defecto para `ctx`:
 * un `ctx` olvidado no debe convertirse en "personal" (enviaría prompts de una máquina de trabajo).
 */
export function parseConfig(raw: RawConfig): ConfigResult {
  const errors: string[] = [];
  const url = (raw.url ?? "").trim().replace(/\/+$/, "");
  const token = (raw.token ?? "").trim();
  const instanceId = (raw.instanceId ?? "").trim();
  const ctx = (raw.ctx ?? "").trim();

  if (url === "") errors.push("ORBIT_URL no está definida");
  else if (!/^https?:\/\/[^\s/]+/.test(url)) errors.push("ORBIT_URL debe empezar por http:// o https://");
  if (token === "") errors.push("ORBIT_TOKEN no está definida");
  if (instanceId === "") errors.push("ORBIT_INSTANCE_ID no está definida");
  else if (!INSTANCE_ID_RE.test(instanceId)) errors.push("ORBIT_INSTANCE_ID debe cumplir ^[a-z0-9][a-z0-9-]{0,31}$");
  if (ctx === "") errors.push("ORBIT_CTX no está definida (personal | work)");
  else if (ctx !== "personal" && ctx !== "work") errors.push("ORBIT_CTX debe ser personal o work");

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: { url, token, instanceId, ctx: ctx as Ctx } };
}

// ---------- permisos desde el reloj (fase 2, K2; SPEC §6) ----------


/** Expiración de un permiso retenido (SPEC §6.5). */
/** Retención por defecto: corta, porque en interactivo el diálogo del terminal espera a que termine (U1). */
export const PERM_HOLD_MS_DEFAULT = 20_000;
/** Retención con `/orbit away`: el usuario no está delante del Mac (la `exp` máxima de §6.5). */
export const PERM_HOLD_MS_AWAY = 90_000;
/** Tope de la espera configurable: nunca más que la expiración de la spec. */
export const PERM_HOLD_MS_MAX = 90_000;
export const PERM_HOLD_MS_MIN = 1_000;

export interface RawPermConfig {
  /** ORBIT_PERM: "off" desactiva la retención (el veredicto `ask` pasa tal cual). Por defecto, activa. */
  enabled?: string | undefined;
  /** ORBIT_PERM_HOLD_MS: cuánto se retiene fuera de `/orbit away` (1000..90000 ms); por defecto 20000. */
  holdMs?: string | undefined;
  /** ORBIT_FORBIDDEN: array JSON de regex que SUSTITUYE la lista "nunca desde el reloj". */
  forbidden?: string | undefined;
  /** ORBIT_FORBIDDEN_ADD: array JSON de regex que se AÑADEN a la lista por defecto. */
  forbiddenAdd?: string | undefined;
}

export interface PermConfig {
  enabled: boolean;
  holdMs: number;
  forbidden: ForbiddenRule[];
}

export type PermConfigResult = { ok: true; perm: PermConfig } | { ok: false; errors: string[] };

function regexList(raw: string, name: string, errors: string[]): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    errors.push(`${name} debe ser un array JSON de expresiones regulares`);
    return undefined;
  }
  if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === "string" && p !== "")) {
    errors.push(`${name} debe ser un array JSON de expresiones regulares no vacías`);
    return undefined;
  }
  return parsed as string[];
}

/**
 * Configuración de la retención de permisos. Un error NO desactiva el resto del mod, pero sí la
 * retención: sin una lista "nunca desde el reloj" fiable, el reloj no debe poder aprobar nada.
 */
export function parsePermConfig(raw: RawPermConfig): PermConfigResult {
  const errors: string[] = [];
  const enabledRaw = (raw.enabled ?? "").trim().toLowerCase();
  let enabled = true;
  if (enabledRaw === "off" || enabledRaw === "0" || enabledRaw === "false") enabled = false;
  else if (enabledRaw !== "" && enabledRaw !== "on" && enabledRaw !== "1" && enabledRaw !== "true")
    errors.push("ORBIT_PERM debe ser on u off");

  let holdMs = PERM_HOLD_MS_DEFAULT;
  const holdRaw = (raw.holdMs ?? "").trim();
  if (holdRaw !== "") {
    const n = Number(holdRaw);
    if (!Number.isInteger(n) || n < PERM_HOLD_MS_MIN || n > PERM_HOLD_MS_MAX)
      errors.push(`ORBIT_PERM_HOLD_MS debe ser un entero entre ${PERM_HOLD_MS_MIN} y ${PERM_HOLD_MS_MAX}`);
    else holdMs = n;
  }

  let forbidden: ForbiddenRule[] = [...DEFAULT_FORBIDDEN];
  const replace = (raw.forbidden ?? "").trim();
  if (replace !== "") {
    const list = regexList(replace, "ORBIT_FORBIDDEN", errors);
    if (list !== undefined) {
      const r = compileRules(list, "custom-");
      if (r.ok) forbidden = r.rules;
      else errors.push(`ORBIT_FORBIDDEN: ${r.error}`);
    }
  }
  const add = (raw.forbiddenAdd ?? "").trim();
  if (add !== "") {
    const list = regexList(add, "ORBIT_FORBIDDEN_ADD", errors);
    if (list !== undefined) {
      const r = compileRules(list, "extra-");
      if (r.ok) forbidden = forbidden.concat(r.rules);
      else errors.push(`ORBIT_FORBIDDEN_ADD: ${r.error}`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, perm: { enabled, holdMs, forbidden } };
}
