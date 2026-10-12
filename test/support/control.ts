// Un aprobador y un controlador falsos para probar Nod Control: el aprobador firma con una llave P-256 propia
// (no de prueba: las de vectors/control/key.json nunca cuentan) y el controlador es un buzón en memoria que
// responde como docs/control-v1.md §4, con tiempos del reloj falso de vitest.
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { approvalHash, b64u, decisionInput, fromB64u, kidOf, messageInput, pairTag, sessionSid, SPKI_PREFIX } from "../../src/core/control/crypto.js";
import type { ApprovalData } from "../../src/core/control/crypto.js";
import type { ControlIo } from "../../src/core/control/io.js";
import type { PairedKey } from "../../src/core/control/verify.js";

export interface Approver {
  d: Uint8Array;
  spki: Uint8Array;
  kid: Uint8Array;
  paired: PairedKey;
}

export function approver(seed: string): Approver {
  const d = sha256(new TextEncoder().encode(seed));
  const spki = new Uint8Array([...SPKI_PREFIX, ...p256.getPublicKey(d, false)]);
  const kid = kidOf(spki);
  return { d, spki, kid, paired: { kid, spki } };
}

export function sign(a: Approver, msg: Uint8Array): Uint8Array {
  return p256.sign(msg, a.d, { prehash: true, lowS: true, format: "compact" });
}

/** El permiso tal como lo anunció Nod en POST /v1/control/approvals. */
export function approvalOf(body: Record<string, any>): ApprovalData {
  return { instance: body.instance, id: fromB64u(body.id), toolUseId: body.tool_use_id, tool: body.tool, summary: body.summary, wok: body.wok, exp: body.exp };
}

/** Lo que firma el aprobador tras ver el permiso (o `over`, si el controlador le enseñó otra cosa). */
export function decide(a: Approver, body: Record<string, any>, decision: "allow" | "deny", ts = body.exp - 5, over?: Partial<ApprovalData>): Record<string, unknown> {
  const pending = { ...approvalOf(body), ...over };
  const sig = sign(a, decisionInput(pending.id, pending.toolUseId, decision, ts, approvalHash(pending)));
  return { decision, ts, kid: b64u(a.kid), sig: b64u(sig) };
}

let counter = 0;
export function message(a: Approver, instance: string, session: string, kind: string, text: string, ts: number, id?: Uint8Array): Record<string, unknown> {
  const mid = id ?? Uint8Array.from({ length: 16 }, (_, i) => (i === 15 ? ++counter & 0xff : i === 14 ? (counter >> 8) & 0xff : 7));
  const sid = sessionSid(instance, session);
  const sig = sign(a, messageInput(mid, ts, instance, sid, kind, text));
  return { id: b64u(mid), ts, sid: b64u(sid), kind, text, kid: b64u(a.kid), sig: b64u(sig) };
}

export function offer(a: Approver, k: Uint8Array, instance: string, id = "o1", name?: string): Record<string, unknown> {
  return { id, spki: b64u(a.spki), tag: b64u(pairTag(k, instance, a.spki)), ...(name ? { name } : {}) };
}

export interface Call {
  method: string;
  url: string;
  body: any;
  headers: Record<string, string>;
  at: number;
}

/**
 * Controlador en memoria. `mode`: `ok` responde; `down` falla la red; `hang` acepta y no contesta nunca.
 * `onApproval` se llama al anunciar un permiso (el "aprobador" puede encolar decisiones ahí).
 */
export class FakeController {
  mode: "ok" | "down" | "hang" = "ok";
  postStatus = 201;
  calls: Call[] = [];
  approvals = new Map<string, { body: any; queue: unknown[]; resolved?: any; gone?: boolean }>();
  messages: unknown[] = [];
  offers: Record<string, unknown>[] = [];
  info: Record<string, unknown> = { name: "prueba", pair_url: "https://ctl.example/pair?i={instance}&t={token}&k={k}" };
  onApproval: ((body: any) => void) | undefined;
  /** Devuelve siempre la primera decisión de la cola (como un controlador que no la retira). */
  sticky = false;
  /** false: el long-poll contesta al momento (para el arnés de reproducción, que corre con el reloj real). */
  waits = true;

  constructor(readonly base = "http://127.0.0.1:7878") {}

  queue(id: string, decision: unknown): void {
    this.approvals.get(id)?.queue.push(decision);
  }

  resolvedBodies(): any[] {
    return this.calls.filter((c) => c.method === "POST" && c.url.endsWith("/resolved")).map((c) => c.body);
  }

  fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; ok: boolean; text: string }> => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    this.calls.push({ method: init.method, url, body, headers: init.headers, at: Date.now() });
    if (this.mode === "down") throw new Error("ECONNREFUSED");
    if (this.mode === "hang") return new Promise(() => undefined);
    const res = (status: number, json?: unknown) => ({ status, ok: status >= 200 && status < 300, text: json === undefined ? "" : JSON.stringify(json) });
    const u = new URL(url);
    const path = u.pathname;
    const wait = Number(u.searchParams.get("wait") ?? 0);
    if (init.method === "POST" && path === "/v1/control/approvals") {
      if (this.approvals.has(body.id)) return res(409);
      this.approvals.set(body.id, { body, queue: [] });
      this.onApproval?.(body);
      return res(this.postStatus);
    }
    let m = /^\/v1\/control\/approvals\/([^/]+)\/resolved$/.exec(path);
    if (m && init.method === "POST") {
      const a = this.approvals.get(m[1]!);
      if (a === undefined) return res(404);
      a.resolved = body;
      return res(200);
    }
    m = /^\/v1\/control\/approvals\/([^/]+)$/.exec(path);
    if (m && init.method === "GET") {
      const a = this.approvals.get(m[1]!);
      if (a === undefined || a.gone) return res(404);
      const take = () => (this.sticky ? a.queue[0] : a.queue.shift());
      if (this.waits) await until(() => a.queue.length > 0 || a.gone === true, wait);
      if (a.gone) return res(410);
      const d = a.queue.length > 0 ? take() : undefined;
      return d === undefined ? res(204) : res(200, { decision: d });
    }
    if (init.method === "GET" && path === "/v1/control/messages") {
      if (this.waits) await until(() => this.messages.length > 0, wait);
      if (this.messages.length === 0) return res(204);
      const list = this.messages;
      this.messages = [];
      return res(200, { messages: list });
    }
    if (init.method === "GET" && path === "/v1/control/info") return res(200, this.info);
    if (init.method === "GET" && path === "/v1/control/pair-offers") return res(200, { offers: this.offers });
    m = /^\/v1\/control\/pair-offers\/([^/]+)$/.exec(path);
    if (m && init.method === "DELETE") {
      this.offers = this.offers.filter((o) => o.id !== decodeURIComponent(m![1]!));
      return res(204);
    }
    return res(404);
  };
}

/** Como un long-poll de verdad: vuelve en cuanto `cond` se cumple o pasa `ms`. */
async function until(cond: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, Math.min(50, end - Date.now())));
}

let ids = 0;

/** ControlIo sobre el reloj falso de vitest (setTimeout y Date.now). */
export function fakeIo(ctrl: FakeController, logs: string[] = [], random?: (n: number) => Uint8Array): ControlIo {
  return {
    now: async () => Date.now(),
    after: (ms, cb) => {
      const h = setTimeout(cb, ms);
      return { cancel: () => clearTimeout(h) };
    },
    fetch: (url, init) => ctrl.fetch(url, init),
    random: async (len) => random?.(len) ?? Uint8Array.from({ length: len }, (_, i) => (i === 0 ? ++ids & 0xff : i === 1 ? (ids >> 8) & 0xff : 0x40 + i)),
    log: (m) => void logs.push(m),
  };
}
