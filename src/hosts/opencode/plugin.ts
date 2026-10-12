// Nod para OpenCode: el plugin que carga OpenCode (bundle/opencode.js, copiado a su carpeta de plugins). Construye
// la Platform con lo que da el proceso de OpenCode y entrega sus hooks al adaptador (adapter.ts).
//
// OpenCode trata cada export del módulo como un plugin: este fichero exporta solo `NodPlugin`. El motor es uno por
// proceso (una ejecución de Nod v1 con su `seq`), aunque OpenCode cree una instancia del plugin por proyecto.
import { NodEngine } from "../../core/engine.js";
import { createAdapter } from "./adapter.js";
import type { ClientLike } from "./adapter.js";
import { nodePlatform, repoOf, runModeOf } from "./node.js";

let engine: NodEngine | undefined;

export const NodPlugin = async (input: { client?: unknown; directory?: string; worktree?: string }) => {
  engine ??= new NodEngine();
  const client = (input?.client ?? {}) as ClientLike & {
    app?: { log?: (o: unknown) => Promise<unknown> };
    tui?: { showToast?: (o: unknown) => Promise<unknown> };
  };
  const log = (message: string) => {
    void Promise.resolve()
      .then(() => client.app?.log?.({ body: { service: "nod", level: "debug", message } }))
      .catch(() => undefined);
  };
  const toast = (message: string) => {
    void Promise.resolve()
      .then(() => client.tui?.showToast?.({ body: { title: "Nod", message, variant: "info" } }))
      .catch(() => undefined);
  };
  const directory = typeof input?.directory === "string" ? input.directory : process.cwd();
  const repo = await repoOf(typeof input?.worktree === "string" ? input.worktree : directory).catch(() => undefined);
  return createAdapter({
    engine,
    platform: nodePlatform(process.env, log, toast),
    clock: () => Date.now(),
    client,
    mode: runModeOf(process.argv),
    directory,
    repo,
  });
};
