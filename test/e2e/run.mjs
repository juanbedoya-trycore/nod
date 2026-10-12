#!/usr/bin/env node
// Orbit M1+M2: e2e del mod real contra el binario real de Claude Code (headless).
// LLAMA AL MODELO: no forma parte de `make check`. Objetivo documentado: `check-mod-e2e` (docs/install-mod.md).
//   node mod/test/e2e/run.mjs            (requiere `npm --prefix mod run build` hecho)
//   CLAUDE_BIN=... ORBIT_MODEL=haiku ... variables opcionales
// Escenarios: personal (Bash que pide permiso + subagente + MCP + /orbit), work (lista blanca),
// both (hooks HTTP de settings y mod a la vez: compara prompt_id con turn_id, U3), offline (servidor caido).
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MOD = path.resolve(HERE, '../..')
const PROTOCOL = path.resolve(MOD, 'protocol')
const CLAUDE = process.env.CLAUDE_BIN ?? path.join(os.homedir(), '.local/bin/claude')
const MODEL = process.env.ORBIT_MODEL ?? 'haiku'
const TMP = fs.mkdtempSync(path.join(process.env.ORBIT_TMP ?? os.tmpdir(), 'orbit-m-'))
const require = createRequire(path.join(MOD, 'package.json'))
const Ajv2020 = require('ajv/dist/2020.js').default ?? require('ajv/dist/2020.js')

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false, strictTuples: false })
ajv.addKeyword('x-unverified')
for (const n of ['hook-payload', 'ingest']) ajv.addSchema(JSON.parse(fs.readFileSync(path.join(PROTOCOL, `schema/${n}.schema.json`), 'utf8')), `${n}.schema.json`)
const validateIngest = ajv.getSchema('ingest.schema.json')

// El mod usa `modules`: con claude < 2.1.296 (p. ej. /opt/homebrew/bin/claude 2.1.236) carga sin avisar y
// no emite nada. Comprobar el binario antes de gastar modelo.
const MIN_CLAUDE = [2, 1, 296]
{
  const v = spawnSync(CLAUDE, ['--version'], { encoding: 'utf8' })
  const got = /(\d+)\.(\d+)\.(\d+)/.exec(v.stdout ?? '')?.slice(1).map(Number)
  const ok = got && (got[0] - MIN_CLAUDE[0] || got[1] - MIN_CLAUDE[1] || got[2] - MIN_CLAUDE[2]) >= 0
  if (!ok) {
    console.error(`claude "${CLAUDE}" no sirve: version ${got?.join('.') ?? 'desconocida'}, se necesita >= ${MIN_CLAUDE.join('.')} (usa CLAUDE_BIN=...)`)
    process.exit(2)
  }
}

let failures = 0
const findings = []
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++ }

if (!fs.existsSync(path.join(MOD, 'dist/hosts/claude/register.js'))) {
  console.error('falta mod/dist: ejecuta `npm --prefix mod run build` antes'); process.exit(2)
}

// ---- servidor stub --------------------------------------------------------------------------------
const TOKEN = 'e2e-token'
let received = [] // { kind: 'mod'|'hook', auth, body, valid?, errors? }
let mode = 'ok'
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => (body += c))
  req.on('end', () => {
    const u = new URL(req.url, 'http://x')
    if (mode === 'down') { res.statusCode = 503; return res.end('down') }
    if (req.method === 'POST' && u.pathname === '/v0/ingest') {
      const j = JSON.parse(body)
      const valid = validateIngest(j)
      received.push({ kind: 'mod', auth: req.headers.authorization, body: j, valid, errors: valid ? undefined : validateIngest.errors })
      res.statusCode = req.headers.authorization === `Bearer ${TOKEN}` ? 200 : 401
      return res.end('{}')
    }
    const m = /^\/v0\/ingest\/hook\/([a-z0-9-]+)$/.exec(u.pathname)
    if (req.method === 'POST' && m) { received.push({ kind: 'hook', instance: m[1], body: JSON.parse(body) }); return res.end('{}') }
    res.statusCode = 404; res.end()
  })
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const URL_BASE = `http://127.0.0.1:${server.address().port}`

// ---- helpers --------------------------------------------------------------------------------------
function run(name, prompt, { env = {}, extra = [] } = {}) {
  const dir = path.join(TMP, name)
  fs.mkdirSync(dir, { recursive: true })
  const mcp = path.join(dir, 'mcp.json')
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { echo: { command: 'node', args: [path.join(HERE, 'mcp-echo.mjs')] } } }))
  const args = ['-p', prompt, '--plugin-dir', MOD, '--model', MODEL, '--mcp-config', mcp, '--strict-mcp-config',
    '--permission-mode', 'default', '--no-session-persistence', '--output-format', 'stream-json', '--verbose',
    '--debug-file', path.join(dir, 'debug.log'),
    // Sin settings de usuario: su bloque `env` PISA a process.env (ORBIT_CTX=work exportado se ignoraria
    // y los prompts saldrian con ctx=personal al servidor real). ORBIT_E2E_USER_SETTINGS=1 los carga.
    ...(process.env.ORBIT_E2E_USER_SETTINGS ? [] : ['--setting-sources', 'project,local']), ...extra]
  return new Promise(resolve => {
    const p = spawn(CLAUDE, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ORBIT_URL: URL_BASE, ORBIT_TOKEN: TOKEN, ORBIT_INSTANCE_ID: 'e2e-mac', ORBIT_CTX: 'personal', ...env } })
    let out = '', err = ''
    p.stdout.on('data', c => (out += c)); p.stderr.on('data', c => (err += c))
    const killer = setTimeout(() => p.kill('SIGKILL'), 180000)
    p.on('close', code => { clearTimeout(killer); resolve({ dir, code, out, err }) })
  })
}
const modEvents = () => received.filter(r => r.kind === 'mod').flatMap(r => r.body.events.map(e => ({ ...e, ctx: r.body.ctx })))
const names = evs => evs.map(e => e.ev.hook_event_name)
const PROMPT = (file) => `Do these steps in order:
1. Call the tool mcp__echo__echo with text "from-main".
2. Use the Agent tool (subagent_type "general-purpose") with a prompt telling it to call mcp__echo__echo with text "from-subagent" and then reply "ok".
3. Use the Bash tool exactly once to run: touch ${file}   (do not retry if refused)
4. Reply with the single word: finished.`
const ALLOWED = ['--allowedTools', 'mcp__echo__echo,Agent,Task']

// ---- escenarios -----------------------------------------------------------------------------------
console.log('\n== personal ==')
received = []
const target = path.join(TMP, 'target.txt')
const personal = await run('personal', PROMPT(target), { extra: ALLOWED })
const evs = modEvents()
check('personal: el proceso termina bien', personal.code === 0, `exit=${personal.code}`)
check('personal: llegaron sobres a /v0/ingest', received.some(r => r.kind === 'mod'), `sobres=${received.length} eventos=${evs.length}`)
check('personal: todos los sobres validan contra ingest.schema.json', received.filter(r => r.kind === 'mod').every(r => r.valid), JSON.stringify(received.find(r => r.kind === 'mod' && !r.valid)?.errors?.slice(0, 2) ?? ''))
check('personal: Authorization Bearer correcto', received.filter(r => r.kind === 'mod').every(r => r.auth === `Bearer ${TOKEN}`))
check('personal: instance_id/ctx/src del sobre', received.filter(r => r.kind === 'mod').every(r => r.body.instance_id === 'e2e-mac' && r.body.ctx === 'personal' && r.body.src === 'mod'))
const ns = evs.map(e => e.n)
check('personal: n estrictamente creciente y sin repetidos', ns.length > 0 && ns.every((n, i) => i === 0 || n > ns[i - 1]), `n=${ns[0]}..${ns[ns.length - 1]}`)
const hn = names(evs)
for (const h of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd']) check(`personal: llega ${h}`, hn.includes(h))
check('personal: llega PermissionRequest (Bash pide permiso)', evs.some(e => e.ev.hook_event_name === 'PermissionRequest' && e.ev.tool_name === 'Bash'))
check('personal: el Bash no se ejecutó (el mod no retiene ni aprueba)', !fs.existsSync(target))
const agentCall = evs.find(e => e.ev.hook_event_name === 'PreToolUse' && e.ev.tool_name === 'Agent')
const sub = evs.find(e => e.ev.hook_event_name === 'SubagentStart')
check('personal: SubagentStart enlazado al tool Agent (parent_tool_use_id)', !!sub && !!agentCall && sub.ev.parent_tool_use_id === agentCall.ev.tool_use_id, sub ? `agent=${sub.ev.agent_id}` : '')
check('personal: tool del subagente lleva agent_id', evs.some(e => e.ev.hook_event_name === 'PreToolUse' && e.ev.tool_name === 'mcp__echo__echo' && e.ev.agent_id))
check('personal: PostToolUse no copia texto del resultado', !JSON.stringify(evs.filter(e => e.ev.hook_event_name === 'PostToolUse')).includes('echo: from-main'))
check('personal: en ctx=personal viajan prompt y tool_input', evs.some(e => typeof e.ev.prompt === 'string') && evs.some(e => e.ev.tool_input?.text === 'from-main'))
const stopEv = evs.filter(e => e.ev.hook_event_name === 'Stop').pop()
check('personal: Stop con last_assistant_message y usage', typeof stopEv?.ev.last_assistant_message === 'string' && !!stopEv?.ev.usage)
const session = evs.find(e => e.ev.session_id)?.ev.session_id
check('personal: session_id consistente en todos los eventos', evs.every(e => e.ev.session_id === session), session)

console.log('\n== /orbit ==')
const cmd = await run('command', '/orbit')
check('orbit: muestra estado', /estado: (conectado|listo|eventos pendientes)/.test(cmd.out), (cmd.out.match(/estado: [^"\\]*/) ?? [''])[0])
check('orbit: muestra cola y último error', /cola: \d+ eventos/.test(cmd.out) && /último error/.test(cmd.out))
check('orbit: no filtra el token', !cmd.out.includes(TOKEN))
const pause = await run('pause', '/orbit pause')
check('orbit pause: confirma la pausa', /en pausa/.test(pause.out))
received = []
const paused = await run('paused-run', 'Reply with the single word: hi')
check('orbit pause: con la pausa persistida no se envía nada', !received.some(r => r.kind === 'mod'), `sobres=${received.length}`)
const resume = await run('resume', '/orbit resume')
check('orbit resume: reanuda y los eventos retenidos se envían', /reanudado/.test(resume.out))
void paused

console.log('\n== work ==')
received = []
const work = await run('work', PROMPT(path.join(TMP, 'target-w.txt')), { extra: ALLOWED, env: { ORBIT_CTX: 'work' } })
const wev = modEvents()
check('work: el proceso termina bien', work.code === 0)
check('work: llegaron eventos con ctx=work', wev.length > 0 && wev.every(e => e.ctx === 'work'))
check('work: sobres válidos (incluye lista blanca del schema)', received.filter(r => r.kind === 'mod').every(r => r.valid), JSON.stringify(received.find(r => r.kind === 'mod' && !r.valid)?.errors?.slice(0, 2) ?? ''))
const body = JSON.stringify(received)
check('work: no sale ningún prompt, tool_input, cwd ni texto del modelo', !/from-main|from-subagent|Do these steps|touch |"cwd"|"prompt"|tool_input|last_assistant_message|"usage"/.test(body))

console.log('\n== both (hooks HTTP de settings + mod; U3) ==')
received = []
const settings = path.join(TMP, 'settings-hooks.json')
const hookEntry = [{ matcher: '', hooks: [{ type: 'http', url: `${URL_BASE}/v0/ingest/hook/e2e-mac` }] }]
fs.writeFileSync(settings, JSON.stringify({ hooks: Object.fromEntries(['UserPromptSubmit', 'Stop', 'SessionEnd', 'PostToolUse'].map(k => [k, hookEntry])) }))
const both = await run('both', 'Reply with the single word: hello', { extra: ['--settings', settings] })
const hooks = received.filter(r => r.kind === 'hook').map(r => r.body)
const bm = modEvents()
check('both: el proceso termina bien', both.code === 0)
console.log(`      info: hooks=${hooks.length} (${[...new Set(hooks.map(h => h.hook_event_name))].join(',')}) mod=${bm.length}`)
const hp = hooks.find(h => h.hook_event_name === 'UserPromptSubmit')
const mp = bm.find(e => e.ev.hook_event_name === 'UserPromptSubmit')
if (hp && mp) {
  const same = hp.prompt_id === mp.ev.turn_id
  findings.push(`U3: prompt_id (hook) ${same ? '==' : '!='} turnId (mod): hook=${hp.prompt_id} mod=${mp.ev.turn_id}`)
  console.log(`      U3: prompt_id=${hp.prompt_id} turn_id=${mp.ev.turn_id} -> ${same ? 'COINCIDEN' : 'DISTINTOS'}`)
} else findings.push(`U3: sin datos (hooks UserPromptSubmit=${!!hp}, mod UserPromptSubmit=${!!mp})`)

console.log('\n== offline (servidor caido) ==')
received = []
mode = 'down'
const off = await run('offline', 'Reply with the single word: hi')
check('offline: el servidor caido no rompe la sesion', off.code === 0, `exit=${off.code}`)
mode = 'ok'
const after = await run('after-offline', '/orbit')
check('offline: /orbit tras el fallo informa de la cola o del error', /cola: \d+ eventos/.test(after.out))
const flushed = modEvents()
const fn = flushed.map(e => e.n)
const sessions = new Set(flushed.map(e => e.ev.session_id))
check('offline: al volver el servidor la cola persistida se reenvía (otra sesión) en orden de n', sessions.size >= 2 && fn.every((n, i) => i === 0 || n > fn[i - 1]), `eventos=${fn.length} sesiones=${sessions.size}`)
const clean = await run('cleanup', '/orbit')
check('cleanup: solo queda en cola el SessionStart de la propia sesión, sin pausa', /cola: [01] eventos/.test(clean.out) && !/en pausa/.test(clean.out), (clean.out.match(/cola: \d+ eventos/) ?? [''])[0])

server.close()
console.log('\nfindings:\n  ' + findings.join('\n  '))
fs.writeFileSync(path.join(TMP, 'findings.txt'), findings.join('\n'))
if (process.env.ORBIT_KEEP) console.log(`temp dir: ${TMP}`); else fs.rmSync(TMP, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
