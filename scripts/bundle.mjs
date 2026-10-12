// Empaqueta cada adaptador en un solo fichero ESM y lo versiona: así se instala desde git sin Node ni compilar.
//   bundle/claude.js    el mod de Claude Code (lo carga hooks/hooks.json), sin Node ni DOM
//   bundle/opencode.js  el plugin de OpenCode (se copia a su carpeta de plugins); corre en Bun, con node:*
// `--check` falla si algún bundle versionado no es el que sale de src/ (para CI).
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const TARGETS = [
  {
    entry: "src/hosts/claude/register.ts",
    out: "bundle/claude.js",
    platform: "neutral",
    banner: "// Nod para Claude Code. Generado por scripts/bundle.mjs desde src/: no editar a mano.",
  },
  {
    entry: "src/hosts/opencode/plugin.ts",
    out: "bundle/opencode.js",
    platform: "node",
    banner: "// Nod para OpenCode. Generado por scripts/bundle.mjs desde src/: no editar a mano.",
  },
];

let stale = false;
for (const t of TARGETS) {
  const out = join(ROOT, t.out);
  const r = await build({
    entryPoints: [join(ROOT, t.entry)],
    bundle: true,
    format: "esm",
    platform: t.platform,
    target: "es2022",
    legalComments: "none",
    banner: { js: t.banner },
    outfile: out,
    write: !check,
    logLevel: "warning",
  });
  if (check) {
    const fresh = r.outputFiles[0].text;
    let old = "";
    try { old = readFileSync(out, "utf8"); } catch {}
    if (fresh !== old) {
      console.error(`${t.out} no corresponde a src/: ejecuta  npm run build  y versiona el resultado`);
      stale = true;
    }
  }
}
if (stale) process.exit(1);
