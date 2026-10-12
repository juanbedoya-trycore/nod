// Convierte una captura de la sonda (probe.ts) en un fixture: se queda solo con los eventos y hooks que usa el
// adaptador, reduce chat.params a lo que lee (agente y modelo: la entrada original lleva la clave del proveedor) y
// cambia las rutas del proyecto y del usuario por unas genéricas.
//   node tools/probe-opencode/anonimiza.mjs <captura.jsonl> <directorio del proyecto> > test/fixtures/x.jsonl
import { readFileSync } from "node:fs";

const [file, project] = process.argv.slice(2);
if (!file || !project) {
  console.error("uso: anonimiza.mjs <captura.jsonl> <directorio del proyecto>");
  process.exit(2);
}
const EVENTS = new Set(["session.created", "session.updated", "session.deleted", "session.error", "session.idle", "session.status", "message.updated", "message.part.updated", "permission.asked", "permission.replied", "command.executed", "vcs.branch.updated"]);
const HOOKS = new Set(["chat.message", "chat.params", "tool.execute.before", "tool.execute.after", "command.execute.before", "config", "dispose"]);
const home = process.env.HOME ?? "/Users/nadie";
const swap = (text) => text.split(project).join("/Users/dev/proyecto").replace(/\/private\/tmp\/[^"\s\\]*/g, "/tmp/x").split(home).join("/Users/dev");

for (const line of readFileSync(file, "utf8").split("\n")) {
  if (line.trim() === "") continue;
  const row = JSON.parse(line);
  if (row.phase === "event" ? !EVENTS.has(row.event) : !(row.phase === "in" || row.phase === "out") || !HOOKS.has(row.event)) continue;
  if (row.event === "chat.params") {
    const i = row.data?.input;
    row.data = row.phase === "in" ? { input: { sessionID: i?.sessionID, agent: i?.agent, model: { id: i?.model?.id, providerID: i?.model?.providerID, limit: i?.model?.limit } } } : {};
  }
  process.stdout.write(swap(JSON.stringify(row)) + "\n");
}
