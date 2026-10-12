#!/usr/bin/env node
// Empaqueta @noble/curves (p256) y @noble/hashes (sha256) en un único módulo ESM sin imports:
//   mod/src/vendor/noble-p256.ts
//
// Por qué: el sandbox de mods solo deja importar ficheros propios por ruta relativa (y "claude-code").
// Un `import "@noble/curves/..."` hace que el módulo de hooks no cargue (comprobado en K1/U8). tsc
// compila el fichero empaquetado a dist/vendor/noble-p256.js junto al resto.
//
//   npm --prefix mod run vendor:noble           regenera
//   npm --prefix mod run vendor:noble -- --check  sale con 1 si el fichero no coincide (versiones o contenido)
import { build } from "esbuild";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src", "vendor", "noble-p256.ts");
const ver = (p) => JSON.parse(readFileSync(join(root, "node_modules", p, "package.json"), "utf8")).version;
const versions = `@noble/curves ${ver("@noble/curves")}, @noble/hashes ${ver("@noble/hashes")}, esbuild ${ver("esbuild")}`;

const result = await build({
  stdin: {
    contents: 'export { p256 } from "@noble/curves/nist.js";\nexport { sha256 } from "@noble/hashes/sha2.js";\n',
    resolveDir: root,
    loader: "js",
  },
  bundle: true,
  format: "esm",
  platform: "neutral",
  treeShaking: true,
  legalComments: "none",
  write: false,
  logLevel: "silent",
});
const code = result.outputFiles[0].text;
if (/\bimport\s*\(|^\s*import\s/m.test(code)) throw new Error("el bundle aún tiene imports");

const header = `// @ts-nocheck
// GENERADO por mod/scripts/vendor-noble.mjs: no editar a mano.
// ${versions}. Licencia MIT (c) Paul Miller, https://paulmillr.com/noble/
// Solo se usa para VERIFICAR firmas ECDSA P-256 (SPEC §6.3) y SHA-256 del SPKI (kid).
`;
const text = header + code;

if (process.argv.includes("--check")) {
  if (!existsSync(out) || readFileSync(out, "utf8") !== text) {
    console.error(`FALLO ${out} no coincide con lo que genera el script (${versions}); ejecuta npm --prefix mod run vendor:noble`);
    process.exit(1);
  }
  console.log(`vendor ok (${versions})`);
} else {
  writeFileSync(out, text);
  console.log(`escrito ${out} (${versions}, ${text.length} bytes)`);
}
