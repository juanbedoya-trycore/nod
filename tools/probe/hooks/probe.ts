// Nod fase 0: registra en NOD_PROBE_LOG (JSONL) cada evento que ve el motor, con su payload recortado.
// Sirve para validar los nombres y campos reales antes de fijar el esquema Nod v1. Sin NOD_PROBE_LOG no hace nada.
import type { Register } from 'claude-code'

const MAX = 600
const NOISE = /^(env\.|clock\.|fs\.|process\.|http\.|store\.|ui\.|tool\.(describe|list|register)|command\.(describe|list|register)|prompt\.(section|context|compose|autocomplete|suggest|mention|fill)|settings\.|skill\.|attribution\.|plugin\.|engine\.|agent\.offer|session\.(measure|surfaces))/
let queue: Promise<unknown> = Promise.resolve()

function clip(v: unknown, d = 0): unknown {
  if (typeof v === 'string') return v.length > MAX ? v.slice(0, MAX) + `…[+${v.length - MAX}]` : v
  if (v === null || typeof v !== 'object') return v
  if (d > 5) return '[deep]'
  if (Array.isArray(v)) return v.slice(0, 20).map(x => clip(x, d + 1))
  const o: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = typeof x === 'function' ? '[fn]' : clip(x, d + 1)
  return o
}

function write($: any, phase: string, event: string, data: unknown) {
  queue = queue.then(async () => {
    const file = await $.env.get('NOD_PROBE_LOG')
    if (!file) return
    const line = JSON.stringify({ ts: await $.clock.now(), phase, event, data: clip(data) }) + '\n'
    await $.process.run(['tee', '-a', file], { stdin: line }).catch(() => undefined)
  })
  return queue
}

export const register: Register = (on) => {
  on('*', async ($, e, next) => {
    const name = String(next.event)
    if (NOISE.test(name)) return next(e)
    await write($, 'in', name, e)
    const out = await next(e)
    await write($, 'out', name, out)
    return out
  })
}
