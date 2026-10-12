#!/usr/bin/env node
// Orbit K2: e2e de la retención de permisos con el mod real y el binario real de Claude Code (headless).
// LLAMA AL MODELO: NO forma parte de `make check`.
//   npm --prefix mod run build && node mod/test/e2e/perm.mjs
//   Variables opcionales: CLAUDE_BIN, ORBIT_MODEL (haiku), ORBIT_KEEP=1 (conserva el directorio temporal),
//   ORBIT_E2E_TIMEOUT_MS (espera corta del caso timeout, por defecto 6000).
//
// Servidor stub con la API de permisos (SPEC §6, http-api.schema.json): /v0/ingest, /v0/perm/pending,
// GET /v0/perm/decision (long-poll), /v0/perm/resolved. Cuando llega un pending, el stub firma una `dec`
// con una llave P-256 de prueba (ECDSA SHA-256, r||s de 64 bytes, kid = SHA-256(SPKI DER)[0..8]) sobre
// la entrada de §6.3 y la sirve por el long-poll.
//
// Escenarios: allow (el Bash se ejecuta), deny (no se ejecuta), timeout (espera corta, ask original:
// en -p es denegar), forbidden (rm -rf con allow firmado: se rechaza y vence).
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MOD = path.resolve(HERE, '../..')
const PROTOCOL = path.resolve(MOD, 'protocol')
const CLAUDE = process.env.CLAUDE_BIN ?? path.join(os.homedir(), '.local/bin/claude')
const MODEL = process.env.ORBIT_MODEL ?? 'haiku'
const SHORT_MS = Number(process.env.ORBIT_E2E_TIMEOUT_MS ?? '6000')
const TMP = fs.mkdtempSync(path.join(process.env.ORBIT_TMP ?? os.tmpdir(), 'orbit-perm-'))
const require = createRequire(path.join(MOD, 'package.json'))
const Ajv2020 = require('ajv/dist/2020.js').default ?? require('ajv/dist/2020.js')

if (!fs.existsSync(path.join(MOD, 'dist/hosts/claude/register.js'))) {
  console.error('falta mod/dist: ejecuta `npm --prefix mod run build` antes'); process.exit(2)
}
{
  const v = spawnSync(CLAUDE, ['--version'], { encoding: 'utf8' })
  const got = /(\d+)\.(\d+)\.(\d+)/.exec(v.stdout ?? '')?.slice(1).map(Number)
  if (!got || (got[0] - 2 || got[1] - 1 || got[2] - 296) < 0) { console.error(`claude "${CLAUDE}" no sirve (${v.stdout})`); process.exit(2) }
}

const { encode } = await import(pathToFileURL(path.join(MOD, 'dist/protocol/cbor.js')).href)
const { encodeFrame } = await import(pathToFileURL(path.join(MOD, 'dist/protocol/types.js')).href)

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false, strictTuples: false })
const api = JSON.parse(fs.readFileSync(path.join(PROTOCOL, 'schema/http-api.schema.json'), 'utf8'))
ajv.addSchema(api, 'http-api.schema.json')
const validatePending = ajv.getSchema('http-api.schema.json#/$defs/permPending')
const validateResolved = ajv.getSchema('http-api.schema.json#/$defs/permResolved')

// ---- llave de prueba del "reloj" ------------------------------------------------------------------
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
const spki = publicKey.export({ type: 'spki', format: 'der' })
const kid = crypto.createHash('sha256').update(spki).digest().subarray(0, 8)
const b64u = (b) => Buffer.from(b).toString('base64url')
function signDec(nonce, toolUseId, decision, ts) {
  const input = encode(['orbit-dec', 1, nonce, toolUseId, decision, ts])
  const sig = crypto.sign('sha256', input, { key: privateKey, dsaEncoding: 'ieee-p1363' })
  return encodeFrame({ type: 'dec', nonce, toolUseId, decision, ts, kid: new Uint8Array(kid), sig: new Uint8Array(sig) })
}

// ---- servidor stub --------------------------------------------------------------------------------
const TOKEN = 'e2e-token'
let scenario = { answer: 'none', delayMs: 1500 }
let log = [] // { at, path, body }
const queues = new Map() // tool_use_id -> [b64u dec]
const waiters = new Map() // tool_use_id -> fn
function pushDec(id, bytes) {
  const q = queues.get(id) ?? []
  q.push(b64u(bytes)); queues.set(id, q)
  waiters.get(id)?.()
}
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const u = new URL(req.url, 'http://x')
    const json = body ? (() => { try { return JSON.parse(body) } catch { return body } })() : undefined
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; return res.end() }
    if (u.pathname !== '/v0/ingest') log.push({ at: Date.now(), method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: json })
    if (req.method === 'POST' && u.pathname === '/v0/ingest') return res.end('{}')
    if (req.method === 'POST' && u.pathname === '/v0/perm/pending') {
      const p = json
      if (scenario.answer !== 'none') {
        const nonce = new Uint8Array(Buffer.from(p.nonce, 'base64url'))
        setTimeout(() => pushDec(p.tool_use_id, signDec(nonce, p.tool_use_id, scenario.answer, Math.floor(Date.now() / 1000))), scenario.delayMs)
      }
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ status: 'pending', id: 1 }))
    }
    if (req.method === 'GET' && u.pathname === '/v0/perm/decision') {
      const id = u.searchParams.get('tool_use_id') ?? ''
      const wait = Math.min(Number(u.searchParams.get('wait') ?? '0'), 2000)
      const take = () => queues.get(id)?.shift()
      const send = (dec) => {
        if (dec === undefined) { res.statusCode = 204; return res.end() }
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ dec }))
      }
      const now = take()
      if (now !== undefined) return send(now)
      const t = setTimeout(() => { waiters.delete(id); send(undefined) }, wait)
      waiters.set(id, () => { clearTimeout(t); waiters.delete(id); send(take()) })
      return
    }
    if (req.method === 'POST' && u.pathname === '/v0/perm/resolved') return res.end('{"status":"closed"}')
    res.statusCode = 404; res.end()
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const URL_BASE = `http://127.0.0.1:${server.address().port}`

// ---- helpers --------------------------------------------------------------------------------------
let failures = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++ }

function run(name, prompt, env = {}) {
  const dir = path.join(TMP, name)
  fs.mkdirSync(dir, { recursive: true })
  const args = ['-p', prompt, '--plugin-dir', MOD, '--model', MODEL, '--permission-mode', 'default',
    '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--debug-file', path.join(dir, 'debug.log'),
    '--strict-mcp-config', '--setting-sources', 'project,local']
  const started = Date.now()
  return new Promise((resolve) => {
    const p = spawn(CLAUDE, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ORBIT_URL: URL_BASE, ORBIT_TOKEN: TOKEN, ORBIT_INSTANCE_ID: 'e2e-perm', ORBIT_CTX: 'personal',
        ...pairingEnv(), ...env } })
    let out = '', err = ''
    p.stdout.on('data', (c) => (out += c)); p.stderr.on('data', (c) => (err += c))
    const killer = setTimeout(() => p.kill('SIGKILL'), 240000)
    p.on('close', (code) => { clearTimeout(killer); resolve({ dir, code, out, err, ms: Date.now() - started }) })
  })
}

/** Cómo llega la llave pública emparejada al mod (K1). */
function pairingEnv() {
  return { ORBIT_WATCH_KEYS: JSON.stringify([b64u(spki)]) }
}

const PROMPT = (cmd) => `Use the Bash tool exactly once to run this exact command: ${cmd}
Do not retry if it is refused. Then reply with the single word: done.`
const pendings = () => log.filter((l) => l.path === '/v0/perm/pending').map((l) => l.body)
const resolveds = () => log.filter((l) => l.path === '/v0/perm/resolved').map((l) => l.body)
const polls = () => log.filter((l) => l.path === '/v0/perm/decision')

async function scenarioRun(name, cmd, sc, env = {}) {
  console.log(`\n== ${name} ==`)
  log = []; queues.clear(); scenario = sc
  const r = await run(name, PROMPT(cmd), env)
  const ps = pendings(), rs = resolveds()
  check(`${name}: el proceso termina`, r.code === 0, `exit=${r.code} ${Math.round(r.ms / 1000)} s`)
  check(`${name}: un POST /v0/perm/pending válido (permPending)`, ps.length >= 1 && ps.every((p) => validatePending(p)),
    JSON.stringify(validatePending.errors ?? ps[0] ?? '').slice(0, 300))
  check(`${name}: un POST /v0/perm/resolved por tool_use_id, válido (permResolved)`,
    rs.length === ps.length && rs.every((x) => validateResolved(x)) && new Set(rs.map((x) => x.tool_use_id)).size === rs.length,
    JSON.stringify(rs))
  check(`${name}: hubo long-poll con wait <= 2000`, polls().length >= 1 && polls().every((p) => Number(p.query.wait) <= 2000), `polls=${polls().length}`)
  return { r, ps, rs }
}

// ---- escenarios -----------------------------------------------------------------------------------
{
  const file = path.join(TMP, 'allow.txt')
  const { ps, rs } = await scenarioRun('allow', `touch ${file}`, { answer: 'allow', delayMs: 1500 })
  check('allow: el pending lleva sum = comando y wok=true', ps[0]?.sum === `touch ${file}` && ps[0]?.wok === true)
  check('allow: resolved {by:watch, decision:allow}', rs[0]?.by === 'watch' && rs[0]?.decision === 'allow', JSON.stringify(rs[0]))
  check('allow: el Bash se ejecutó (el fichero existe)', fs.existsSync(file))
}
{
  const file = path.join(TMP, 'deny.txt')
  const { rs } = await scenarioRun('deny', `touch ${file}`, { answer: 'deny', delayMs: 1500 })
  check('deny: resolved {by:watch, decision:deny}', rs[0]?.by === 'watch' && rs[0]?.decision === 'deny', JSON.stringify(rs[0]))
  check('deny: el Bash NO se ejecutó', !fs.existsSync(file))
}
{
  const file = path.join(TMP, 'timeout.txt')
  const t0 = Date.now()
  const { rs } = await scenarioRun('timeout', `touch ${file}`, { answer: 'none' }, { ORBIT_PERM_HOLD_MS: String(SHORT_MS) })
  check('timeout: resolved {by:timeout, decision:none}', rs[0]?.by === 'timeout' && rs[0]?.decision === 'none', JSON.stringify(rs[0]))
  check('timeout: el Bash NO se ejecutó (ask original = denegar en -p)', !fs.existsSync(file))
  check('timeout: la sesión tardó al menos la espera configurada', Date.now() - t0 >= SHORT_MS, `${Date.now() - t0} ms`)
}
{
  const dir = path.join(TMP, 'victim')
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'keep.txt'), 'x')
  const { ps, rs } = await scenarioRun('forbidden', `rm -rf ${dir}`, { answer: 'allow', delayMs: 500 }, { ORBIT_PERM_HOLD_MS: String(SHORT_MS) })
  check('forbidden: el pending lleva wok=false', ps[0]?.wok === false)
  check('forbidden: el allow firmado se rechaza (reject:forbidden) y vence', rs[0]?.by === 'timeout' && rs[0]?.reject === 'forbidden', JSON.stringify(rs[0]))
  check('forbidden: el directorio sigue ahí', fs.existsSync(path.join(dir, 'keep.txt')))
}
{
  console.log('\n== servidor caído ==')
  const file = path.join(TMP, 'down.txt')
  log = []
  const t0 = Date.now()
  const r = await run('down', PROMPT(`touch ${file}`), { ORBIT_URL: 'http://127.0.0.1:9' })
  check('down: el proceso termina sin quedarse bloqueado (< 60 s)', r.code === 0 && Date.now() - t0 < 60000, `${Date.now() - t0} ms`)
  check('down: el Bash no se ejecutó (flujo normal: ask = denegar en -p)', !fs.existsSync(file))
}

server.close()
if (process.env.ORBIT_KEEP) console.log(`temp dir: ${TMP}`); else fs.rmSync(TMP, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
