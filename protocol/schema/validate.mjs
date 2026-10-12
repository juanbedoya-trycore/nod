// Valida los schemas de Orbit 0.2.0 contra los fixtures reales y los ejemplos.
// Uso: node protocol/schema/validate.mjs   (sale con 1 si algo falla)
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'

const here = dirname(fileURLToPath(import.meta.url))
const raw = join(here, '..', 'fixtures', 'raw')
const load = (p) => JSON.parse(readFileSync(p, 'utf8'))

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false, strictTuples: false })
ajv.addKeyword('x-unverified')
const names = ['hook-payload', 'ingest', 'frame', 'http-api', 'mod-engine-event']
for (const n of names) ajv.addSchema(load(join(here, `${n}.schema.json`)), `${n}.schema.json`)
const get = (schema, def) => {
  const ref = def ? `${schema}.schema.json#/$defs/${def}` : `${schema}.schema.json`
  const v = ajv.getSchema(ref)
  if (!v) throw new Error(`schema no encontrado: ${ref}`)
  return v
}
const SCHEMA = { hook: 'hook-payload', ingest: 'ingest', frame: 'frame', http: 'http-api' }

let fail = 0
let pass = 0
const check = (label, ok, errors) => {
  if (ok) { pass++; return }
  fail++
  console.error(`FALLO ${label}`, errors ? JSON.stringify(errors.slice(0, 3)) : '')
}

// Lista blanca ctx=work (SPEC 3.4); debe coincidir con ingest.schema.json#/$defs/workAllowlist.
const WORK = load(join(here, 'ingest.schema.json')).$defs.workAllowlist.propertyNames.enum
const redactWork = (ev) => Object.fromEntries(Object.entries(ev).filter(([k]) => WORK.includes(k)))
const envelope = (ctx, evs) => ({
  orbit: '0.2.0', instance_id: 'mac-test', ctx, src: 'hook',
  events: evs.map((ev, n) => ({ n, rx: 1791683884071 + n, ev })),
})

// 1. Fixtures reales de hooks (S2).
const hookDir = join(raw, 'hooks')
const hookFiles = readdirSync(hookDir).filter((f) => f.endsWith('.json')).sort()
if (hookFiles.length === 0) { console.error('FALLO no hay fixtures de hooks'); process.exit(1) }
const vHook = get('hook-payload')
const vIngest = get('ingest')
const payloads = []
for (const f of hookFiles) {
  const p = load(join(hookDir, f)).payload
  const expected = f.replace(/-\d+\.json$/, '')
  check(`${f}: hook_event_name=${p?.hook_event_name} != nombre de fichero`, p?.hook_event_name === expected)
  check(`hooks/${f} vs hook-payload`, vHook(p), vHook.errors)
  payloads.push(p)
}
check('fixtures hooks como lote ctx=personal', vIngest(envelope('personal', payloads)), vIngest.errors)
check('fixtures hooks redactados como lote ctx=work', vIngest(envelope('work', payloads.map(redactWork))), vIngest.errors)
// Sin redactar, ctx=work debe rechazarse (todos los fixtures llevan cwd/transcript_path).
for (const [i, p] of payloads.entries()) {
  const ok = vIngest(envelope('work', [p]))
  check(`hooks/${hookFiles[i]} sin redactar debe fallar con ctx=work`, !ok)
}

// 2. Fixtures reales del mod (S1): entrada del traductor.
const vMod = get('mod-engine-event')
const modDir = join(raw, 'mod')
let modLines = 0
for (const f of readdirSync(modDir).filter((f) => f.endsWith('.events.jsonl')).sort()) {
  const lines = readFileSync(join(modDir, f), 'utf8').split('\n').filter(Boolean)
  for (const [i, l] of lines.entries()) {
    modLines++
    check(`mod/${f}:${i + 1} vs mod-engine-event`, vMod(JSON.parse(l)), vMod.errors)
  }
}
if (modLines === 0) { console.error('FALLO no hay fixtures del mod'); process.exit(1) }

// 3. Ejemplos: valid/ debe pasar, invalid/ debe fallar.
for (const kind of ['valid', 'invalid']) {
  const dir = join(here, 'examples', kind)
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const ex = load(join(dir, f))
    const v = get(SCHEMA[ex.schema], ex.def)
    const ok = v(ex.data)
    check(`examples/${kind}/${f}`, kind === 'valid' ? ok : !ok, kind === 'valid' ? v.errors : null)
  }
}

console.log(`hooks=${hookFiles.length} mod_lines=${modLines} checks_ok=${pass} checks_fail=${fail}`)
process.exit(fail ? 1 : 0)
