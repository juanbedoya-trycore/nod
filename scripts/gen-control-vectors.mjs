#!/usr/bin/env node
// Genera vectors/control/ (docs/control-v1.md §5): llaves de prueba, ah, sid, tag y decisiones y mensajes
// firmados, con los casos que deben fallar. Las firmas son deterministas (RFC 6979), así que regenerar da
// lo mismo; `--check` falla si el contenido versionado no coincide.
//
// Usa el CBOR de Nod compilado (dist/): ejecutar después de `npm run build`.
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { encode } = await import(join(ROOT, "dist/core/control/cbor.js"));
const OUT = join(ROOT, "vectors/control");
const check = process.argv.includes("--check");

const hex = (b) => Buffer.from(b).toString("hex");
const b64u = (b) => Buffer.from(b).toString("base64url");
const utf8 = (s) => new TextEncoder().encode(s);
const SPKI_PREFIX = Uint8Array.from(Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"));

function testKey(name, seed) {
  const d = sha256(utf8(seed));
  const pub = p256.getPublicKey(d, false); // 65 bytes, 04‖x‖y
  const spki = new Uint8Array([...SPKI_PREFIX, ...pub]);
  return { name, seed, d: hex(d), spki: hex(spki), kid: hex(sha256(spki).slice(0, 8)), _d: d, _spki: spki };
}
const sign = (key, msg) => p256.sign(msg, key._d, { prehash: true, lowS: true, format: "compact" });

const KEYS = [testKey("aprobador", "nod-test-key-1"), testKey("otra", "nod-test-key-2")];
const [A, B] = KEYS;

// ---------- permiso (§3.1)
const base = {
  instance: "personal-3fa9c2d1",
  id: "000102030405060708090a0b0c0d0e0f",
  tool_use_id: "toolu_01Lxyasfhk5BJPRM5TsXUe9F",
  tool: "Bash",
  summary: "touch aprobado.txt",
  wok: true,
  exp: 1791839000,
};
const approvalInput = (p) => encode(["nod-approval", 1, p.instance, Buffer.from(p.id, "hex"), p.tool_use_id, p.tool, p.summary, p.wok, p.exp]);
const ahOf = (p) => sha256(approvalInput(p));
const decisionInput = (p, decision, ts) => encode(["nod-decision", 1, Buffer.from(p.id, "hex"), p.tool_use_id, decision, ts, ahOf(p)]);

function decisionCase(name, { pending = base, signer = A, decision = "allow", ts = base.exp - 10, signedOver, expect, sig }) {
  const input = decisionInput(signedOver ?? pending, decision, ts);
  const s = sig ?? sign(signer, input);
  return {
    name,
    pending,
    ah: hex(ahOf(pending)),
    signing_input: hex(input),
    decision: { decision, ts, kid: b64u(Buffer.from(signer.kid, "hex")), sig: b64u(s) },
    now: base.exp - 5,
    expect,
  };
}
const forbiddenPending = { ...base, tool_use_id: "toolu_forbidden", summary: "rm -rf build", wok: false };
const approvals = {
  spec: "docs/control-v1.md §3.1 y §4.1",
  note: "Emparejada: solo 'aprobador'. `now` en segundos Unix. `expect` = ok o el primer motivo de rechazo según el orden de §4.1.",
  paired: [A.kid],
  cases: [
    decisionCase("allow válido", { expect: "ok" }),
    decisionCase("deny válido", { decision: "deny", expect: "ok" }),
    decisionCase("llave no emparejada", { signer: B, expect: "kid" }),
    decisionCase("firma sobre otro resumen (el controlador cambió lo que vio el aprobador)", { signedOver: { ...base, summary: "ls" }, expect: "sig" }),
    decisionCase("firma sobre otro tool_use_id", { signedOver: { ...base, tool_use_id: "toolu_otro" }, expect: "sig" }),
    decisionCase("ts más allá de exp + 30", { ts: base.exp + 31, expect: "expired" }),
    decisionCase("ts en el margen (exp + 30)", { ts: base.exp + 30, expect: "ok" }),
    decisionCase("allow con wok false", { pending: forbiddenPending, expect: "forbidden" }),
    decisionCase("deny con wok false vale", { pending: forbiddenPending, decision: "deny", expect: "ok" }),
    decisionCase("firma de 63 bytes", { sig: new Uint8Array(63), expect: "malformed" }),
    decisionCase("decisión desconocida", { decision: "maybe", expect: "malformed" }),
  ],
};

// ---------- mensaje (§3.2)
const SESSION = "6d4bbffb-b890-4286-a3a4-88446add6682";
const sidOf = (instance, session) => sha256(encode(["nod-session", 1, instance, session])).slice(0, 16);
function messageCase(name, { kind = "text", text = "Continúa", ts = 1791839000, signer = A, sid = sidOf(base.instance, SESSION), id = "101112131415161718191a1b1c1d1e1f", expect }) {
  const input = encode(["nod-message", 1, Buffer.from(id, "hex"), ts, base.instance, sid, kind, text]);
  return {
    name,
    message: { id: b64u(Buffer.from(id, "hex")), ts, sid: b64u(sid), kind, text, kid: b64u(Buffer.from(signer.kid, "hex")), sig: b64u(sign(signer, input)) },
    signing_input: hex(input),
    expect,
  };
}
const messages = {
  spec: "docs/control-v1.md §3.2 y §4.2",
  instance: base.instance,
  session: SESSION,
  sid: hex(sidOf(base.instance, SESSION)),
  now: 1791839030,
  paired: [A.kid],
  cases: [
    messageCase("text válido", { expect: "ok" }),
    messageCase("stop válido", { kind: "stop", text: "", expect: "ok" }),
    messageCase("recap válido", { kind: "recap", text: "", expect: "ok" }),
    messageCase("otra sesión", { sid: sidOf(base.instance, "otra-sesion"), expect: "sid" }),
    messageCase("demasiado viejo (> 120 s)", { ts: 1791839030 - 121, expect: "expired" }),
    messageCase("llave no emparejada", { signer: B, expect: "kid" }),
    messageCase("tipo desconocido", { kind: "borrar", expect: "malformed" }),
  ],
};

// ---------- emparejamiento (§3.3)
const K = sha256(utf8("nod-test-pair-k"));
const tagOf = (k, instance, spki) => hmac(sha256, k, encode(["nod-pair", 1, instance, spki]));
const pairing = {
  spec: "docs/control-v1.md §3.3 y §4.3",
  k: b64u(K),
  instance: base.instance,
  cases: [
    { name: "válido", spki: b64u(A._spki), tag: b64u(tagOf(K, base.instance, A._spki)), expect: true },
    { name: "otro K", spki: b64u(A._spki), tag: b64u(tagOf(sha256(utf8("otro")), base.instance, A._spki)), expect: false },
    { name: "otra instancia", spki: b64u(A._spki), tag: b64u(tagOf(K, "otra-0000", A._spki)), expect: false },
    { name: "tag sobre otra llave", spki: b64u(B._spki), tag: b64u(tagOf(K, base.instance, A._spki)), expect: false },
  ],
};

const keys = {
  spec: "docs/control-v1.md §3",
  note: "Llaves de PRUEBA: d = SHA-256 de la semilla, que es pública. Nunca cuentan como emparejadas fuera de los tests.",
  keys: KEYS.map(({ _d, _spki, ...k }) => k),
};

const files = { "key.json": keys, "approval.json": approvals, "message.json": messages, "pairing.json": pairing };
mkdirSync(OUT, { recursive: true });
let bad = 0;
for (const [name, value] of Object.entries(files)) {
  const text = JSON.stringify(value, null, 2) + "\n";
  const path = join(OUT, name);
  if (check) {
    let old = "";
    try { old = readFileSync(path, "utf8"); } catch {}
    if (old !== text) { console.error(`vectors/control/${name} no coincide: npm run build && npm run vectors`); bad++; }
  } else writeFileSync(path, text);
}
if (bad > 0) process.exit(1);
if (!check) console.log(`vectors/control: ${Object.keys(files).join(", ")}`);
