#!/usr/bin/env node
// U8 (SPEC §11): qué hay de criptografía dentro del sandbox de mods. FUERA de `make check`: llama al
// binario real de Claude (con el modelo, aunque /u8 no le hace pensar). Requiere `npm --prefix mod run build`.
//   node mod/test/e2e/u8-probe.mjs
// Monta un plugin mínimo en mod/test/e2e/tmp-u8/ (se borra al acabar, ORBIT_KEEP=1 lo conserva) con una
// copia de mod/dist, y comprueba en el sandbox: crypto.getRandomValues, crypto.subtle, openssl rand y
// verifyDecision (noble empaquetado) sobre los vectores firmados por Kotlin.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MOD = path.resolve(HERE, '../..')
const TMP = path.join(HERE, 'tmp-u8')
const CLAUDE = process.env.CLAUDE_BIN ?? path.join(os.homedir(), '.local/bin/claude')
const dv = JSON.parse(fs.readFileSync(path.resolve(MOD, 'protocol/vectors/sig/decisions.json'), 'utf8'))
const ok = dv.cases.find((c) => c.name === 'allow-valida')
const bad = dv.cases.find((c) => c.name === 'firma-alterada')

fs.rmSync(TMP, { recursive: true, force: true })
const plugin = path.join(TMP, 'plugin')
fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true })
fs.mkdirSync(path.join(plugin, 'hooks'), { recursive: true })
fs.mkdirSync(path.join(TMP, 'run'), { recursive: true })
fs.cpSync(path.join(MOD, 'dist'), path.join(plugin, 'dist'), { recursive: true })
fs.writeFileSync(path.join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'orbit-u8', version: '0.0.1', description: 'U8 probe' }))
fs.writeFileSync(path.join(plugin, 'hooks/hooks.json'), JSON.stringify({ modules: ['../register.js'] }))
fs.writeFileSync(path.join(plugin, 'register.js'), `import { verifyDecision } from './dist/core/perm/verify.js';
const H = (s) => Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));
const PAIRED = [{ kid: H(${JSON.stringify(dv.paired[0].kid)}), spki: H(${JSON.stringify(dv.paired[0].spki)}) }];
const P = { nonce: H(${JSON.stringify(ok.pending.nonce)}), toolUseId: ${JSON.stringify(ok.pending.tool_use_id)}, exp: ${ok.pending.exp}, wok: true };
async function probe($) {
  const out = {};
  const t = (k, f) => { try { out[k] = f(); } catch (e) { out[k] = 'THROW ' + String(e); } };
  t('getRandomValues', () => { const a = new Uint8Array(16); globalThis.crypto.getRandomValues(a); return a.some((x) => x !== 0); });
  t('subtle', () => Object.getOwnPropertyNames(Object.getPrototypeOf(globalThis.crypto.subtle) || {}).concat(Object.keys(globalThis.crypto.subtle)).filter((k) => k !== 'constructor').join(','));
  t('ok', () => verifyDecision(P, H(${JSON.stringify(ok.dec)}), PAIRED, ${ok.now}).ok);
  t('bad', () => verifyDecision(P, H(${JSON.stringify(bad.dec)}), PAIRED, ${bad.now}).cause);
  try { const r = await $.process.run(['openssl', 'rand', '-hex', '16']); out.openssl = r.exitCode === 0 && /^[0-9a-f]{32}$/.test(r.stdout.trim()); } catch (e) { out.openssl = 'THROW ' + String(e); }
  return out;
}
export const register = (on) => {
  on('session.start', async ($, e, next) => { await $.command.register({ name: 'u8', description: 'U8 probe' }); return next(e); });
  on('command.run', { command: 'u8' }, async ($) => ({ text: 'U8RESULT ' + JSON.stringify(await probe($)) }));
};
`)
const r = spawnSync(CLAUDE, ['-p', '/u8', '--plugin-dir', plugin, '--model', 'haiku', '--no-session-persistence', '--output-format', 'text'], {
  cwd: path.join(TMP, 'run'), input: '', encoding: 'utf8', timeout: 170000,
})
const line = `${r.stdout}\n${r.stderr}`.split('\n').find((l) => l.includes('U8RESULT '))
if (process.env.ORBIT_KEEP !== '1') fs.rmSync(TMP, { recursive: true, force: true })
if (!line) {
  console.error(`FALLO: el plugin no respondió\n${r.stdout}\n${r.stderr}`)
  process.exit(1)
}
const res = JSON.parse(line.slice(line.indexOf('U8RESULT ') + 9))
console.log(JSON.stringify(res))
let fails = 0
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) fails++ }
check('crypto.getRandomValues existe y da bytes', res.getRandomValues === true)
check('verifyDecision acepta la dec firmada por Kotlin', res.ok === true)
check('verifyDecision rechaza la firma alterada', res.bad === 'sig')
console.log(`info: crypto.subtle tiene: ${res.subtle}; openssl rand -hex: ${res.openssl}`)
process.exit(fails ? 1 : 0)
