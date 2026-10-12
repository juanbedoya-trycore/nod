#!/usr/bin/env node
// Empaqueta qrcode-generator (Kazuhiko Arase, MIT) en un único módulo ESM sin imports:
//   mod/src/vendor/qrcode.ts
//
// Por qué: el sandbox de mods solo deja importar ficheros propios por ruta relativa (ver vendor-noble.mjs).
// Lo usa `/nod setup` para dibujar el QR del emparejamiento automático con caracteres de bloque.
//
//   npm --prefix mod run vendor:qr             regenera
//   npm --prefix mod run vendor:qr -- --check  sale con 1 si el fichero no coincide
import { build } from "esbuild";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src", "vendor", "qrcode.ts");
const ver = (p) => JSON.parse(readFileSync(join(root, "node_modules", p, "package.json"), "utf8")).version;
const versions = `qrcode-generator ${ver("qrcode-generator")}, esbuild ${ver("esbuild")}`;

const result = await build({
  stdin: { contents: 'export { default as qrcode } from "qrcode-generator";\n', resolveDir: root, loader: "js" },
  bundle: true,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  treeShaking: true,
  legalComments: "none",
  write: false,
  logLevel: "silent",
});
const code = result.outputFiles[0].text;
if (/\bimport\s*\(|^\s*import\s/m.test(code)) throw new Error("el bundle aún tiene imports");

const header = `// @ts-nocheck
// GENERADO por mod/scripts/vendor-qr.mjs: no editar a mano.
// ${versions}. Licencia MIT (c) Kazuhiko Arase, https://github.com/kazuhikoarase/qrcode-generator
// Solo se usa para dibujar el QR de /nod setup (emparejamiento automático, SPEC §6.3.1).
`;
const text = header + code;

if (process.argv.includes("--check")) {
  if (!existsSync(out) || readFileSync(out, "utf8") !== text) {
    console.error(`FALLO ${out} no coincide con lo que genera el script (${versions}); ejecuta npm --prefix mod run vendor:qr`);
    process.exit(1);
  }
  console.log(`vendor ok (${versions})`);
} else {
  writeFileSync(out, text);
  console.log(`escrito ${out} (${versions}, ${text.length} bytes)`);
}
