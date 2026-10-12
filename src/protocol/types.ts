/**
 * Tipos del protocolo Orbit 0.2.0 (SPEC §4, §5, §6, §8) con su conversión a/desde
 * valores CBOR. La validación replica protocol/schema/frame.schema.json (normativo).
 */

import { type CborValue, ProtocolError, decodeStrict, encode } from "./cbor.js";

export const PROTOCOL_VERSION_STRING = "0.2.0";

const U32 = 0xffffffff;
const U53 = Number.MAX_SAFE_INTEGER;
const utf8 = new TextEncoder();

export const NODE_TYPES = ["session", "agent", "task", "mcp"] as const;
export const STATUSES = ["run", "perm", "done", "err"] as const;
/** Motivo de `stuck` (0.2.3, SPEC §4.5); `none` retira el atasco. */
export const STUCK_WHYS = ["idle", "loop", "none"] as const;
export type StuckWhy = (typeof STUCK_WHYS)[number];
export const DECISIONS = ["allow", "deny"] as const;
export const PCLOSE_BY = ["watch", "terminal", "timeout", "rule", "abort"] as const;
export const PCLOSE_DECISIONS = ["allow", "deny", "none"] as const;
export const TEXT_FIELDS = ["cmd", "prompt", "answer", "result", "reason"] as const;

export type NodeType = (typeof NODE_TYPES)[number];
export type Status = (typeof STATUSES)[number];
export type Decision = (typeof DECISIONS)[number];
export type PcloseBy = (typeof PCLOSE_BY)[number];
export type PcloseDecision = (typeof PCLOSE_DECISIONS)[number];
export type TextField = (typeof TEXT_FIELDS)[number];

/** Nodo de un snap: `[id, t, p, s, k, m, ts]`. */
export interface Node {
  id: number;
  t: NodeType;
  p: number;
  s: Status;
  k: string;
  m: number;
  ts: number;
}

/** Op de un delta. `add.m` ausente = forma corta de 5 elementos (sin MCP). */
export type Op =
  | { op: "snap"; nodes: Node[] }
  | { op: "add"; id: number; t: NodeType; p: number; k: string; m?: number }
  | { op: "st"; id: number; s: Status }
  | { op: "rm"; id: number }
  | { op: "meta"; session: number; inTok: number; outTok: number; turns: number }
  /** Sesión atascada (0.2.3, SPEC §4.5): `since` en s, `k` la herramienta, `n` repeticiones seguidas. */
  | { op: "stuck"; session: number; why: StuckWhy; since: number; k: string; n: number }
  /** Op con nombre desconocido: se conserva tal cual y el cliente la ignora (SPEC §5.3). */
  | { op: "unknown"; raw: CborValue[] };

export type Frame =
  | { type: "hello"; version: string; epoch: number; seq: number }
  | { type: "d"; epoch: number; seq: number; ts: number; ops: Op[] }
  | { type: "req"; epoch: number; lastSeq: number }
  | {
      type: "perm";
      nonce: Uint8Array;
      toolUseId: string;
      id: number;
      exp: number;
      tool: string;
      sum: string;
      wok: boolean;
      /** Instancia dueña del permiso (0.2). Entra en `ph` (SPEC §6.3). */
      instanceId: string;
    }
  | { type: "pclose"; nonce: Uint8Array; by: PcloseBy; decision: PcloseDecision }
  | {
      type: "dec";
      nonce: Uint8Array;
      toolUseId: string;
      decision: Decision;
      ts: number;
      kid: Uint8Array;
      sig: Uint8Array;
      /** SHA-256 de la entrada de `ph` (32 bytes). Solo diagnóstico: el mod lo recalcula. */
      ph: Uint8Array;
    }
  | { type: "text"; epoch: number; id: number; f: TextField; text: string; trunc: boolean; red: boolean };

/** Versión del formato de firma (SPEC §6.3). El formato 1 ya no se acepta. */
export const SIGNATURE_FORMAT = 2;

/** Entrada firmada (formato 2): `["orbit-dec", 2, nonce, tool_use_id, decision, ts, ph]` (SPEC §6.3). */
export interface SigningInput {
  nonce: Uint8Array;
  toolUseId: string;
  decision: Decision;
  ts: number;
  ph: Uint8Array;
}

/**
 * Entrada de `ph`: `["orbit-perm", 1, instance_id, nonce, tool_use_id, tool, sum, wok, exp]` (SPEC §6.3).
 * `ph` = SHA-256 de su CBOR determinista: lo que el reloj muestra y firma.
 */
export interface PermHashInput {
  instanceId: string;
  nonce: Uint8Array;
  toolUseId: string;
  tool: string;
  sum: string;
  wok: boolean;
  exp: number;
}

const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// ---------- helpers de lectura ----------

function bad(msg: string): never {
  throw new ProtocolError("schema", msg);
}

function arr(v: CborValue | undefined, what: string): CborValue[] {
  if (!Array.isArray(v)) return bad(`${what}: se esperaba array`);
  return v;
}

function exactLen(a: CborValue[], n: number, what: string): void {
  if (a.length !== n) bad(`${what}: se esperaban ${n} elementos, hay ${a.length}`);
}

function uint(v: CborValue | undefined, min: number, max: number, what: string): number {
  if (typeof v !== "number") return bad(`${what}: se esperaba uint`);
  if (v < min || v > max) return bad(`${what}: fuera de rango ${min}..${max}`);
  return v;
}

function str(v: CborValue | undefined, what: string): string {
  if (typeof v !== "string") return bad(`${what}: se esperaba tstr`);
  return v;
}

function strMaxBytes(v: CborValue | undefined, max: number, what: string): string {
  const s = str(v, what);
  if (utf8.encode(s).length > max) bad(`${what}: más de ${max} bytes UTF-8`);
  return s;
}

function bytesN(v: CborValue | undefined, n: number, what: string): Uint8Array {
  if (!(v instanceof Uint8Array)) return bad(`${what}: se esperaba bstr`);
  if (v.length !== n) bad(`${what}: se esperaban ${n} bytes`);
  return v;
}

function bool(v: CborValue | undefined, what: string): boolean {
  if (typeof v !== "boolean") return bad(`${what}: se esperaba bool`);
  return v;
}

function oneOf<T extends string>(v: CborValue | undefined, set: readonly T[], what: string): T {
  const s = str(v, what);
  const found = set.find((x) => x === s);
  if (found === undefined) return bad(`${what}: valor desconocido ${JSON.stringify(s)}`);
  return found;
}

function toolUseId(v: CborValue | undefined): string {
  const s = str(v, "tool_use_id");
  const chars = Array.from(s).length;
  if (chars < 1 || chars > 64) bad("tool_use_id: longitud 1..64");
  return s;
}

function instanceId(v: CborValue | undefined, what: string): string {
  const s = str(v, what);
  if (!INSTANCE_ID_RE.test(s)) bad(`${what}: no cumple ^[a-z0-9][a-z0-9-]{0,31}$`);
  return s;
}

const label = (v: CborValue | undefined, what: string): string => strMaxBytes(v, 32, what);
const u32 = (v: CborValue | undefined, min: number, what: string): number => uint(v, min, U32, what);
const u53 = (v: CborValue | undefined, what: string): number => uint(v, 0, U53, what);

// ---------- nodo y ops ----------

export function parseNode(v: CborValue): Node {
  const a = arr(v, "node");
  exactLen(a, 7, "node");
  return {
    id: u32(a[0], 1, "node.id"),
    t: oneOf(a[1], NODE_TYPES, "node.t"),
    p: u32(a[2], 0, "node.p"),
    s: oneOf(a[3], STATUSES, "node.s"),
    k: label(a[4], "node.k"),
    m: u32(a[5], 0, "node.m"),
    ts: u53(a[6], "node.ts"),
  };
}

export function nodeToCbor(n: Node): CborValue {
  return [n.id, n.t, n.p, n.s, n.k, n.m, n.ts];
}

export function parseOp(v: CborValue): Op {
  const a = arr(v, "op");
  if (a.length === 0) return bad("op vacía");
  const name = str(a[0], "op[0]");
  switch (name) {
    case "snap":
      exactLen(a, 2, "snap");
      return { op: "snap", nodes: arr(a[1], "snap.nodes").map(parseNode) };
    case "add": {
      if (a.length < 5 || a.length > 6) return bad("add: 5 o 6 elementos");
      const base = {
        op: "add" as const,
        id: u32(a[1], 1, "add.id"),
        t: oneOf(a[2], NODE_TYPES, "add.t"),
        p: u32(a[3], 0, "add.p"),
        k: label(a[4], "add.k"),
      };
      // m explícito exige >= 1: la forma sin MCP es la de 5 elementos.
      return a.length === 6 ? { ...base, m: u32(a[5], 1, "add.m") } : base;
    }
    case "st":
      exactLen(a, 3, "st");
      return { op: "st", id: u32(a[1], 1, "st.id"), s: oneOf(a[2], STATUSES, "st.s") };
    case "rm":
      exactLen(a, 2, "rm");
      return { op: "rm", id: u32(a[1], 1, "rm.id") };
    case "meta":
      exactLen(a, 5, "meta");
      return {
        op: "meta",
        session: u32(a[1], 1, "meta.session"),
        inTok: u53(a[2], "meta.in_tok"),
        outTok: u53(a[3], "meta.out_tok"),
        turns: u32(a[4], 0, "meta.turns"),
      };
    case "stuck":
      exactLen(a, 6, "stuck");
      return {
        op: "stuck",
        session: u32(a[1], 1, "stuck.session"),
        why: oneOf(a[2], STUCK_WHYS, "stuck.why"),
        since: u53(a[3], "stuck.since"),
        k: label(a[4], "stuck.k"),
        n: u32(a[5], 0, "stuck.n"),
      };
    default:
      return { op: "unknown", raw: a };
  }
}

export function opToCbor(o: Op): CborValue {
  switch (o.op) {
    case "snap":
      return ["snap", o.nodes.map(nodeToCbor)];
    case "add":
      return o.m === undefined ? ["add", o.id, o.t, o.p, o.k] : ["add", o.id, o.t, o.p, o.k, o.m];
    case "st":
      return ["st", o.id, o.s];
    case "rm":
      return ["rm", o.id];
    case "meta":
      return ["meta", o.session, o.inTok, o.outTok, o.turns];
    case "stuck":
      return ["stuck", o.session, o.why, o.since, o.k, o.n];
    case "unknown":
      return o.raw;
  }
}

// ---------- tramas ----------

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;

export function parseFrame(v: CborValue): Frame {
  const a = arr(v, "trama");
  if (a.length === 0) return bad("trama vacía");
  const kind = str(a[0], "trama[0]");
  switch (kind) {
    case "hello": {
      exactLen(a, 4, "hello");
      const version = str(a[1], "hello.version");
      if (!SEMVER.test(version)) bad("hello.version: no es MAJOR.MINOR.PATCH");
      return { type: "hello", version, epoch: u32(a[2], 0, "hello.epoch"), seq: u53(a[3], "hello.seq") };
    }
    case "d": {
      exactLen(a, 5, "delta");
      const ops = arr(a[4], "delta.ops").map(parseOp);
      if (ops.some((o) => o.op === "snap") && ops.length !== 1) {
        bad("delta: snap debe ser la única op de su trama (SPEC §5.3)");
      }
      return {
        type: "d",
        epoch: u32(a[1], 0, "delta.epoch"),
        seq: u53(a[2], "delta.seq"),
        ts: u53(a[3], "delta.ts"),
        ops,
      };
    }
    case "req":
      exactLen(a, 4, "req");
      if (str(a[1], "req.what") !== "snap") bad('req: solo existe "snap"');
      return { type: "req", epoch: u32(a[2], 0, "req.epoch"), lastSeq: u53(a[3], "req.last_seq") };
    case "perm":
      exactLen(a, 9, "perm");
      return {
        type: "perm",
        nonce: bytesN(a[1], 16, "perm.nonce"),
        toolUseId: toolUseId(a[2]),
        id: u32(a[3], 0, "perm.id"),
        exp: u53(a[4], "perm.exp"),
        tool: label(a[5], "perm.tool"),
        sum: strMaxBytes(a[6], 200, "perm.sum"),
        wok: bool(a[7], "perm.wok"),
        instanceId: instanceId(a[8], "perm.instance_id"),
      };
    case "pclose":
      exactLen(a, 4, "pclose");
      return {
        type: "pclose",
        nonce: bytesN(a[1], 16, "pclose.nonce"),
        by: oneOf(a[2], PCLOSE_BY, "pclose.by"),
        decision: oneOf(a[3], PCLOSE_DECISIONS, "pclose.decision"),
      };
    case "dec":
      exactLen(a, 8, "dec");
      return {
        type: "dec",
        nonce: bytesN(a[1], 16, "dec.nonce"),
        toolUseId: toolUseId(a[2]),
        decision: oneOf(a[3], DECISIONS, "dec.decision"),
        ts: u53(a[4], "dec.ts"),
        kid: bytesN(a[5], 8, "dec.kid"),
        sig: bytesN(a[6], 64, "dec.sig"),
        ph: bytesN(a[7], 32, "dec.ph"),
      };
    case "text":
      exactLen(a, 7, "text");
      return {
        type: "text",
        epoch: u32(a[1], 0, "text.epoch"),
        id: u32(a[2], 1, "text.id"),
        f: oneOf(a[3], TEXT_FIELDS, "text.f"),
        text: strMaxBytes(a[4], 4096, "text.text"),
        trunc: bool(a[5], "text.trunc"),
        red: bool(a[6], "text.red"),
      };
    default:
      return bad(`trama desconocida ${JSON.stringify(kind)}`);
  }
}

export function frameToCbor(f: Frame): CborValue {
  switch (f.type) {
    case "hello":
      return ["hello", f.version, f.epoch, f.seq];
    case "d":
      return ["d", f.epoch, f.seq, f.ts, f.ops.map(opToCbor)];
    case "req":
      return ["req", "snap", f.epoch, f.lastSeq];
    case "perm":
      return ["perm", f.nonce, f.toolUseId, f.id, f.exp, f.tool, f.sum, f.wok, f.instanceId];
    case "pclose":
      return ["pclose", f.nonce, f.by, f.decision];
    case "dec":
      return ["dec", f.nonce, f.toolUseId, f.decision, f.ts, f.kid, f.sig, f.ph];
    case "text":
      return ["text", f.epoch, f.id, f.f, f.text, f.trunc, f.red];
  }
}

export function parseSigningInput(v: CborValue): SigningInput {
  const a = arr(v, "entrada firmada");
  exactLen(a, 7, "entrada firmada");
  if (str(a[0], "dominio") !== "orbit-dec") bad('entrada firmada: dominio distinto de "orbit-dec"');
  uint(a[1], SIGNATURE_FORMAT, SIGNATURE_FORMAT, "versión de formato de firma");
  return {
    nonce: bytesN(a[2], 16, "nonce"),
    toolUseId: toolUseId(a[3]),
    decision: oneOf(a[4], DECISIONS, "decision"),
    ts: u53(a[5], "ts"),
    ph: bytesN(a[6], 32, "ph"),
  };
}

export function signingInputToCbor(s: SigningInput): CborValue {
  return ["orbit-dec", SIGNATURE_FORMAT, s.nonce, s.toolUseId, s.decision, s.ts, s.ph];
}

export function parsePermHashInput(v: CborValue): PermHashInput {
  const a = arr(v, "entrada de ph");
  exactLen(a, 9, "entrada de ph");
  if (str(a[0], "dominio") !== "orbit-perm") bad('entrada de ph: dominio distinto de "orbit-perm"');
  uint(a[1], 1, 1, "versión de la entrada de ph");
  return {
    instanceId: instanceId(a[2], "instance_id"),
    nonce: bytesN(a[3], 16, "nonce"),
    toolUseId: toolUseId(a[4]),
    tool: label(a[5], "tool"),
    sum: strMaxBytes(a[6], 200, "sum"),
    wok: bool(a[7], "wok"),
    exp: u53(a[8], "exp"),
  };
}

export function permHashInputToCbor(p: PermHashInput): CborValue {
  return ["orbit-perm", 1, p.instanceId, p.nonce, p.toolUseId, p.tool, p.sum, p.wok, p.exp];
}

/** Codifica una trama a CBOR determinista. */
export function encodeFrame(f: Frame): Uint8Array {
  return encode(frameToCbor(f));
}

/** Decodifica una trama rechazando CBOR no determinista o con tipos prohibidos. */
export function decodeFrame(bytes: Uint8Array): Frame {
  return parseFrame(decodeStrict(bytes));
}
