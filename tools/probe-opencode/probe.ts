// Sonda de OpenCode (la de tools/probe, para OpenCode): registra en NOD_PROBE_LOG (JSONL) cada evento del bus y
// cada hook de plugin, con la entrada y la salida recortadas. Sirve para comprobar los nombres y campos reales
// antes de escribir el adaptador. Sin NOD_PROBE_LOG no hace nada.
//
// Uso: copiarla a ~/.config/opencode/plugins/ (o a <proyecto>/.opencode/plugins/) y
//   NOD_PROBE_LOG=/tmp/probe.jsonl opencode run "…"
import { appendFileSync } from "node:fs";

const MAX = 600;
const FILE = process.env.NOD_PROBE_LOG;
// Lo que se repite en cada pulsación o fragmento: no dice nada nuevo.
const NOISE = new Set(["message.part.delta", "session.next.text.delta", "session.next.reasoning.delta", "session.next.tool.input.delta"]);

function clip(v: unknown, d = 0): unknown {
  if (typeof v === "string") return v.length > MAX ? v.slice(0, MAX) + `…[+${v.length - MAX}]` : v;
  if (v === null || typeof v !== "object") return v;
  if (d > 6) return "[deep]";
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => clip(x, d + 1));
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = typeof x === "function" ? "[fn]" : clip(x, d + 1);
  return o;
}

function write(phase: string, event: string, data: unknown): void {
  if (!FILE) return;
  try {
    appendFileSync(FILE, JSON.stringify({ ts: Date.now(), phase, event, data: clip(data) }) + "\n");
  } catch {
    // la sonda nunca rompe la sesión
  }
}

const HOOKS = [
  "chat.message", "chat.params", "chat.headers", "permission.ask", "command.execute.before", "tool.execute.before",
  "tool.execute.after", "shell.env", "experimental.chat.system.transform", "experimental.session.compacting",
  "experimental.text.complete", "tool.definition",
];

export const NodProbe = async (input: any) => {
  write("init", "plugin", { directory: input?.directory, worktree: input?.worktree, project: input?.project, serverUrl: String(input?.serverUrl), env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(OPENCODE|XDG_)/.test(k))), argv: process.argv, versions: process.versions });
  const hooks: Record<string, unknown> = {
    event: async ({ event }: any) => {
      if (!NOISE.has(event?.type)) write("event", String(event?.type), event?.properties);
      // NOD_PROBE_REPLY=once|reject: contesta los permisos desde el plugin (para comprobar que se puede).
      const reply = process.env.NOD_PROBE_REPLY;
      if (reply && event?.type === "permission.asked") {
        const p = event.properties;
        setTimeout(() => {
          Promise.resolve()
            .then(() => input.client.postSessionIdPermissionsPermissionId({ path: { id: p.sessionID, permissionID: p.id }, body: { response: reply } }))
            .then((r: any) => write("reply", "permission", { status: r?.response?.status, data: r?.data, error: r?.error }), (err: unknown) => write("reply", "permission", { error: String(err) }));
        }, 1500);
      }
    },
    config: async (cfg: any) => {
      write("in", "config", { keys: Object.keys(cfg ?? {}), command: Object.keys(cfg?.command ?? {}) });
      cfg.command = { ...(cfg.command ?? {}), "nod-probe": { template: "Responde solo: sonda $ARGUMENTS", description: "comando de la sonda" } };
    },
    dispose: async () => write("in", "dispose", {}),
  };
  for (const name of HOOKS) {
    hooks[name] = async (i: unknown, o: unknown) => {
      if (name === "tool.definition") return;
      write("in", name, { input: i, output: o });
      // La salida definitiva (otros plugins pueden cambiarla) se ve al final de la ronda.
      queueMicrotask(() => write("out", name, { output: o }));
    };
  }
  return hooks;
};
