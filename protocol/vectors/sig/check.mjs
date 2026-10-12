// Oráculo independiente de los vectores de firma (SPEC §6.3, protocol/docs/pairing.md).
//   node protocol/vectors/sig/check.mjs
// No usa el código de Kotlin ni el del mod: CBOR con cbor2 (cde) y ECDSA con node:crypto (OpenSSL).
// Comprueba que cada vector dice la verdad: que las firmas "válidas" lo son de verdad, que las
// alteradas no, y que el resultado esperado sigue las condiciones de §6.3 (formato de firma 2: ph
// recalculado desde el pendiente, margen de 30 s) en el orden documentado.
// Los vectores los genera android/shared (SigVectors.kt); ver protocol/docs/pairing.md.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto'
import * as cbor from 'cbor2'

const dir = dirname(fileURLToPath(import.meta.url))
const load = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))
const B = (h) => Buffer.from(h, 'hex')
const problems = []
const fail = (m) => problems.push(m)

const SPKI_PREFIX = B('3059301306072a8648ce3d020106082a8648ce3d030107034200')
const N = BigInteger('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')
function BigInteger(h) { return BigInt('0x' + h) }
const kidOf = (spki) => createHash('sha256').update(spki).digest().subarray(0, 8).toString('hex')
function spkiOk(spki) {
  if (spki.length !== 91 || !spki.subarray(0, 26).equals(SPKI_PREFIX) || spki[26] !== 4) return false
  try { createPublicKey({ key: spki, format: 'der', type: 'spki' }); return true } catch { return false }
}

// ---------------------------------------------------------------- llaves
const keys = load('key.json').keys
const byName = new Map(keys.map((k) => [k.name, k]))
for (const k of keys) {
  const spki = B(k.spki)
  if (!spkiOk(spki)) fail(`key ${k.name}: SPKI no canónico`)
  if (kidOf(spki) !== k.kid) fail(`key ${k.name}: kid no es SHA-256(SPKI)[0..8]`)
  if (spki.subarray(27, 59).toString('hex') !== k.x || spki.subarray(59).toString('hex') !== k.y) fail(`key ${k.name}: x/y no cuadran con el SPKI`)
}

// ---------------------------------------------------------------- decisiones
function strictDecode(bytes) {
  const v = cbor.decode(bytes, cbor.cdeDecodeOptions)
  // cbor2 decodifica bstr como Buffer, y Buffer se re-codifica como objeto (toJSON): pasar a Uint8Array.
  const plain = (x) => (Array.isArray(x) ? x.map(plain) : x instanceof Uint8Array ? new Uint8Array(x) : x)
  const back = Buffer.from(cbor.encode(plain(v), cbor.cdeEncodeOptions))
  if (!back.equals(bytes)) throw new Error('no determinista')
  return v
}
const isBytes = (x, n) => x instanceof Uint8Array && x.length === n
function parseDec(bytes) {
  try {
    const a = strictDecode(bytes)
    if (!Array.isArray(a) || a.length !== 8 || a[0] !== 'dec') return null
    const [, nonce, tuid, decision, ts, kid, sig, ph] = a
    if (!isBytes(nonce, 16) || typeof tuid !== 'string' || !['allow', 'deny'].includes(decision)) return null
    if (!Number.isSafeInteger(ts) || ts < 0 || !isBytes(kid, 8) || !isBytes(sig, 64) || !isBytes(ph, 32)) return null
    return { nonce: Buffer.from(nonce), tuid, decision, ts, kid: Buffer.from(kid), sig: Buffer.from(sig), ph: Buffer.from(ph) }
  } catch { return null }
}
const cde = (v) => Buffer.from(cbor.encode(v, cbor.cdeEncodeOptions))
// Formato de firma 2 (SPEC §6.3).
const permHash = (p) => createHash('sha256').update(cde(['orbit-perm', 1, p.instance_id, new Uint8Array(B(p.nonce)), p.tool_use_id, p.tool, p.sum, p.wok, p.exp])).digest()
const signingInput = (d, ph) => cde(['orbit-dec', 2, new Uint8Array(d.nonce), d.tuid, d.decision, d.ts, new Uint8Array(ph)])
const SKEW = 30
function sigValid(spkiHex, msg, sig) {
  const r = BigInteger(sig.subarray(0, 32).toString('hex'))
  const s = BigInteger(sig.subarray(32).toString('hex'))
  if (r === 0n || s === 0n || r >= N || s >= N) return false
  try {
    const key = createPublicKey({ key: B(spkiHex), format: 'der', type: 'spki' })
    return verify('sha256', msg, { key, dsaEncoding: 'ieee-p1363' }, sig)
  } catch { return false }
}

const dv = load('decisions.json')
const paired = dv.paired
for (const p of paired) if (kidOf(B(p.spki)) !== p.kid) fail(`paired ${p.kid}: kid no corresponde al SPKI`)
// ph y entrada firmada de los golden vectors de nivel superior, recalculados desde frame-perm.json.
{
  const vec = (n) => JSON.parse(readFileSync(join(dir, '..', `${n}.json`), 'utf8'))
  const [, nonce, tuid, , exp, tool, sum, wok, instance] = vec('frame-perm').data
  const ph = permHash({ instance_id: instance, nonce: nonce.$hex, tool_use_id: tuid, tool, sum, wok, exp })
  if (ph.toString('hex') !== vec('perm-hash-entrada').ph) fail('el ph de perm-hash-entrada no es SHA-256 de los campos de frame-perm')
  const signingVector = readFileSync(join(dir, '..', 'dec-entrada-firmada.hex'), 'utf8').trim()
  if (signingInput({ nonce: B(nonce.$hex), tuid, decision: 'allow', ts: 1791683990 }, ph).toString('hex') !== signingVector) {
    fail('la entrada firmada no coincide con vectors/dec-entrada-firmada.hex')
  }
}
const WIRE = { malformed: 'malformed', nonce: 'nonce', tool_use_id: 'tool_use_id', ph: 'ph', replay: 'replay', kid: 'kid', sig: 'sig', 'expired-ts': 'expired', 'expired-now': 'expired', forbidden: 'forbidden' }
// Casos cuya trama se tocó DESPUÉS de firmar (la firma no verifica sobre el ph que lleva la trama).
const TOUCHED_AFTER_SIGNING = new Set(['nonce-cambiado-tras-firmar', 'ph-cambiado'])
const causes = new Set()
for (const c of dv.cases) {
  const d = parseDec(B(c.dec))
  const p = c.pending
  let cause = null
  if (!d) cause = 'malformed'
  else if (d.nonce.toString('hex') !== p.nonce) cause = 'nonce'
  else if (p.resolved) cause = 'replay'
  else if (d.tuid !== p.tool_use_id) cause = 'tool_use_id'
  else {
    // El ph que cuenta es el del pendiente; el de la trama solo se compara.
    const ph = permHash(p)
    const key = paired.find((k) => k.kid === d.kid.toString('hex') && kidOf(B(k.spki)) === k.kid)
    if (!d.ph.equals(ph)) cause = 'ph'
    else if (!key) cause = 'kid'
    else if (!sigValid(key.spki, signingInput(d, ph), d.sig)) cause = 'sig'
    else if (d.ts > p.exp + SKEW) cause = 'expired-ts'
    else if (c.now > p.exp) cause = 'expired-now'
    else if (d.decision === 'allow' && !p.wok) cause = 'forbidden'
  }
  const want = c.expect === 'accept' ? null : c.cause
  if (cause !== want) fail(`decisions ${c.name}: el oráculo da ${cause ?? 'accept'}, el vector dice ${want ?? 'accept'}`)
  if (want !== null && c.reject !== WIRE[want]) fail(`decisions ${c.name}: reject ${c.reject} no corresponde a cause ${want}`)
  // 'signer' dice quién firmó de verdad: si la trama está intacta, la firma verifica con esa llave sobre
  // el ph que lleva la trama (lo que el reloj vio). Así los casos 'ph' son firmas honestas de otra cosa.
  if (d && c.signer) {
    const k = byName.get(c.signer)
    if (!k) fail(`decisions ${c.name}: signer desconocido ${c.signer}`)
    const intact = sigValid(k.spki, signingInput(d, d.ph), d.sig)
    const tampered = (want === 'sig' && c.signer === 'reloj') || TOUCHED_AFTER_SIGNING.has(c.name)
    if (intact === tampered) fail(`decisions ${c.name}: firma ${intact ? 'válida' : 'inválida'} con ${c.signer}, inesperado`)
  }
  // Los casos aceptados llevan exactamente el ph del pendiente.
  if (want === null && d && !d.ph.equals(permHash(p))) fail(`decisions ${c.name}: aceptado con un ph distinto del pendiente`)
  causes.add(want ?? 'accept')
}
for (const need of ['accept', 'malformed', 'nonce', 'tool_use_id', 'ph', 'replay', 'kid', 'sig', 'expired-ts', 'expired-now', 'forbidden']) {
  if (!causes.has(need)) fail(`decisions: falta un caso con resultado ${need}`)
}
// Casos nuevos de 0.2 (formato de firma 2) que deben existir con su resultado.
for (const [name, want] of [['ph-cambiado', 'ph'], ['tool-cambiado', 'ph'], ['sum-cambiado', 'ph'], ['wok-cambiado', 'ph'], ['instance-id-cambiado', 'ph'], ['formato-1', 'malformed'], ['formato-1-firma-con-ph', 'sig'], ['ts-exp-mas-30', 'accept'], ['ts-mayor-que-exp-mas-30', 'expired-ts']]) {
  const c = dv.cases.find((x) => x.name === name)
  if (!c) fail(`decisions: falta el caso ${name}`)
  else if ((c.expect === 'accept' ? 'accept' : c.cause) !== want) fail(`decisions ${name}: se esperaba ${want}`)
}

// ---------------------------------------------------------------- DER
const der = load('der.json')
const fixed = (x) => Buffer.from(x.toString(16).padStart(64, '0'), 'hex')
function minInt(buf) {
  let i = 0
  while (i < buf.length - 1 && buf[i] === 0) i++
  const t = buf.subarray(i)
  return t[0] & 0x80 ? Buffer.concat([Buffer.from([0]), t]) : t
}
function rawToDer(raw) {
  const r = minInt(raw.subarray(0, 32))
  const s = minInt(raw.subarray(32))
  const body = Buffer.concat([Buffer.from([2, r.length]), r, Buffer.from([2, s.length]), s])
  return Buffer.concat([Buffer.from([0x30, body.length]), body])
}
for (const c of der.valid) {
  const raw = B(c.raw)
  if (rawToDer(raw).toString('hex') !== c.der_min) fail(`der ${c.name}: der_min no es el DER mínimo de raw`)
  const s = BigInteger(raw.subarray(32).toString('hex'))
  const low = s > N >> 1n ? Buffer.concat([raw.subarray(0, 32), fixed(N - s)]) : raw
  if (low.toString('hex') !== c.raw_low_s) fail(`der ${c.name}: raw_low_s mal calculado`)
}
if (der.invalid.length < 10) fail('der: pocos casos inválidos')

// ---------------------------------------------------------------- huellas
const fp = load('fingerprint.json')
if (fp.words.length !== 256 || new Set(fp.words).size !== 256) fail('fingerprint: la lista no tiene 256 palabras distintas')
if (new Set(fp.words.map((w) => w.slice(0, 4))).size !== 256) fail('fingerprint: prefijos de 4 letras repetidos')
if (!fp.words.every((w) => /^[a-z]{3,6}$/.test(w))) fail('fingerprint: palabra no ASCII o de longitud fuera de 3..6')
for (const c of fp.cases) {
  if (c.spki !== null && kidOf(B(c.spki)) !== c.kid) fail(`fingerprint ${c.name}: kid`)
  if (c.kid.match(/.{4}/g).join(' ') !== c.hex) fail(`fingerprint ${c.name}: hex`)
  if ([...B(c.kid)].map((b) => fp.words[b]).join(' ') !== c.words.join(' ')) fail(`fingerprint ${c.name}: words`)
}
for (const c of fp.bad_spki) if (spkiOk(B(c.spki))) fail(`fingerprint bad_spki ${c.name}: el oráculo lo acepta`)

// ---------------------------------------------------------------- etiqueta del emparejamiento por QR (§6.3.1)
// tag = HMAC-SHA256(K, CBOR determinista de ["orbit-pair", 1, instance_id, spki]).
const pt = load('pair-tag.json')
for (const c of pt.cases) {
  const input = cde(['orbit-pair', 1, c.instance_id, new Uint8Array(B(c.spki))])
  if (input.toString('hex') !== c.input) fail(`pair-tag ${c.name}: input no es el CBOR determinista`)
  const want = createHmac('sha256', B(c.k)).update(input).digest()
  const tag = Buffer.from(c.tag, 'base64url')
  const ok = B(c.k).length === 32 && tag.length === 32 && timingSafeEqual(tag, want)
  if (ok !== c.expect) fail(`pair-tag ${c.name}: el oráculo da ${ok}, el vector dice ${c.expect}`)
}
for (const n of ['valido', 'otra-k', 'otra-spki', 'otra-instancia', 'tag-truncado']) if (!pt.cases.some((c) => c.name === n)) fail(`pair-tag: falta el caso ${n}`)

// ---------------------------------------------------------------- respuestas del reloj (§6.6, formato de say 2)
// sid = SHA-256(CBOR determinista de ["orbit-sid", 1, instance_id, session_id])[0..16]
// entrada firmada = CBOR determinista de ["orbit-say", 2, nonce, ts, instance_id, sid, kind, text]
// Orden: forma → instancia → sesión (sid) → kid → firma → ventana (−120 s, +30 s) → nonce.
const sv = load('say.json')
const sidOf = (inst, session) => createHash('sha256').update(cde(['orbit-sid', 1, inst, session])).digest().subarray(0, 16)
if (sv.format !== 2) fail(`say: formato ${sv.format}, se esperaba 2`)
if (sidOf(sv.instance, sv.session_id).toString('hex') !== sv.sid) fail('say: sid no es SHA-256(["orbit-sid", 1, instance, session_id])[0..16]')
function parseSay(bytes) {
  try {
    const a = strictDecode(bytes)
    if (!Array.isArray(a) || a.length !== 9 || a[0] !== 'say') return null
    const [, nonce, ts, inst, sid, kind, text, kid, sig] = a
    if (!isBytes(nonce, 16) || !Number.isSafeInteger(ts) || ts < 0 || typeof inst !== 'string' || !isBytes(sid, 16)) return null
    if (!['text', 'stop'].includes(kind) || typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1000) return null
    if (!isBytes(kid, 8) || !isBytes(sig, 64)) return null
    return { nonce, ts, inst, sid: Buffer.from(sid), kind, text, kid: Buffer.from(kid).toString('hex'), sig: Buffer.from(sig) }
  } catch { return null }
}
const sayPaired = keys.filter((k) => k.name === sv.key)
for (const c of sv.cases) {
  const s = parseSay(B(c.say))
  let reason = null
  if (s === null) reason = 'malformed'
  else if (s.inst !== sv.instance) reason = 'instance'
  else if (!s.sid.equals(sidOf(sv.instance, sv.session_id))) reason = 'session'
  else {
    const k = sayPaired.find((x) => x.kid === s.kid)
    if (k === undefined) reason = 'kid'
    else if (!sigValid(k.spki, cde(['orbit-say', 2, new Uint8Array(s.nonce), s.ts, s.inst, new Uint8Array(s.sid), s.kind, s.text]), s.sig)) reason = 'sig'
    else if (s.ts > sv.now + 30 || s.ts < sv.now - 120) reason = 'expired'
  }
  if ((reason === null) !== c.ok || (!c.ok && reason !== c.reason)) fail(`say ${c.name}: el oráculo da ${reason ?? 'ok'}, el vector dice ${c.ok ? 'ok' : c.reason}`)
  // Los rechazados por instancia o sesión llevan una firma válida: lo que los tumba es el sid/instancia, no la firma.
  if (s !== null && (c.reason === 'instance' || c.reason === 'session')) {
    const k = sayPaired.find((x) => x.kid === s.kid)
    if (!k || !sigValid(k.spki, cde(['orbit-say', 2, new Uint8Array(s.nonce), s.ts, s.inst, new Uint8Array(s.sid), s.kind, s.text]), s.sig)) fail(`say ${c.name}: la firma debería ser válida`)
  }
}
for (const n of ['texto válido', 'stop válido', 'otra llave', 'otra instancia', 'otra sesión', 'viejo', 'formato 1']) if (!sv.cases.some((c) => c.name === n)) fail(`say: falta el caso ${n}`)

if (problems.length) {
  for (const p of problems) console.error(`FALLO ${p}`)
  process.exit(1)
}
console.log(`sig check ok: ${dv.cases.length} decisiones, ${der.valid.length + der.invalid.length} DER, ${fp.cases.length} huellas, ${pt.cases.length} etiquetas de emparejamiento, ${sv.cases.length} respuestas del reloj`)
