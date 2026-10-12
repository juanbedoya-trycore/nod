import type { Ctx, HookPayload } from "./types.js";

/** SPEC §3.4 / ingest.schema.json#/$defs/workAllowlist. Un test la compara con el schema. */
export const WORK_ALLOWLIST: readonly string[] = [
  "session_id",
  "hook_event_name",
  "prompt_id",
  "turn_id",
  "permission_mode",
  "effort",
  "agent_id",
  "agent_type",
  "tool_name",
  "tool_use_id",
  "parent_tool_use_id",
  "background",
  "duration_ms",
  "is_error",
  "is_aborted",
  "stop_hook_active",
  "reason",
  "source",
];

const ALLOWED = new Set(WORK_ALLOWLIST);

/** Corta por code points, no por unidades UTF-16. */
function clipCodePoints(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join("");
}

/**
 * Con ctx=work deja solo los campos de la lista blanca; con ctx=personal devuelve el evento tal cual.
 * `reason` solo se conserva en SessionEnd y se corta a 32. Devuelve una copia: no muta la entrada.
 */
export function applyAllowlist(ev: HookPayload, ctx: Ctx): HookPayload {
  if (ctx !== "work") return ev;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ev)) {
    if (!ALLOWED.has(k)) continue;
    if (k === "reason") {
      if (ev.hook_event_name !== "SessionEnd" || typeof v !== "string") continue;
      out[k] = clipCodePoints(v, 32);
      continue;
    }
    out[k] = v;
  }
  return out as HookPayload;
}
