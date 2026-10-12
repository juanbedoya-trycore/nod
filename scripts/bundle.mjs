// Empaqueta el adaptador de Claude Code en un solo fichero ESM (bundle/claude.js), que es lo que carga
// hooks/hooks.json. Se versiona: así el plugin se instala desde git sin Node ni compilar nada.
// `--check` falla si el bundle versionado no es el que sale de src/ (para CI).
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "bundle/claude.js");
const check = process.argv.includes("--check");

const r = await build({
  entryPoints: [join(ROOT, "src/hosts/claude/register.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  legalComments: "none",
  banner: { js: "// Nod para Claude Code. Generado por scripts/bundle.mjs desde src/: no editar a mano." },
  outfile: OUT,
  write: !check,
  logLevel: "warning",
});
if (check) {
  const fresh = r.outputFiles[0].text;
  let old = "";
  try { old = readFileSync(OUT, "utf8"); } catch {}
  if (fresh !== old) {
    console.error("bundle/claude.js no corresponde a src/: ejecuta  npm run build  y versiona el resultado");
    process.exit(1);
  }
}
