// Orbit para Claude Code. Generado por scripts/bundle.mjs desde src/: no editar a mano.

// src/core/allowlist.ts
var WORK_ALLOWLIST = [
  "session_id",
  "hook_event_name",
  "prompt_id",
  "turn_id",
  "permission_mode",
  "effort",
  "agent_id",
  "agent_type",
  "tool_name",
  "tool_use_id",
  "parent_tool_use_id",
  "background",
  "duration_ms",
  "is_error",
  "is_aborted",
  "stop_hook_active",
  "reason",
  "source"
];
var ALLOWED = new Set(WORK_ALLOWLIST);
function clipCodePoints(s, max) {
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join("");
}
function applyAllowlist(ev, ctx) {
  if (ctx !== "work") return ev;
  const out = {};
  for (const [k, v] of Object.entries(ev)) {
    if (!ALLOWED.has(k)) continue;
    if (k === "reason") {
      if (ev.hook_event_name !== "SessionEnd" || typeof v !== "string") continue;
      out[k] = clipCodePoints(v, 32);
      continue;
    }
    out[k] = v;
  }
  return out;
}

// src/core/queue.ts
var DEFAULT_QUEUE = { maxEvents: 5e3, maxBytes: 3e6 };
var OfflineQueue = class {
  constructor(opts = DEFAULT_QUEUE) {
    this.opts = opts;
  }
  opts;
  entries = [];
  bytes = 0;
  droppedTotal = 0;
  /** Se incrementa en cada cambio: sirve para saber si hay algo que persistir. */
  version = 0;
  get length() {
    return this.entries.length;
  }
  get byteSize() {
    return this.bytes;
  }
  /** Añade un evento. Devuelve cuántos eventos viejos tuvo que descartar para caber. */
  push(item) {
    const size = JSON.stringify(item).length;
    this.entries.push({ item, size });
    this.bytes += size;
    this.version++;
    return this.enforce();
  }
  enforce() {
    let dropped = 0;
    while (this.entries.length > 1 && (this.entries.length > this.opts.maxEvents || this.bytes > this.opts.maxBytes)) {
      const e = this.entries.shift();
      this.bytes -= e.size;
      dropped++;
    }
    this.droppedTotal += dropped;
    if (dropped > 0) this.version++;
    return dropped;
  }
  /** Los primeros `max` eventos, sin quitarlos. */
  peek(max) {
    return this.entries.slice(0, max).map((e) => e.item);
  }
  /** Quita los primeros `count` (ya enviados). */
  ack(count) {
    const gone = this.entries.splice(0, count);
    for (const e of gone) this.bytes -= e.size;
    if (gone.length > 0) this.version++;
  }
  /** Quita los primeros `count` por rechazo definitivo del servidor, contándolos como perdidos. */
  reject(count) {
    const before = this.entries.length;
    this.ack(count);
    const lost = before - this.entries.length;
    this.droppedTotal += lost;
    return lost;
  }
  toJSON() {
    return { items: this.entries.map((e) => e.item), dropped: this.droppedTotal };
  }
  /** Recarga lo persistido (ordenado por n). Los que no caben se descartan y se cuentan. */
  load(snapshot) {
    this.droppedTotal = Math.max(this.droppedTotal, snapshot.dropped);
    const items = [...snapshot.items].sort((a, b) => a.n - b.n);
    let dropped = 0;
    for (const it of items) dropped += this.push(it);
    return dropped;
  }
};

// src/core/types.ts
var ORBIT_VERSION = "0.2.0";
function effectiveCtx(cfg) {
  return cfg.privacy === "metadatos" ? "work" : cfg.ctx;
}

// src/core/sequencer.ts
var N_PER_MS = 1024;
var Sequencer = class {
  constructor(instanceId2, saved, block = 1e3, nowMs = 0) {
    this.instanceId = instanceId2;
    this.block = block;
    const fromStore = saved && saved.instance_id === instanceId2 && Number.isInteger(saved.reserve) ? saved.reserve : 0;
    const fromClock = Number.isFinite(nowMs) && nowMs > 0 ? Math.floor(nowMs) * N_PER_MS : 0;
    const start = Math.min(Math.max(fromStore, fromClock), Number.MAX_SAFE_INTEGER - 2 * block);
    this.n = start;
    this.reserve = start + block;
    this.persisted = start;
  }
  instanceId;
  block;
  n;
  reserve;
  persisted;
  /** Siguiente n (≥ 1). */
  next() {
    this.n += 1;
    if (this.n >= this.reserve) this.reserve = this.n + this.block;
    return this.n;
  }
  /** true si hay una reserva por escribir antes de enviar nada. */
  get dirty() {
    return this.reserve !== this.persisted;
  }
  snapshot() {
    return { instance_id: this.instanceId, reserve: this.reserve };
  }
  markPersisted(s) {
    this.persisted = s.reserve;
  }
};
function buildEnvelope(cfg, events) {
  return { orbit: ORBIT_VERSION, instance_id: cfg.instanceId, ctx: cfg.ctx, src: "mod", events };
}

// src/core/collector.ts
var BATCH_WINDOW_MS = 250;
var MAX_BATCH = 500;
var MAX_BACKOFF_MS = 3e4;
var STORE_KEYS = {
  seq: (instanceId2) => `orbit.seq.${instanceId2}`,
  queue: (instanceId2) => `orbit.queue.${instanceId2}`,
  /** Por instancia: la pausa de una no debe pausar a las demás que comparten el mismo store. */
  paused: (instanceId2) => `orbit.paused.${instanceId2}`
};
var REJECTED = /* @__PURE__ */ new Set([400, 413, 422]);
var Collector = class {
  constructor(cfg, io, options = {}) {
    this.cfg = cfg;
    this.io = io;
    this.options = options;
    this.queue = new OfflineQueue({ ...DEFAULT_QUEUE, ...options.queue });
    this.batchMs = options.batchWindowMs ?? BATCH_WINDOW_MS;
    this.maxBatch = Math.min(options.maxBatch ?? MAX_BATCH, MAX_BATCH);
  }
  cfg;
  io;
  options;
  seq;
  queue;
  paused = false;
  dirtyAt = null;
  fails = 0;
  nextRetryAt = 0;
  sent = 0;
  duplicates = 0;
  lastError;
  lastErrorAt;
  lastOkAt;
  unreportedDrops = 0;
  persistedVersion = -1;
  chain = Promise.resolve();
  batchMs;
  maxBatch;
  /** Carga el contador y la cola persistidos. Llamar una vez, antes del primer `ingest`. */
  async init() {
    const savedSeq = await this.io.load(STORE_KEYS.seq(this.cfg.instanceId));
    this.seq = new Sequencer(this.cfg.instanceId, savedSeq, this.options.seqBlock, Number(await this.io.now()));
    await this.saveSeq();
    this.paused = await this.io.load(STORE_KEYS.paused(this.cfg.instanceId)) === true;
    const stored = await this.io.load(STORE_KEYS.queue(this.cfg.instanceId));
    if (stored && Array.isArray(stored.items)) {
      if (stored.instance_id !== this.cfg.instanceId) {
        this.queue.droppedTotal += stored.items.length;
        this.unreportedDrops += stored.items.length;
        this.io.log(`orbit: se descartaron ${stored.items.length} eventos en cola de la instancia "${stored.instance_id}" (ahora es "${this.cfg.instanceId}")`);
      } else {
        const items = stored.items.map((it) => ({ ...it, ev: applyAllowlist(it.ev, effectiveCtx(this.cfg)) }));
        this.unreportedDrops += this.queue.load({ items, dropped: Number(stored.dropped) || 0 });
      }
    }
    this.persistedVersion = -1;
  }
  /** Aplica la lista blanca, asigna `n` y `rx` y encola. Devuelve cuántos eventos entraron. */
  ingest(payloads, now) {
    for (const payload of payloads) {
      const item = { n: this.seq.next(), rx: now, ev: applyAllowlist(payload, effectiveCtx(this.cfg)) };
      this.unreportedDrops += this.queue.push(item);
    }
    if (payloads.length > 0 && this.dirtyAt === null) this.dirtyAt = now;
    return payloads.length;
  }
  /** Milisegundos hasta el próximo envío debido, o null si no hay nada que enviar ahora. */
  delay(now) {
    if (this.paused || this.queue.length === 0) return null;
    const due = this.dirtyAt !== null ? this.dirtyAt + this.batchMs : now;
    return Math.max(0, Math.max(due, this.nextRetryAt) - now);
  }
  setPaused(paused) {
    this.paused = paused;
    return this.io.save(STORE_KEYS.paused(this.cfg.instanceId), paused);
  }
  get isPaused() {
    return this.paused;
  }
  /** Envía lo que haya en cola, en orden de n y en lotes de hasta 500. Las llamadas se serializan. */
  flush() {
    this.chain = this.chain.then(() => this.doFlush()).catch((err) => this.fail(err));
    return this.chain;
  }
  async doFlush() {
    this.dirtyAt = null;
    if (!this.paused) {
      if (this.seq.dirty) await this.saveSeq();
      let size = this.maxBatch;
      while (this.queue.length > 0) {
        const batch = this.queue.peek(size);
        const url = `${this.cfg.url}/v0/ingest`;
        let reply;
        try {
          reply = await this.io.post(url, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.token}` },
            body: JSON.stringify(buildEnvelope(this.cfg, batch))
          });
        } catch (err) {
          await this.fail(err);
          break;
        }
        if (reply.ok) {
          this.queue.ack(batch.length);
          this.sent += batch.length;
          this.noteDuplicates(reply.text);
          this.fails = 0;
          this.nextRetryAt = 0;
          this.lastOkAt = await this.io.now();
          continue;
        }
        if (REJECTED.has(reply.status)) {
          if (batch.length > 1) {
            size = Math.ceil(batch.length / 2);
            continue;
          }
          const lost = this.queue.reject(1);
          this.unreportedDrops += lost;
          size = this.maxBatch;
          await this.fail(new Error(`el servidor rechaz\xF3 un evento (HTTP ${reply.status}): se descart\xF3`), false);
          continue;
        }
        await this.fail(new Error(`HTTP ${reply.status}${reply.text ? `: ${reply.text.slice(0, 120)}` : ""}`));
        break;
      }
    }
    this.reportLoss();
    await this.persist();
  }
  /** El servidor responde 200 aunque descarte repetidos: que no pase inadvertido (colisión de `n`). */
  noteDuplicates(text) {
    let dup = 0;
    try {
      dup = Number(JSON.parse(text).duplicates) || 0;
    } catch {
      return;
    }
    if (dup <= 0) return;
    this.duplicates += dup;
    this.io.log(`orbit: el servidor descart\xF3 ${dup} eventos por repetidos (n ya visto; total ${this.duplicates}). Si no es un reenv\xEDo, otra sesi\xF3n usa el mismo instance_id`);
  }
  async fail(err, backoff = true) {
    const now = await this.io.now();
    this.lastError = err instanceof Error ? err.message : String(err);
    this.lastErrorAt = now;
    if (backoff) {
      this.fails++;
      this.nextRetryAt = now + Math.min(MAX_BACKOFF_MS, 1e3 * 2 ** (this.fails - 1));
    }
  }
  /** Nunca descartar en silencio: cada pérdida acaba en el log con su cuenta. */
  reportLoss() {
    if (this.unreportedDrops === 0) return;
    this.io.log(`orbit: se perdieron ${this.unreportedDrops} eventos (cola llena o rechazados; total perdidos: ${this.queue.droppedTotal})`);
    this.unreportedDrops = 0;
  }
  async saveSeq() {
    const s = this.seq.snapshot();
    await this.io.save(STORE_KEYS.seq(this.cfg.instanceId), s);
    this.seq.markPersisted(s);
  }
  async persist() {
    if (this.queue.version === this.persistedVersion) return;
    const version = this.queue.version;
    try {
      if (this.queue.length === 0 && this.queue.droppedTotal === 0) await this.io.save(STORE_KEYS.queue(this.cfg.instanceId), null);
      else await this.io.save(STORE_KEYS.queue(this.cfg.instanceId), { v: 1, instance_id: this.cfg.instanceId, ...this.queue.toJSON() });
      this.persistedVersion = version;
    } catch (err) {
      this.io.log(`orbit: no se pudo guardar la cola (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  status() {
    const state = this.paused ? "paused" : this.fails > 0 ? "offline" : this.queue.length > 0 ? "pending" : this.lastOkAt !== void 0 ? "connected" : "idle";
    return {
      state,
      paused: this.paused,
      queued: this.queue.length,
      queuedBytes: this.queue.byteSize,
      sent: this.sent,
      dropped: this.queue.droppedTotal,
      duplicates: this.duplicates,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      lastOkAt: this.lastOkAt
    };
  }
};

// src/core/command.ts
function parseOrbitArgs(args) {
  const a = args.trim().toLowerCase();
  if (a === "" || a === "status") return "status";
  if (a === "pause") return "pause";
  if (a === "resume") return "resume";
  if (a === "away") return "away";
  if (a === "back") return "back";
  if (a === "privacidad" || a === "privacy") return "privacy";
  if (/^(privacidad|privacy)\s+(completa|full)$/.test(a)) return "privacy-full";
  if (/^(privacidad|privacy)\s+(metadatos|metadata)$/.test(a)) return "privacy-metadata";
  return "invalid";
}
var ORBIT_USAGE = "uso: /orbit [status | away | back | privacidad [completa|metadatos] | respuestas [a\xF1adir <texto>|quitar <n>|restablecer] | pause | resume | setup | pair | unpair <huella>]";
function ago(now, at) {
  if (at === void 0) return "nunca";
  const s = Math.max(0, Math.round((now - at) / 1e3));
  return s < 60 ? `hace ${s}s` : `hace ${Math.round(s / 60)}min`;
}
function formatStatus(cfg, errors, status, now) {
  if (cfg === void 0 || status === void 0) {
    return ["sin configurar (no se env\xEDa nada)", ...errors.map((e) => `  - ${e}`)].join("\n");
  }
  const label2 = {
    connected: "conectado",
    offline: "sin conexi\xF3n (reintentando)",
    paused: "en pausa",
    pending: "eventos pendientes de enviar",
    idle: "listo (a\xFAn no se envi\xF3 nada)"
  };
  const lines = [
    `estado: ${label2[status.state]}`,
    `  servidor: ${cfg.url}`,
    `  instancia: ${cfg.instanceId} (${cfg.ctx})`,
    `  privacidad: ${cfg.privacy === "metadatos" ? "metadatos (sin prompts, comandos ni rutas; el reloj solo ve el verbo)" : "completa"}`,
    `  cola: ${status.queued} eventos (${status.queuedBytes} bytes)`,
    `  enviados: ${status.sent}, perdidos: ${status.dropped}`,
    `  \xFAltimo env\xEDo correcto: ${ago(now, status.lastOkAt)}`,
    `  \xFAltimo error: ${status.lastError === void 0 ? "ninguno" : `${status.lastError} (${ago(now, status.lastErrorAt)})`}`
  ];
  if (status.duplicates > 0) lines.push(`  descartados por repetidos en el servidor: ${status.duplicates} (\xBFotra sesi\xF3n con el mismo instance_id?)`);
  if (status.paused) lines.push("  el env\xEDo est\xE1 pausado: los eventos se acumulan en la cola; /orbit resume para reanudar");
  return lines.join("\n");
}

// src/core/perm/forbidden.ts
var SEG = "[^;&|\\n]*";
var START = "(?:^|[\\s;&|(`/\"'])";
var DEFAULT_FORBIDDEN = [
  {
    name: "rm-rf",
    re: new RegExp(
      `${START}rm(?=\\s)(?=${SEG}\\s-(?:-recursive\\b|[A-Za-z]*[rR]))(?=${SEG}\\s-(?:-force\\b|[A-Za-z]*f))`
    )
  },
  {
    name: "git-push-force",
    re: new RegExp(
      `${START}git\\s${SEG}\\bpush\\b(?=${SEG}\\s(?:--force(?:-with-lease)?(?:=\\S*)?|-[A-Za-z]*f[A-Za-z]*|\\+\\S+)(?:\\s|$|["'\\\\]))`
    )
  },
  { name: "kubectl", re: new RegExp(`${START}kubectl\\s${SEG}\\b(?:apply|delete)\\b`) },
  { name: "terraform", re: new RegExp(`${START}terraform\\s${SEG}\\b(?:apply|destroy)\\b`) },
  { name: "helm", re: new RegExp(`${START}helm\\s${SEG}\\b(?:upgrade|install|uninstall)\\b`) },
  { name: "publish", re: new RegExp(`${START}(?:npm|pnpm|yarn)\\s${SEG}\\bpublish\\b`) },
  { name: "vercel-prod", re: new RegExp(`${START}vercel\\b${SEG}\\s--prod\\b`) },
  { name: "fly-deploy", re: new RegExp(`${START}(?:fly|flyctl)\\s${SEG}\\bdeploy\\b`) },
  { name: "gcloud-deploy", re: new RegExp(`${START}gcloud\\s${SEG}\\bdeploy\\b`) }
];
function forbiddenSubject(tool, input) {
  if (tool === "Bash" && input !== null && typeof input === "object") {
    const command = input.command;
    if (typeof command === "string") return command;
  }
  try {
    return JSON.stringify(input ?? {}) ?? "";
  } catch {
    return "\0unserializable";
  }
}
function unquoteShell(subject) {
  let s = subject;
  s = s.replace(/\$\(\s*(?:echo|printf)\s+([^()]*)\)/g, " $1 ").replace(/`\s*(?:echo|printf)\s+([^`]*)`/g, " $1 ");
  s = s.replace(/\$\{IFS[^}]*\}|\$IFS\b/g, " ");
  s = s.replace(/\\\n/g, "").replace(/\\/g, "").replace(/["']/g, "");
  s = s.replace(/(\s)--r(?:e(?:c(?:u(?:r(?:s(?:i(?:ve?)?)?)?)?)?)?)?(?=[\s=]|$)/g, "$1--recursive");
  s = s.replace(/(\s)--fo(?:r(?:c(?:e)?)?)?(?=[\s=]|$)/g, "$1--force");
  return s;
}
function matchForbidden(subject, rules) {
  if (subject === "\0unserializable") return "unserializable";
  const variants = [subject];
  const plain = unquoteShell(subject);
  if (plain !== subject) variants.push(plain);
  for (const rule of rules) {
    for (const v of variants) {
      rule.re.lastIndex = 0;
      if (rule.re.test(v)) return rule.name;
    }
  }
  return void 0;
}
function watchOk(tool, input, rules) {
  return matchForbidden(forbiddenSubject(tool, input), rules) === void 0;
}
function compileRules(patterns, prefix) {
  const rules = [];
  for (const [i, p] of patterns.entries()) {
    try {
      rules.push({ name: `${prefix}${i}`, re: new RegExp(p) });
    } catch (err) {
      return { ok: false, error: `regex inv\xE1lida ${JSON.stringify(p)}: ${String(err)}` };
    }
  }
  return { ok: true, rules };
}

// src/core/config.ts
var INSTANCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
function parseConfig(raw) {
  const errors = [];
  const url = (raw.url ?? "").trim().replace(/\/+$/, "");
  const token = (raw.token ?? "").trim();
  const instanceId2 = (raw.instanceId ?? "").trim();
  const ctx = (raw.ctx ?? "").trim();
  if (url === "") errors.push("ORBIT_URL no est\xE1 definida");
  else if (!/^https?:\/\/[^\s/]+/.test(url)) errors.push("ORBIT_URL debe empezar por http:// o https://");
  if (token === "") errors.push("ORBIT_TOKEN no est\xE1 definida");
  if (instanceId2 === "") errors.push("ORBIT_INSTANCE_ID no est\xE1 definida");
  else if (!INSTANCE_ID_RE.test(instanceId2)) errors.push("ORBIT_INSTANCE_ID debe cumplir ^[a-z0-9][a-z0-9-]{0,31}$");
  if (ctx === "") errors.push("ORBIT_CTX no est\xE1 definida (personal | work)");
  else if (ctx !== "personal" && ctx !== "work") errors.push("ORBIT_CTX debe ser personal o work");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: { url, token, instanceId: instanceId2, ctx } };
}
var PERM_HOLD_MS_DEFAULT = 2e4;
var PERM_HOLD_MS_AWAY = 9e4;
var PERM_HOLD_MS_MAX = 9e4;
var PERM_HOLD_MS_MIN = 1e3;
function regexList(raw, name, errors) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    errors.push(`${name} debe ser un array JSON de expresiones regulares`);
    return void 0;
  }
  if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === "string" && p !== "")) {
    errors.push(`${name} debe ser un array JSON de expresiones regulares no vac\xEDas`);
    return void 0;
  }
  return parsed;
}
function parsePermConfig(raw) {
  const errors = [];
  const enabledRaw = (raw.enabled ?? "").trim().toLowerCase();
  let enabled = true;
  if (enabledRaw === "off" || enabledRaw === "0" || enabledRaw === "false") enabled = false;
  else if (enabledRaw !== "" && enabledRaw !== "on" && enabledRaw !== "1" && enabledRaw !== "true")
    errors.push("ORBIT_PERM debe ser on u off");
  let holdMs = PERM_HOLD_MS_DEFAULT;
  const holdRaw = (raw.holdMs ?? "").trim();
  if (holdRaw !== "") {
    const n = Number(holdRaw);
    if (!Number.isInteger(n) || n < PERM_HOLD_MS_MIN || n > PERM_HOLD_MS_MAX)
      errors.push(`ORBIT_PERM_HOLD_MS debe ser un entero entre ${PERM_HOLD_MS_MIN} y ${PERM_HOLD_MS_MAX}`);
    else holdMs = n;
  }
  let forbidden = [...DEFAULT_FORBIDDEN];
  const replace = (raw.forbidden ?? "").trim();
  if (replace !== "") {
    const list = regexList(replace, "ORBIT_FORBIDDEN", errors);
    if (list !== void 0) {
      const r = compileRules(list, "custom-");
      if (r.ok) forbidden = r.rules;
      else errors.push(`ORBIT_FORBIDDEN: ${r.error}`);
    }
  }
  const add = (raw.forbiddenAdd ?? "").trim();
  if (add !== "") {
    const list = regexList(add, "ORBIT_FORBIDDEN_ADD", errors);
    if (list !== void 0) {
      const r = compileRules(list, "extra-");
      if (r.ok) forbidden = forbidden.concat(r.rules);
      else errors.push(`ORBIT_FORBIDDEN_ADD: ${r.error}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, perm: { enabled, holdMs, forbidden } };
}

// src/core/translate.ts
var TOOL_CALL_RESERVED = /* @__PURE__ */ new Set(["tool", "tool_use_id", "agentId", "requestMeta", "consent"]);
var AGENT_ID_IN_TEXT = /(?:^|\n)\s*agentId:\s*([A-Za-z0-9_-]+)/;
var str = (v) => typeof v === "string" && v !== "" ? v : void 0;
function toolInputOf(e) {
  const out = {};
  for (const [k, v] of Object.entries(e)) if (!TOOL_CALL_RESERVED.has(k)) out[k] = v;
  return out;
}
function agentIdFromText(text) {
  if (typeof text !== "string") return void 0;
  return AGENT_ID_IN_TEXT.exec(text)?.[1];
}
var Translator = class {
  pending = [];
  started = /* @__PURE__ */ new Set();
  types = /* @__PURE__ */ new Map();
  /** ¿Hace falta consultar `$.agent.list()` para este agente? */
  needsAgentLookup(agentId) {
    return agentId !== void 0 && !this.types.has(agentId);
  }
  get pendingSpawns() {
    return this.pending.length;
  }
  sessionStart(sid, e) {
    const ev = { session_id: sid, hook_event_name: "SessionStart", source: "mod" };
    const cwd = str(e.cwd);
    if (cwd !== void 0) ev.cwd = cwd;
    return [ev];
  }
  turnStart(sid, e) {
    const ev = { session_id: sid, hook_event_name: "UserPromptSubmit" };
    if (typeof e.text === "string") ev.prompt = e.text;
    const turn = str(e.turnId);
    if (turn !== void 0) ev.turn_id = turn;
    return [ev];
  }
  toolCall(sid, e, agent) {
    const out = [];
    const agentId = str(e.agentId);
    if (agentId !== void 0) {
      if (agent !== void 0 && agent.id === agentId && agent.type !== void 0) this.types.set(agentId, agent.type);
      out.push(...this.tryStart(sid, agentId, { type: agent?.type, description: agent?.description }));
    }
    const ev = {
      session_id: sid,
      hook_event_name: "PreToolUse",
      tool_name: String(e.tool),
      tool_use_id: String(e.tool_use_id),
      tool_input: toolInputOf(e)
    };
    this.addAgent(ev, agentId);
    out.push(ev);
    return out;
  }
  /** `tool.check` con veredicto `ask`. allow/deny no emiten nada. */
  toolCheck(sid, e, verdict) {
    if (verdict?.decision !== "ask") return [];
    const ev = {
      session_id: sid,
      hook_event_name: "PermissionRequest",
      tool_name: String(e.tool)
    };
    if (e.input !== void 0 && e.input !== null && typeof e.input === "object") ev.tool_input = e.input;
    const id = str(e.tool_use_id);
    if (id !== void 0) ev.tool_use_id = id;
    this.addAgent(ev, str(e.agentId));
    const reason = str(verdict.reason);
    if (reason !== void 0) ev.permission_reason = reason;
    return [ev];
  }
  /** Resultado de `tool.call` (lo que devuelve `next(e)`). El texto del resultado NO se copia. */
  toolResult(sid, e, result) {
    const out = [];
    const toolUseId2 = String(e.tool_use_id);
    const isAgent = e.tool === "Agent";
    let boundAgentId;
    if (isAgent) {
      boundAgentId = agentIdFromText(result?.text);
      if (boundAgentId !== void 0) out.push(...this.tryStart(sid, boundAgentId, { toolUseId: toolUseId2 }));
    }
    const ev = {
      session_id: sid,
      hook_event_name: "PostToolUse",
      tool_name: String(e.tool),
      tool_use_id: toolUseId2,
      is_error: result?.isError === true || typeof result?.deny === "string"
    };
    this.addAgent(ev, str(e.agentId));
    if (boundAgentId !== void 0) ev.tool_response = { agentId: boundAgentId };
    out.push(ev);
    return out;
  }
  agentSpawn(e) {
    const id = str(e.tool_use_id);
    if (id === void 0) return [];
    this.pending.push({
      tool_use_id: id,
      subagentType: str(e.subagentType) ?? "unknown",
      description: typeof e.description === "string" ? e.description : "",
      background: e.background === true
    });
    return [];
  }
  turnComplete(sid, e) {
    const out = [];
    const agentId = str(e.agentId);
    const isAborted = e.isAborted === true;
    if (agentId !== void 0) {
      if (!this.started.has(agentId) && this.pending.length === 1) out.push(...this.tryStart(sid, agentId, {}));
      const stop = { session_id: sid, hook_event_name: "SubagentStop", agent_id: agentId, is_aborted: isAborted };
      if (e.usage !== void 0 && e.usage !== null && typeof e.usage === "object") stop.usage = e.usage;
      out.push(stop);
      this.started.delete(agentId);
      this.types.delete(agentId);
      return out;
    }
    const ev = { session_id: sid, hook_event_name: "Stop", is_aborted: isAborted };
    const turn = str(e.turnId);
    if (turn !== void 0) ev.turn_id = turn;
    if (typeof e.answer === "string") ev.last_assistant_message = e.answer;
    if (e.usage !== void 0 && e.usage !== null && typeof e.usage === "object") ev.usage = e.usage;
    out.push(ev);
    return out;
  }
  sessionEnd(sid, e) {
    const ev = { session_id: sid, hook_event_name: "SessionEnd", reason: str(e.reason) ?? "other" };
    this.pending = [];
    this.started.clear();
    this.types.clear();
    return [ev];
  }
  addAgent(ev, agentId) {
    if (agentId === void 0) return;
    ev.agent_id = agentId;
    const type = this.types.get(agentId);
    if (type !== void 0) ev.agent_type = type;
  }
  /**
   * Intenta emitir SubagentStart para `agentId`. Elige el spawn pendiente por tool_use_id exacto
   * (resultado del tool Agent), o el más antiguo con el mismo tipo (y descripción, si coincide
   * alguno), o el único pendiente si no hay pistas. Sin spawn pendiente no emite nada.
   */
  tryStart(sid, agentId, hint) {
    if (this.started.has(agentId) || this.pending.length === 0) return [];
    let idx = -1;
    if (hint.toolUseId !== void 0) {
      idx = this.pending.findIndex((p) => p.tool_use_id === hint.toolUseId);
    } else if (hint.type !== void 0) {
      const sameType = this.pending.filter((p) => p.subagentType === hint.type);
      const best = sameType.find((p) => hint.description !== void 0 && p.description === hint.description) ?? sameType[0];
      idx = best === void 0 ? -1 : this.pending.indexOf(best);
    } else if (this.pending.length === 1) {
      idx = 0;
    }
    if (idx < 0) return [];
    const spawn = this.pending.splice(idx, 1)[0];
    this.started.add(agentId);
    this.types.set(agentId, spawn.subagentType);
    return [
      {
        session_id: sid,
        hook_event_name: "SubagentStart",
        agent_id: agentId,
        agent_type: spawn.subagentType,
        parent_tool_use_id: spawn.tool_use_id,
        background: spawn.background
      }
    ];
  }
};

// src/protocol/cbor.ts
var ProtocolError = class extends Error {
  kind;
  constructor(kind, message) {
    super(`${kind}: ${message}`);
    this.name = "ProtocolError";
    this.kind = kind;
  }
};
var MAX_UINT = Number.MAX_SAFE_INTEGER;
var utf8 = new TextEncoder();
var utf8Strict = new TextDecoder("utf-8", { fatal: true });
function header(major, n) {
  const m = major << 5;
  if (n < 24) return [m | n];
  if (n < 256) return [m | 24, n];
  if (n < 65536) return [m | 25, n >> 8, n & 255];
  if (n < 4294967296) return [m | 26, n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255];
  const out = [m | 27];
  let big = BigInt(n);
  const tail = [];
  for (let i = 0; i < 8; i++) {
    tail.unshift(Number(big & 0xffn));
    big >>= 8n;
  }
  return out.concat(tail);
}
function encodeInto(v, out) {
  if (typeof v === "boolean") {
    out.push(v ? 245 : 244);
  } else if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new ProtocolError("forbidden-type", `n\xFAmero no uint seguro: ${v}`);
    }
    out.push(...header(0, v));
  } else if (typeof v === "string") {
    const b = utf8.encode(v);
    out.push(...header(3, b.length));
    for (const x of b) out.push(x);
  } else if (v instanceof Uint8Array) {
    out.push(...header(2, v.length));
    for (const x of v) out.push(x);
  } else if (Array.isArray(v)) {
    out.push(...header(4, v.length));
    for (const item of v) encodeInto(item, out);
  } else {
    throw new ProtocolError("forbidden-type", "tipo no representable en 0.2.0");
  }
}
function encode(value) {
  const out = [];
  encodeInto(value, out);
  return Uint8Array.from(out);
}
var Reader = class {
  constructor(buf) {
    this.buf = buf;
  }
  buf;
  pos = 0;
  byte() {
    const b = this.buf[this.pos];
    if (b === void 0) throw new ProtocolError("parse", "fin de datos inesperado");
    this.pos++;
    return b;
  }
  take(n) {
    if (this.pos + n > this.buf.length) throw new ProtocolError("parse", "fin de datos inesperado");
    const s = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
  /** Lee el argumento de un head y exige la codificación más corta. */
  arg(info) {
    if (info < 24) return info;
    if (info === 31) throw new ProtocolError("noncanonical", "longitud indefinida");
    if (info > 27) throw new ProtocolError("parse", `info reservada ${info}`);
    const size = 1 << info - 24;
    const raw = this.take(size);
    let n = 0n;
    for (const b of raw) n = n << 8n | BigInt(b);
    const min = info === 24 ? 24n : info === 25 ? 0x100n : info === 26 ? 0x10000n : 0x100000000n;
    if (n < min) throw new ProtocolError("noncanonical", "entero o longitud no m\xEDnimos");
    if (n > BigInt(MAX_UINT)) throw new ProtocolError("schema", "valor mayor que 2^53-1");
    return Number(n);
  }
  value() {
    const ib = this.byte();
    const major = ib >> 5;
    const info = ib & 31;
    switch (major) {
      case 0:
        return this.arg(info);
      case 1:
        throw new ProtocolError("forbidden-type", "entero negativo");
      case 2:
        return Uint8Array.from(this.take(this.arg(info)));
      case 3:
        try {
          return utf8Strict.decode(this.take(this.arg(info)));
        } catch (e) {
          if (e instanceof ProtocolError) throw e;
          throw new ProtocolError("parse", "UTF-8 inv\xE1lido");
        }
      case 4: {
        const n = this.arg(info);
        const items = [];
        for (let i = 0; i < n; i++) items.push(this.value());
        return items;
      }
      case 5:
        throw new ProtocolError("forbidden-type", "mapa");
      case 6:
        throw new ProtocolError("forbidden-type", "tag");
      default:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) throw new ProtocolError("forbidden-type", "null");
        if (info >= 25 && info <= 27) throw new ProtocolError("forbidden-type", "float");
        throw new ProtocolError("forbidden-type", `simple/float ${info}`);
    }
  }
};
function decodeStrict(bytes2) {
  const r = new Reader(bytes2);
  const v = r.value();
  if (r.pos !== bytes2.length) throw new ProtocolError("parse", "bytes sobrantes tras el valor");
  return v;
}

// src/protocol/types.ts
var U32 = 4294967295;
var U53 = Number.MAX_SAFE_INTEGER;
var utf82 = new TextEncoder();
var NODE_TYPES = ["session", "agent", "task", "mcp"];
var STATUSES = ["run", "perm", "done", "err"];
var STUCK_WHYS = ["idle", "loop", "none"];
var DECISIONS = ["allow", "deny"];
var PCLOSE_BY = ["watch", "terminal", "timeout", "rule", "abort"];
var PCLOSE_DECISIONS = ["allow", "deny", "none"];
var TEXT_FIELDS = ["cmd", "prompt", "answer", "result", "reason"];
var SIGNATURE_FORMAT = 2;
var INSTANCE_ID_RE2 = /^[a-z0-9][a-z0-9-]{0,31}$/;
function bad(msg) {
  throw new ProtocolError("schema", msg);
}
function arr(v, what) {
  if (!Array.isArray(v)) return bad(`${what}: se esperaba array`);
  return v;
}
function exactLen(a, n, what) {
  if (a.length !== n) bad(`${what}: se esperaban ${n} elementos, hay ${a.length}`);
}
function uint(v, min, max, what) {
  if (typeof v !== "number") return bad(`${what}: se esperaba uint`);
  if (v < min || v > max) return bad(`${what}: fuera de rango ${min}..${max}`);
  return v;
}
function str2(v, what) {
  if (typeof v !== "string") return bad(`${what}: se esperaba tstr`);
  return v;
}
function strMaxBytes(v, max, what) {
  const s = str2(v, what);
  if (utf82.encode(s).length > max) bad(`${what}: m\xE1s de ${max} bytes UTF-8`);
  return s;
}
function bytesN(v, n, what) {
  if (!(v instanceof Uint8Array)) return bad(`${what}: se esperaba bstr`);
  if (v.length !== n) bad(`${what}: se esperaban ${n} bytes`);
  return v;
}
function bool(v, what) {
  if (typeof v !== "boolean") return bad(`${what}: se esperaba bool`);
  return v;
}
function oneOf(v, set, what) {
  const s = str2(v, what);
  const found = set.find((x) => x === s);
  if (found === void 0) return bad(`${what}: valor desconocido ${JSON.stringify(s)}`);
  return found;
}
function toolUseId(v) {
  const s = str2(v, "tool_use_id");
  const chars = Array.from(s).length;
  if (chars < 1 || chars > 64) bad("tool_use_id: longitud 1..64");
  return s;
}
function instanceId(v, what) {
  const s = str2(v, what);
  if (!INSTANCE_ID_RE2.test(s)) bad(`${what}: no cumple ^[a-z0-9][a-z0-9-]{0,31}$`);
  return s;
}
var label = (v, what) => strMaxBytes(v, 32, what);
var u32 = (v, min, what) => uint(v, min, U32, what);
var u53 = (v, what) => uint(v, 0, U53, what);
function parseNode(v) {
  const a = arr(v, "node");
  exactLen(a, 7, "node");
  return {
    id: u32(a[0], 1, "node.id"),
    t: oneOf(a[1], NODE_TYPES, "node.t"),
    p: u32(a[2], 0, "node.p"),
    s: oneOf(a[3], STATUSES, "node.s"),
    k: label(a[4], "node.k"),
    m: u32(a[5], 0, "node.m"),
    ts: u53(a[6], "node.ts")
  };
}
function parseOp(v) {
  const a = arr(v, "op");
  if (a.length === 0) return bad("op vac\xEDa");
  const name = str2(a[0], "op[0]");
  switch (name) {
    case "snap":
      exactLen(a, 2, "snap");
      return { op: "snap", nodes: arr(a[1], "snap.nodes").map(parseNode) };
    case "add": {
      if (a.length < 5 || a.length > 6) return bad("add: 5 o 6 elementos");
      const base = {
        op: "add",
        id: u32(a[1], 1, "add.id"),
        t: oneOf(a[2], NODE_TYPES, "add.t"),
        p: u32(a[3], 0, "add.p"),
        k: label(a[4], "add.k")
      };
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
        turns: u32(a[4], 0, "meta.turns")
      };
    case "stuck":
      exactLen(a, 6, "stuck");
      return {
        op: "stuck",
        session: u32(a[1], 1, "stuck.session"),
        why: oneOf(a[2], STUCK_WHYS, "stuck.why"),
        since: u53(a[3], "stuck.since"),
        k: label(a[4], "stuck.k"),
        n: u32(a[5], 0, "stuck.n")
      };
    default:
      return { op: "unknown", raw: a };
  }
}
var SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;
function parseFrame(v) {
  const a = arr(v, "trama");
  if (a.length === 0) return bad("trama vac\xEDa");
  const kind = str2(a[0], "trama[0]");
  switch (kind) {
    case "hello": {
      exactLen(a, 4, "hello");
      const version = str2(a[1], "hello.version");
      if (!SEMVER.test(version)) bad("hello.version: no es MAJOR.MINOR.PATCH");
      return { type: "hello", version, epoch: u32(a[2], 0, "hello.epoch"), seq: u53(a[3], "hello.seq") };
    }
    case "d": {
      exactLen(a, 5, "delta");
      const ops = arr(a[4], "delta.ops").map(parseOp);
      if (ops.some((o) => o.op === "snap") && ops.length !== 1) {
        bad("delta: snap debe ser la \xFAnica op de su trama (SPEC \xA75.3)");
      }
      return {
        type: "d",
        epoch: u32(a[1], 0, "delta.epoch"),
        seq: u53(a[2], "delta.seq"),
        ts: u53(a[3], "delta.ts"),
        ops
      };
    }
    case "req":
      exactLen(a, 4, "req");
      if (str2(a[1], "req.what") !== "snap") bad('req: solo existe "snap"');
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
        instanceId: instanceId(a[8], "perm.instance_id")
      };
    case "pclose":
      exactLen(a, 4, "pclose");
      return {
        type: "pclose",
        nonce: bytesN(a[1], 16, "pclose.nonce"),
        by: oneOf(a[2], PCLOSE_BY, "pclose.by"),
        decision: oneOf(a[3], PCLOSE_DECISIONS, "pclose.decision")
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
        ph: bytesN(a[7], 32, "dec.ph")
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
        red: bool(a[6], "text.red")
      };
    default:
      return bad(`trama desconocida ${JSON.stringify(kind)}`);
  }
}
function signingInputToCbor(s) {
  return ["orbit-dec", SIGNATURE_FORMAT, s.nonce, s.toolUseId, s.decision, s.ts, s.ph];
}
function permHashInputToCbor(p) {
  return ["orbit-perm", 1, p.instanceId, p.nonce, p.toolUseId, p.tool, p.sum, p.wok, p.exp];
}
function decodeFrame(bytes2) {
  return parseFrame(decodeStrict(bytes2));
}

// src/core/perm/summary.ts
var SUM_MAX_BYTES = 200;
var TOOL_MAX_BYTES = 32;
var utf83 = new TextEncoder();
function truncateUtf8(s, max) {
  if (utf83.encode(s).length <= max) return s;
  let bytes2 = 0;
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const n = cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
    if (bytes2 + n > max) break;
    bytes2 += n;
    out += ch;
  }
  return out;
}
function stringField(input, key) {
  if (input === null || typeof input !== "object") return void 0;
  const v = input[key];
  return typeof v === "string" ? v : void 0;
}
function compactJson(input) {
  try {
    const s = JSON.stringify(input ?? {});
    return typeof s === "string" ? s : "";
  } catch {
    return "";
  }
}
var VERB_RE = /^[A-Za-z0-9._+-]{1,32}$/;
var ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
function commandVerb(command) {
  for (const token of command.trim().split(/\s+/)) {
    if (token === "") continue;
    if (ASSIGN_RE.test(token)) continue;
    const base = token.slice(token.lastIndexOf("/") + 1);
    return VERB_RE.test(base) ? base : void 0;
  }
  return void 0;
}
var MASK = "***";
var KW = "(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth(?:orization)?|credentials?|cookie|session[_-]?id|contrase(?:\xF1|n)a|clave|signature|sig)s?(?![a-z0-9])";
var REDACTIONS = [
  // Bloques PEM de clave privada.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  // Formas conocidas de tokens (GitHub, OpenAI/Anthropic, Slack, AWS, Google, JWT).
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g, MASK],
  // Credenciales en una URL: esquema://usuario:clave@ y esquema://token@.
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:'"]+):([^\s/@'"]+)@/gi, "$1$2:" + MASK + "@"],
  [/\b([a-z][a-z0-9+.-]*:\/\/)([A-Za-z0-9_-]{16,})@/gi, "$1" + MASK + "@"],
  // Authorization: Bearer/Basic/Token xxx (cabeceras) y "Bearer xxx" suelto.
  [/\b(authorization\s*[:=]\s*(?:bearer|basic|token|digest)?\s*)[^\s"']+/gi, "$1" + MASK],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, "$1" + MASK],
  // curl -u usuario:clave / --user usuario:clave
  [/(\s(?:-u|--user)[\s=]+["']?[^\s:"']+:)[^\s"']+/g, "$1" + MASK],
  // mysql -pCLAVE (pegada), sshpass -p CLAVE, docker/podman/helm login -p CLAVE.
  [/(\bmysql(?:dump|admin)?\b[^;&|\n]*?\s-p)([^\s"']+|"[^"]*"|'[^']*')/g, "$1" + MASK],
  [/(\b(?:sshpass|(?:docker|podman|helm(?:\s+registry)?|nerdctl)\s+login)\b[^;&|\n]*?\s-p\s*)([^\s"']+|"[^"]*"|'[^']*')/g, "$1" + MASK],
  // NOMBRE_CON_PALABRA=valor, palabra: valor, --palabra=valor, -token=valor, "password":"valor" (JSON).
  [new RegExp(`([A-Za-z0-9_.-]*${KW}[A-Za-z0-9_.-]*["']?\\s*[=:]\\s*)(["'\`]?)(?!(?:bearer|basic|digest)\\s)([^\\s"'\`&;|,}]+)`, "gi"), "$1$2" + MASK],
  // --palabra valor (opción con la palabra en el nombre y el valor separado por espacio).
  [new RegExp(`(\\s--?[A-Za-z0-9_-]*${KW}[A-Za-z0-9_-]*\\s+)(["']?)(?!-)([^\\s"']+)`, "gi"), "$1$2" + MASK],
  // palabra "valor", palabra **valor**, palabra es/is valor, contraseña valor (prosa).
  [new RegExp(`(${KW}\\s+(?:(?:es|is|=)\\s+)?)("|'|\`|\\*\\*)([^"'\`*\\n]{1,80})\\2`, "gi"), "$1$2" + MASK + "$2"],
  [new RegExp(`(${KW}\\s+(?:es|is)\\s+)([^\\s"'\`*]+)`, "gi"), "$1" + MASK],
  [/((?:contrase(?:ñ|n)a|clave)\s+)(?!es\b|is\b)([^\s"'`*]+)/gi, "$1" + MASK],
  // Pares `usuario` / `clave` (y con comillas): se oculta el segundo.
  [/(([`'"])[^`'"\s]{1,64}\2\s*\/\s*)([`'"])([^`'"\n]{1,80})\3/g, (_m, pre, _q1, q) => `${pre}${q}${MASK}${q}`]
];
function redactSecrets(text) {
  let out = text;
  for (const [re, by] of REDACTIONS) {
    re.lastIndex = 0;
    out = typeof by === "string" ? out.replace(re, by) : out.replace(re, by);
  }
  return out;
}
function toolLabel(tool) {
  return truncateUtf8(tool, TOOL_MAX_BYTES);
}
var HIDDEN_RE = /[\p{Cf}\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u;
function summarizeExact(ctx, tool, input) {
  if (ctx === "work") {
    if (tool === "Bash") {
      const command = stringField(input, "command");
      const verb = command === void 0 ? void 0 : commandVerb(command);
      return { sum: verb ?? toolLabel(tool), exact: true };
    }
    return { sum: toolLabel(tool), exact: true };
  }
  let text;
  if (tool === "Bash") text = stringField(input, "command") ?? compactJson(input);
  else if (tool === "Edit" || tool === "Write" || tool === "Read") text = stringField(input, "file_path") ?? compactJson(input);
  else text = compactJson(input);
  const sum = truncateUtf8(redactSecrets(text), SUM_MAX_BYTES);
  return { sum, exact: sum === text && !HIDDEN_RE.test(text) };
}

// src/vendor/noble-p256.ts
var fromNumH = (n) => n / 2 ** 32 | 0;
var fromNumL = (n) => n >>> 0;
function setU64FromNum(view, byteOffset, n, isLE) {
  const h = fromNumH(n);
  const l = fromNumL(n);
  view.setUint32(byteOffset, isLE ? l : h, isLE);
  view.setUint32(byteOffset + 4, isLE ? h : l, isLE);
}
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
var atitle = (title) => title ? `"${title}" ` : "";
function anumber(n, title = "") {
  if (typeof n !== "number")
    throw new TypeError(atitle(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle(title) + "expected integer >= 0, got " + n);
  return n;
}
function abytes(value, length, title = "") {
  if (isBytes(value) && (length === void 0 || value.length === length))
    return value;
  if (length !== void 0)
    anumber(length, "length");
  const bytes2 = isBytes(value);
  const ofLen = length !== void 0 ? ` of length ${length}` : "";
  const got = bytes2 ? `length=${value.length}` : `type=${typeof value}`;
  const message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes2)
    throw new TypeError(message);
  throw new RangeError(message);
}
function ahash(h) {
  if (typeof h !== "function" || typeof h.create !== "function")
    throw new TypeError("expected hash wrapped by utils.createHasher");
  anumber(h.outputLen);
  anumber(h.blockLen);
  if (h.outputLen < 1 || h.blockLen < 1)
    throw new Error("hash blockLen / outputLen must be >= 1");
}
var aobject = (value, label2) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError((label2 === "object" ? "" : `"${label2}" `) + "expected object, got type=" + typeof value);
};
var aopts = (value, label2) => {
  aobject(value, label2);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError(`"${label2}" expected plain object`);
  if (Object.hasOwn(value, "__proto__"))
    throw new TypeError(`"${label2}.__proto__" is not allowed`);
};
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput(out, instance) {
  abytes(out, void 0, "output");
  const min = instance.outputLen;
  if (!(out.length >= min)) {
    throw new RangeError('"output" expected length >= ' + min);
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr2) {
  return new DataView(arr2.buffer, arr2.byteOffset, arr2.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
var hasHexBuiltin = /* @__PURE__ */ (() => (
  // @ts-ignore
  typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
))();
var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex(bytes2) {
  abytes(bytes2);
  if (hasHexBuiltin)
    return bytes2.toHex();
  let hex2 = "";
  for (let i = 0; i < bytes2.length; i++) {
    hex2 += hexes[bytes2[i]];
  }
  return hex2;
}
function asciiToBase16(ch) {
  return ch >= 48 && ch <= 57 ? ch - 48 : ch >= 65 && ch <= 70 ? ch - (65 - 10) : ch >= 97 && ch <= 102 ? ch - (97 - 10) : void 0;
}
function hexToBytes(hex2) {
  if (typeof hex2 !== "string")
    throw new TypeError("hex string expected, got " + typeof hex2);
  if (hasHexBuiltin) {
    try {
      return Uint8Array.fromHex(hex2);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new RangeError(error.message);
      throw error;
    }
  }
  const hl = hex2.length;
  const al = hl / 2;
  if (hl % 2)
    throw new RangeError("hex string expected, got unpadded hex of length " + hl);
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex2.charCodeAt(hi));
    const n2 = asciiToBase16(hex2.charCodeAt(hi + 1));
    if (n1 === void 0 || n2 === void 0) {
      const char = hex2[hi] + hex2[hi + 1];
      throw new RangeError('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
function concatBytes(...arrays) {
  let sum = 0;
  for (let i = 0; i < arrays.length; i++) {
    const a = arrays[i];
    abytes(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0; i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}
function checkOpts(defaults, opts, title = "opts") {
  aopts(defaults, "defaults");
  if (opts !== void 0)
    aopts(opts, title);
  const merged = Object.assign(/* @__PURE__ */ Object.create(null), defaults, opts);
  return merged;
}
function createHasher(hashCons, info = {}) {
  if (typeof hashCons !== "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof hashCons);
  info = checkOpts({}, info, "info");
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(void 0);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.canXOF = tmp.canXOF;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
function randomBytes(bytesLength = 32) {
  anumber(bytesLength, "bytesLength");
  const cr = typeof globalThis === "object" ? globalThis.crypto : null;
  if (typeof cr?.getRandomValues !== "function")
    throw new Error("crypto.getRandomValues must be defined");
  if (bytesLength > 65536)
    throw new RangeError(`"bytesLength" expected <= 65536, got ${bytesLength}`);
  return cr.getRandomValues(new Uint8Array(bytesLength));
}
var oidNist = (suffix) => ({
  // Current NIST hashAlgs suffixes used here fit in one DER subidentifier octet.
  // Larger suffix values would need base-128 OID encoding and a different length byte.
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class {
  blockLen;
  outputLen;
  canXOF = false;
  padOffset;
  isLE;
  // For partial updates less than block size
  buffer;
  view;
  finished = false;
  length = 0;
  pos = 0;
  destroyed = false;
  constructor(blockLen, outputLen, padOffset, isLE) {
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    let processed = false;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        processed = true;
        continue;
      }
      buffer.set(pos === 0 && take === len ? data : data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
        processed = true;
      }
    }
    this.length += data.length;
    if (processed)
      this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    buffer.fill(0, pos);
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      buffer.fill(0);
    }
    setU64FromNum(view, blockLen - 8, this.length * 8, isLE);
    this.process(view, 0);
    this.roundClean();
    const oview = out === buffer ? view : createView(out);
    const len = this.outputLen;
    const outLen = len / 4;
    const state = this.get();
    if (len % 4 || outLen > state.length)
      throw new Error("invalid outputLen");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneIntoMeta(to) {
    const { buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (pos)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA2_32B = class extends HashMD {
  // We cannot use array here since array allows indexing by variable
  // which means optimizer/compiler cannot use registers.
  // Numeric initializers matter: starting the fields as `undefined` changes
  // V8's field representation and makes sha256 3x slower (measured).
  A = 0;
  B = 0;
  C = 0;
  D = 0;
  E = 0;
  F = 0;
  G = 0;
  H = 0;
  constructor(outputLen, IV) {
    super(64, outputLen, 8, false);
    this.A = IV[0] | 0;
    this.B = IV[1] | 0;
    this.C = IV[2] | 0;
    this.D = IV[3] | 0;
    this.E = IV[4] | 0;
    this.F = IV[5] | 0;
    this.G = IV[6] | 0;
    this.H = IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  _cloneInto(to) {
    (to ||= new this.constructor()).set(...this.get());
    return this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.destroyed = true;
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
};
var _SHA256 = class extends SHA2_32B {
  constructor() {
    super(32, SHA256_IV);
  }
};
var sha256 = /* @__PURE__ */ createHasher(
  () => new _SHA256(),
  /* @__PURE__ */ oidNist(1)
);
function aarray(item, title, inner = () => {
}) {
  if (!Array.isArray(item))
    throw new TypeError(`"${title}" expected array, got type=${typeof item}`);
  for (let i = 0; i < item.length; i++)
    inner(item[i], `${title}[${i}]`);
  return item;
}
var abytes2 = (value, length, title) => abytes(value, length, title);
var anumber2 = anumber;
function astring(value, title = "") {
  if (typeof value !== "string") {
    const prefix = title && `"${title}" `;
    throw new TypeError(prefix + "expected string, got type=" + typeof value);
  }
  return value;
}
function aobject2(value, title = "object") {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(title === "object" ? "expected valid options object" : `"${title}" expected object, got type=${typeof value}`);
  return value;
}
function afunction(value, title) {
  if (typeof value !== "function")
    throw new TypeError(`"${title}" is invalid: expected function, got ${typeof value}`);
  return value;
}
var bytesToHex2 = bytesToHex;
var concatBytes2 = (...arrays) => concatBytes(...arrays);
var hexToBytes2 = (hex2) => hexToBytes(hex2);
var isBytes2 = isBytes;
var randomBytes2 = (bytesLength) => randomBytes(bytesLength);
var _0n = /* @__PURE__ */ BigInt(0);
var _1n = /* @__PURE__ */ BigInt(1);
var atitle2 = (title) => title ? `"${title}" ` : "";
function abool(value, title = "") {
  if (typeof value !== "boolean")
    throw new TypeError(atitle2(title) + "expected boolean, got type=" + typeof value);
  return value;
}
function abignumber(n) {
  if (typeof n === "bigint") {
    if (!isPosBig(n))
      throw new RangeError("positive bigint expected, got " + n);
  } else
    anumber2(n);
  return n;
}
function asafenumber(value, title = "") {
  if (typeof value !== "number") {
    const prefix = title && `"${title}" `;
    throw new TypeError(prefix + "expected number, got type=" + typeof value);
  }
  if (!Number.isSafeInteger(value)) {
    const prefix = title && `"${title}" `;
    throw new RangeError(prefix + "expected safe integer, got " + value);
  }
}
function numberToHexUnpadded(num) {
  const hex2 = abignumber(num).toString(16);
  return hex2.length & 1 ? "0" + hex2 : hex2;
}
function hexToNumber(hex2) {
  if (typeof hex2 !== "string")
    throw new TypeError("hex string expected, got " + typeof hex2);
  return hex2 === "" ? _0n : BigInt("0x" + hex2);
}
function bytesToNumberBE(bytes2) {
  return hexToNumber(bytesToHex(bytes2));
}
function bytesToNumberLE(bytes2) {
  return hexToNumber(bytesToHex(copyBytes(abytes(bytes2)).reverse()));
}
function numberToBytesBE(n, len) {
  anumber(len);
  if (len === 0)
    throw new Error("zero output length is invalid");
  n = abignumber(n);
  const expectedLen = len * 2;
  const hex2 = n.toString(16);
  if (hex2.length > expectedLen)
    throw new RangeError("number is too large");
  return hexToBytes(hex2.padStart(expectedLen, "0"));
}
function numberToBytesLE(n, len) {
  return numberToBytesBE(n, len).reverse();
}
function copyBytes(bytes2) {
  return Uint8Array.from(abytes2(bytes2));
}
function isPosBig(n) {
  return typeof n === "bigint" && _0n <= n;
}
function inRange(n, min, max) {
  return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
}
function aInRange(title, n, min, max) {
  if (!inRange(n, min, max))
    throw new RangeError("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
}
function bitLen(n) {
  if (n < _0n)
    throw new Error("expected non-negative bigint, got " + n);
  return n === _0n ? 0 : n.toString(2).length;
}
var bitMask = (n) => {
  asafenumber(n, "n");
  return (_1n << BigInt(n)) - _1n;
};
function createHmacDrbg(hashLen, qByteLen, hmacFn) {
  anumber(hashLen, "hashLen");
  anumber(qByteLen, "qByteLen");
  if (typeof hmacFn !== "function")
    throw new TypeError("hmacFn must be a function");
  const u8n = (len) => new Uint8Array(len);
  const NULL = Uint8Array.of();
  const byte0 = Uint8Array.of(0);
  const byte1 = Uint8Array.of(1);
  const _maxDrbgIters = 1e3;
  let v = u8n(hashLen);
  let k = u8n(hashLen);
  let i = 0;
  const reset = () => {
    v.fill(1);
    k.fill(0);
    i = 0;
  };
  const h = (...msgs) => hmacFn(k, concatBytes2(v, ...msgs));
  const reseed = (seed = NULL) => {
    k = h(byte0, seed);
    v = h();
    if (seed.length === 0)
      return;
    k = h(byte1, seed);
    v = h();
  };
  const gen = () => {
    if (i++ >= _maxDrbgIters)
      throw new Error("drbg: tried max amount of iterations");
    let len = 0;
    const out = [];
    while (len < qByteLen) {
      v = h();
      const sl = v.slice();
      out.push(sl);
      len += v.length;
    }
    return concatBytes2(...out);
  };
  const genUntil = (seed, pred) => {
    reset();
    reseed(seed);
    let res = void 0;
    while ((res = pred(gen())) === void 0)
      reseed();
    reset();
    return res;
  };
  return genUntil;
}
function validateObject(object, fields = {}, optFields = {}, title = "object") {
  aobject2(object, title);
  aobject2(fields, "fields");
  aobject2(optFields, "optFields");
  function checkField(fieldName, expectedType, isOpt) {
    const label2 = title === "object" ? `param "${String(fieldName)}"` : `"${title}.${String(fieldName)}"`;
    const val = object[fieldName];
    if (!Object.hasOwn(object, fieldName) && (isOpt ? val !== void 0 : expectedType !== "function")) {
      throw new TypeError(`${label2} is invalid: expected own property`);
    }
    if (isOpt && val === void 0)
      return;
    const current = typeof val;
    if (current !== expectedType || val === null)
      throw new TypeError(`${label2} is invalid: expected ${expectedType}, got ${current}`);
  }
  const iter = (f, isOpt) => Object.entries(f).forEach(([k, v]) => checkField(k, v, isOpt));
  iter(fields, false);
  iter(optFields, true);
}
var _0n2 = /* @__PURE__ */ BigInt(0);
var _1n2 = /* @__PURE__ */ BigInt(1);
var _2n = /* @__PURE__ */ BigInt(2);
var _3n = /* @__PURE__ */ BigInt(3);
var _4n = /* @__PURE__ */ BigInt(4);
var _5n = /* @__PURE__ */ BigInt(5);
var _7n = /* @__PURE__ */ BigInt(7);
var _8n = /* @__PURE__ */ BigInt(8);
var _9n = /* @__PURE__ */ BigInt(9);
var _15n = /* @__PURE__ */ BigInt(15);
var _16n = /* @__PURE__ */ BigInt(16);
var POW_WINDOWED_MIN = /* @__PURE__ */ BigInt("0x10000000000000000");
function mod(a, b) {
  if (b <= _0n2)
    throw new Error("mod: expected positive modulus, got " + b);
  const result = a % b;
  return result >= _0n2 ? result : b + result;
}
function pow(num, power, modulo) {
  if (modulo <= _1n2)
    throw new Error("pow: expected modulus > 1, got " + modulo);
  if (typeof power !== "bigint")
    throw new TypeError("invalid exponent: expected bigint, got " + typeof power);
  if (power < _0n2)
    throw new Error("invalid exponent, negatives unsupported");
  if (power === _0n2)
    return _1n2;
  if (power === _1n2)
    return num;
  let d = num % modulo;
  if (d < _0n2)
    d += modulo;
  if (power < POW_WINDOWED_MIN) {
    let p2 = _1n2;
    while (power > _0n2) {
      if (power & _1n2)
        p2 = p2 * d % modulo;
      d = d * d % modulo;
      power >>= _1n2;
    }
    return p2;
  }
  const digits = [];
  while (power > _0n2) {
    digits.push(Number(power & _15n));
    power >>= _4n;
  }
  const table = new Array(16);
  table[0] = _1n2;
  table[1] = d;
  for (let i = 2; i < 16; i++)
    table[i] = table[i - 1] * d % modulo;
  let p = table[digits[digits.length - 1]];
  for (let w = digits.length - 2; w >= 0; w--) {
    p = p * p % modulo;
    p = p * p % modulo;
    p = p * p % modulo;
    p = p * p % modulo;
    const digit = digits[w];
    if (digit !== 0)
      p = p * table[digit] % modulo;
  }
  return p;
}
function invert(number, modulo) {
  if (number === _0n2)
    throw new Error("invert: expected non-zero number");
  if (modulo <= _1n2)
    throw new Error("invert: expected modulus > 1, got " + modulo);
  let a = mod(number, modulo);
  let b = modulo;
  let x = _0n2, u = _1n2;
  while (a !== _0n2) {
    const q = b / a;
    const r = b - a * q;
    const m = x - u * q;
    b = a, a = r, x = u, u = m;
  }
  const gcd = b;
  if (gcd !== _1n2)
    throw new Error("invert: does not exist");
  return mod(x, modulo);
}
function invertCt(a, prime) {
  if (prime <= _1n2)
    throw new Error("invertCt: expected prime modulus > 1, got " + prime);
  const an = mod(a, prime);
  if (an === _0n2)
    throw new Error("invertCt: expected non-zero number");
  const inverse = pow(an, prime - _2n, prime);
  if (mod(an * inverse, prime) !== _1n2)
    throw new Error("invertCt: does not exist");
  return inverse;
}
function assertIsSquare(Fp, root, n) {
  const F = Fp;
  if (!F.eql(F.sqr(root), n))
    throw new Error("Cannot find square root");
}
function aoddModulus(order, fnName) {
  if ((order & _1n2) === _0n2)
    throw new Error(fnName + ": expected odd modulus, got " + order);
}
function sqrt3mod4(Fp, n) {
  const F = Fp;
  const p1div4 = (F.ORDER + _1n2) / _4n;
  const root = F.pow(n, p1div4);
  assertIsSquare(F, root, n);
  return root;
}
function sqrt5mod8(Fp, n) {
  const F = Fp;
  const p5div8 = (F.ORDER - _5n) / _8n;
  const n2 = F.mul(n, _2n);
  const v = F.pow(n2, p5div8);
  const nv = F.mul(n, v);
  const i = F.mul(F.mul(nv, _2n), v);
  const root = F.mul(nv, F.sub(i, F.ONE));
  assertIsSquare(F, root, n);
  return root;
}
function sqrt9mod16(P) {
  const Fp_ = Field(P);
  const tn = tonelliShanks(P);
  const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));
  const c2 = tn(Fp_, c1);
  const c3 = tn(Fp_, Fp_.neg(c1));
  const c4 = (P + _7n) / _16n;
  return ((Fp, n) => {
    const F = Fp;
    let tv1 = F.pow(n, c4);
    let tv2 = F.mul(tv1, c1);
    const tv3 = F.mul(tv1, c2);
    const tv4 = F.mul(tv1, c3);
    const e1 = F.eql(F.sqr(tv2), n);
    const e2 = F.eql(F.sqr(tv3), n);
    tv1 = F.cmov(tv1, tv2, e1);
    tv2 = F.cmov(tv4, tv3, e2);
    const e3 = F.eql(F.sqr(tv2), n);
    const root = F.cmov(tv1, tv2, e3);
    assertIsSquare(F, root, n);
    return root;
  });
}
function tonelliShanks(P) {
  if (P < _3n)
    throw new Error("sqrt is not defined for small field");
  aoddModulus(P, "tonelliShanks");
  let Q = P - _1n2;
  let S = 0;
  while (Q % _2n === _0n2) {
    Q /= _2n;
    S++;
  }
  let Z = _2n;
  const _Fp = Field(P);
  while (FpLegendre(_Fp, Z) === 1) {
    if (Z++ > 1e3)
      throw new Error("Cannot find square root: probably non-prime P");
  }
  if (S === 1)
    return sqrt3mod4;
  let cc = _Fp.pow(Z, Q);
  const Q1div2 = (Q + _1n2) / _2n;
  return function tonelliSlow(Fp, n) {
    const F = Fp;
    if (F.is0(n))
      return n;
    if (FpLegendre(F, n) !== 1)
      throw new Error("Cannot find square root");
    let M = S;
    let c = F.mul(F.ONE, cc);
    let t = F.pow(n, Q);
    let R = F.pow(n, Q1div2);
    while (!F.eql(t, F.ONE)) {
      if (F.is0(t))
        throw new Error("Cannot find square root: probably non-prime P");
      let i = 1;
      let t_tmp = F.sqr(t);
      while (!F.eql(t_tmp, F.ONE)) {
        i++;
        t_tmp = F.sqr(t_tmp);
        if (i === M)
          throw new Error("Cannot find square root");
      }
      const exponent = _1n2 << BigInt(M - i - 1);
      const b = F.pow(c, exponent);
      M = i;
      c = F.sqr(b);
      t = F.mul(t, c);
      R = F.mul(R, b);
    }
    return R;
  };
}
function FpSqrt(P) {
  aoddModulus(P, "Fp.sqrt");
  if (P % _4n === _3n)
    return sqrt3mod4;
  if (P % _8n === _5n)
    return sqrt5mod8;
  if (P % _16n === _9n)
    return sqrt9mod16(P);
  return tonelliShanks(P);
}
var FIELD_FIELDS = [
  "create",
  "isValid",
  "is0",
  "neg",
  "inv",
  "sqrt",
  "sqr",
  "eql",
  "add",
  "sub",
  "mul",
  "pow",
  "div",
  "addN",
  "subN",
  "mulN",
  "sqrN"
];
function validateField(field) {
  aobject2(field, "field");
  if (typeof field.ORDER !== "bigint")
    throw new TypeError('param "ORDER" is invalid: expected bigint, got ' + typeof field.ORDER);
  asafenumber(field.BYTES, "BYTES");
  asafenumber(field.BITS, "BITS");
  for (const name of FIELD_FIELDS)
    afunction(field[name], "field." + name);
  if (field.BYTES < 1 || field.BITS < 1)
    throw new Error("invalid field: expected BYTES/BITS > 0");
  if (field.ORDER <= _1n2)
    throw new Error("invalid field: expected ORDER > 1, got " + field.ORDER);
  return field;
}
function FpInvertBatch(Fp, nums, passZero = false) {
  validateField(Fp);
  aarray(nums, "nums");
  abool(passZero, "passZero");
  const F = Fp;
  const inverted = new Array(nums.length).fill(passZero ? F.ZERO : void 0);
  const multipliedAcc = nums.reduce((acc, num, i) => {
    if (F.is0(num))
      return acc;
    inverted[i] = acc;
    return F.mul(acc, num);
  }, F.ONE);
  const invertedAcc = F.inv(multipliedAcc);
  nums.reduceRight((acc, num, i) => {
    if (F.is0(num))
      return acc;
    inverted[i] = F.mul(acc, inverted[i]);
    return F.mul(acc, num);
  }, invertedAcc);
  return inverted;
}
function FpLegendre(Fp, n) {
  validateField(Fp);
  const F = Fp;
  aoddModulus(F.ORDER, "FpLegendre");
  const p1mod2 = (F.ORDER - _1n2) / _2n;
  const powered = F.pow(n, p1mod2);
  const yes = F.eql(powered, F.ONE);
  const zero = F.eql(powered, F.ZERO);
  const no = F.eql(powered, F.neg(F.ONE));
  if (!yes && !zero && !no)
    throw new Error("invalid Legendre symbol result");
  return yes ? 1 : zero ? 0 : -1;
}
function nLength(n, nBitLength) {
  if (nBitLength !== void 0)
    anumber2(nBitLength);
  if (n <= _0n2)
    throw new Error("invalid n length: expected positive n, got " + n);
  if (nBitLength !== void 0 && nBitLength < 1)
    throw new Error("invalid n length: expected positive bit length, got " + nBitLength);
  const bits = bitLen(n);
  if (nBitLength !== void 0 && nBitLength < bits)
    throw new Error(`invalid n length: expected nBitLength (${nBitLength}) >= bitLen(n) (${bits})`);
  const _nBitLength = nBitLength !== void 0 ? nBitLength : bits;
  const nByteLength = Math.ceil(_nBitLength / 8);
  return { nBitLength: _nBitLength, nByteLength };
}
var FIELD_SQRT = /* @__PURE__ */ new WeakMap();
var _Field = class {
  ORDER;
  BITS;
  BYTES;
  isLE;
  ZERO = _0n2;
  ONE = _1n2;
  _lengths;
  _mod;
  constructor(ORDER, opts = {}) {
    if (ORDER <= _1n2)
      throw new Error("invalid field: expected ORDER > 1, got " + ORDER);
    let _nbitLength = void 0;
    this.isLE = false;
    if (opts != null && typeof opts === "object") {
      if (typeof opts.BITS === "number")
        _nbitLength = opts.BITS;
      if (typeof opts.sqrt === "function")
        Object.defineProperty(this, "sqrt", { value: opts.sqrt, enumerable: true });
      if (typeof opts.isLE === "boolean")
        this.isLE = opts.isLE;
      if (opts.allowedLengths)
        this._lengths = Object.freeze(opts.allowedLengths.slice());
      if (typeof opts.modFromBytes === "boolean")
        this._mod = opts.modFromBytes;
    }
    const { nBitLength, nByteLength } = nLength(ORDER, _nbitLength);
    if (nByteLength > 2048)
      throw new Error("invalid field: expected ORDER of <= 2048 bytes");
    this.ORDER = ORDER;
    this.BITS = nBitLength;
    this.BYTES = nByteLength;
    Object.freeze(this);
  }
  create(num) {
    return mod(num, this.ORDER);
  }
  isValid(num) {
    if (typeof num !== "bigint")
      throw new TypeError("invalid field element: expected bigint, got " + typeof num);
    return _0n2 <= num && num < this.ORDER;
  }
  is0(num) {
    return num === _0n2;
  }
  // is valid and invertible
  isValidNot0(num) {
    return !this.is0(num) && this.isValid(num);
  }
  isOdd(num) {
    return (num & _1n2) === _1n2;
  }
  neg(num) {
    return mod(-num, this.ORDER);
  }
  eql(lhs, rhs) {
    return lhs === rhs;
  }
  sqr(num) {
    return mod(num * num, this.ORDER);
  }
  add(lhs, rhs) {
    return mod(lhs + rhs, this.ORDER);
  }
  sub(lhs, rhs) {
    return mod(lhs - rhs, this.ORDER);
  }
  mul(lhs, rhs) {
    return mod(lhs * rhs, this.ORDER);
  }
  pow(num, power) {
    return pow(num, power, this.ORDER);
  }
  div(lhs, rhs) {
    return mod(lhs * invert(rhs, this.ORDER), this.ORDER);
  }
  // Same as above, but doesn't normalize
  sqrN(num) {
    return num * num;
  }
  addN(lhs, rhs) {
    return lhs + rhs;
  }
  subN(lhs, rhs) {
    return lhs - rhs;
  }
  mulN(lhs, rhs) {
    return lhs * rhs;
  }
  inv(num) {
    return invert(num, this.ORDER);
  }
  sqrt(num) {
    let sqrt = FIELD_SQRT.get(this);
    if (!sqrt)
      FIELD_SQRT.set(this, sqrt = FpSqrt(this.ORDER));
    return sqrt(this, num);
  }
  toBytes(num) {
    return this.isLE ? numberToBytesLE(num, this.BYTES) : numberToBytesBE(num, this.BYTES);
  }
  fromBytes(bytes2, skipValidation = false) {
    abytes2(bytes2);
    const { _lengths: allowedLengths, BYTES, isLE, ORDER, _mod: modFromBytes } = this;
    if (allowedLengths) {
      if (bytes2.length < 1 || !allowedLengths.includes(bytes2.length) || bytes2.length > BYTES) {
        throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes2.length);
      }
      const padded = new Uint8Array(BYTES);
      padded.set(bytes2, isLE ? 0 : padded.length - bytes2.length);
      bytes2 = padded;
    }
    if (bytes2.length !== BYTES)
      throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes2.length);
    let scalar = isLE ? bytesToNumberLE(bytes2) : bytesToNumberBE(bytes2);
    if (modFromBytes)
      scalar = mod(scalar, ORDER);
    if (!skipValidation) {
      if (!this.isValid(scalar))
        throw new Error("invalid field element: outside of range 0..ORDER");
    }
    return scalar;
  }
  // TODO: we don't need it here, move out to separate fn
  invertBatch(lst) {
    return FpInvertBatch(this, lst, true);
  }
  // We can't move this out because Fp6, Fp12 implement it
  // and it's unclear what to return in there.
  cmov(a, b, condition) {
    abool(condition, "condition");
    return condition ? b : a;
  }
};
function Field(ORDER, opts = {}) {
  Object.freeze(_Field.prototype);
  return new _Field(ORDER, opts);
}
function getFieldBytesLength(fieldOrder) {
  if (typeof fieldOrder !== "bigint")
    throw new Error("field order must be bigint");
  if (fieldOrder <= _1n2)
    throw new Error("field order must be greater than 1");
  const bitLength = bitLen(fieldOrder - _1n2);
  return Math.ceil(bitLength / 8);
}
function getMinHashLength(fieldOrder) {
  const length = getFieldBytesLength(fieldOrder);
  return length + Math.ceil(length / 2);
}
function mapHashToField(key, fieldOrder, isLE = false) {
  abytes2(key);
  const len = key.length;
  const fieldLen = getFieldBytesLength(fieldOrder);
  const minLen = Math.max(getMinHashLength(fieldOrder), 16);
  if (len < minLen || len > 1024)
    throw new Error("expected " + minLen + "-1024 bytes of input, got " + len);
  const num = isLE ? bytesToNumberLE(key) : bytesToNumberBE(key);
  const reduced = mod(num, fieldOrder - _1n2) + _1n2;
  return isLE ? numberToBytesLE(reduced, fieldLen) : numberToBytesBE(reduced, fieldLen);
}
var _0n3 = /* @__PURE__ */ BigInt(0);
var _1n3 = /* @__PURE__ */ BigInt(1);
var _4n2 = /* @__PURE__ */ BigInt(4);
var BLIND_BYTES = 16;
var BLIND_BITS = 128;
var FW_WINDOW = 5;
var TABLE_BYTES_MAX = /* @__PURE__ */ (() => 2 ** 31)();
function validatePointCons(Point) {
  const pc = Point;
  if (typeof pc !== "function")
    throw new TypeError('"Point" expected constructor, got type=' + typeof Point);
  afunction(pc.fromAffine, "Point.fromAffine");
  afunction(pc.fromBytes, "Point.fromBytes");
  afunction(pc.fromHex, "Point.fromHex");
  aobject2(pc.BASE, "Point.BASE");
  aobject2(pc.ZERO, "Point.ZERO");
  validateField(pc.Fp);
  validateField(pc.Fn);
}
function normalizeZ(c, points) {
  validatePointCons(c);
  validateMSMPoints(points, c);
  const invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));
  return points.map((p, i) => c.fromAffine(p.toAffine(invertedZs[i])));
}
function validateW(W, bits, min = 1) {
  if (!Number.isSafeInteger(W) || W < min || W > bits)
    throw new Error("invalid window size, expected [" + min + ".." + bits + "], got W=" + W);
}
function validateTableBytes(numPoints, fpBytes) {
  const bytes2 = numPoints * (4 * fpBytes + 128);
  if (bytes2 > TABLE_BYTES_MAX)
    throw new Error("invalid window size: table would need ~" + Math.ceil(bytes2 / 2 ** 20) + " MiB, max " + TABLE_BYTES_MAX / 2 ** 20 + " MiB");
}
function probeRandomBytes(randomBytes32, length) {
  if (randomBytes32 === void 0)
    return void 0;
  afunction(randomBytes32, "randomBytes");
  try {
    const probe = randomBytes32(length);
    if (!isBytes2(probe) || probe.length !== length)
      return void 0;
  } catch {
    return void 0;
  }
  return randomBytes32;
}
function validateMSMPoints(points, c) {
  aarray(points, "points");
  points.forEach((p, i) => {
    if (!(p instanceof c))
      throw new Error("invalid point at index " + i);
  });
}
function validateMSMScalars(scalars, field, maxScalar) {
  if (!Array.isArray(scalars))
    throw new Error("array of scalars expected");
  scalars.forEach((s, i) => {
    const ok = maxScalar === void 0 ? field.isValid(s) : isPosBig(s) && s < maxScalar;
    if (!ok)
      throw new Error("invalid scalar at index " + i);
  });
}
var pointWindowSizes = /* @__PURE__ */ new WeakMap();
function getWindowSize(P) {
  return pointWindowSizes.get(P) || 1;
}
function oddMultiples(p, size) {
  const dbl = p.double();
  const t = [p];
  for (let j = 1; j < size; j++)
    t.push(t[j - 1].add(dbl));
  return t;
}
function wnafDigits(n, W) {
  const size = 2 ** W;
  const half = size / 2;
  const mask = BigInt(size - 1);
  const d = [];
  while (n > _0n3) {
    let w = 0;
    if (n & _1n3) {
      w = Number(n & mask);
      if (w >= half)
        w -= size;
      n -= BigInt(w);
    }
    d.push(w);
    n >>= _1n3;
  }
  return d;
}
function signedWindowDigits(n, W, windows) {
  const size = 2 ** W;
  const half = size / 2;
  const mask = BigInt(size - 1);
  const shiftBy = BigInt(W);
  const d = [];
  for (let w = 0; w < windows; w++) {
    let v = Number(n & mask);
    n >>= shiftBy;
    if (v > half) {
      v -= size;
      n += _1n3;
    }
    d.push(v);
  }
  if (n !== _0n3)
    throw new Error("invalid wnaf");
  return d;
}
function wnafWalk(zero, tables, digits) {
  let max = 0;
  for (const d of digits)
    max = Math.max(max, d.length);
  let acc = zero;
  for (let bit = max - 1; bit >= 0; bit--) {
    if (bit !== max - 1)
      acc = acc.double();
    for (let i = 0; i < digits.length; i++) {
      const w = digits[i][bit];
      if (w) {
        const item = tables[i][Math.abs(w) - 1 >> 1];
        acc = acc.add(w < 0 ? item.negate() : item);
      }
    }
  }
  return acc;
}
var ScalarMultiplier = class {
  Point;
  BASE;
  ZERO;
  randomBytes;
  wnafPrecomputes = /* @__PURE__ */ new WeakMap();
  baseCanBeBlinded;
  bits;
  // Parametrized with a given Point class (not individual point)
  constructor(Point, randomBytes32) {
    validatePointCons(Point);
    this.randomBytes = probeRandomBytes(randomBytes32, BLIND_BYTES);
    this.Point = Point;
    this.BASE = Point.BASE;
    this.ZERO = Point.ZERO;
    this.bits = Point.Fn.BITS;
  }
  /**
   * Creates a signed fixed-window wNAF precomputation table: for every window w, the
   * multiples `[1..2^(W−1)]⋅2^(w⋅W)⋅P`, flattened. All doublings are baked into the table,
   * so cached multiplication is additions-only. `windows = ceil(bits/W) + 1`: the extra
   * window absorbs the final carry of signed-digit recoding.
   * For a 256-bit curve and W=6, the table is 44⋅32 = 1408 points.
   * @param point - Point instance
   * @param W - window size
   * @param bits - scalar bitlength the table must cover
   */
  buildWnafTable(point, W, bits) {
    const windows = Math.ceil(bits / W) + 1;
    const half = 2 ** (W - 1);
    const comp = [];
    let base = point;
    for (let w = 0; w < windows; w++) {
      let acc = base;
      for (let i = 0; i < half; i++) {
        comp.push(acc);
        acc = acc.add(base);
      }
      base = comp[comp.length - 1].double();
    }
    return { W, bits, windows, comp };
  }
  /**
   * Implements ec multiplication using precomputed signed fixed-window wNAF tables.
   * Constant-time: fixed window count with one table addition per window — zero digits feed
   * the fake accumulator — and no doublings; the lookup scans the whole window slice.
   * Scalar bounds are validated by the public entry points ({@link ScalarMultiplier.mulCT},
   * {@link ScalarMultiplier.mulCTBlinded}, {@link ScalarMultiplier.mulUnsafe});
   * signedWindowDigits throws if `n` exceeds the table.
   * @returns real and fake (for const-time) points
   */
  wnafCachedCT(precomputes, n) {
    const { W, windows, comp } = precomputes;
    const half = 2 ** (W - 1);
    const digits = signedWindowDigits(n, W, windows);
    let p = this.ZERO;
    let f = this.BASE;
    for (let w = 0; w < windows; w++) {
      const digit = digits[w];
      const start = w * half;
      const idx = Math.abs(digit) - 1;
      let sel = comp[start];
      for (let i = 1; i < half; i++)
        sel = i === idx ? comp[start + i] : sel;
      const neg = sel.negate();
      if (digit === 0)
        f = f.add(comp[start]);
      else
        p = p.add(digit < 0 ? neg : sel);
    }
    return { p, f };
  }
  // Cache key is point identity plus (W, bits); at most two entries exist per point (public-width
  // `Fn.BITS` and blinded `Fn.BITS + BLIND_BITS`). Callers must not reuse the same point with
  // incompatible `transform(...)` layouts and expect a separate cache entry.
  getWnafPrecomputes(W, point, bits, transform) {
    let entries = this.wnafPrecomputes.get(point);
    let comp = entries?.find((entry) => entry.W === W && entry.bits === bits);
    if (!comp) {
      comp = this.buildWnafTable(point, W, bits);
      if (typeof transform === "function")
        comp = { ...comp, comp: transform(comp.comp) };
      if (!entries) {
        entries = [];
        this.wnafPrecomputes.set(point, entries);
      }
      entries.push(comp);
    }
    return comp;
  }
  assertPoint(point) {
    if (!(point instanceof this.Point))
      throw new TypeError('"point" expected Point instance, got type=' + typeof point);
  }
  // Shared prologue of the constant-time entry points. Rejects scalar 0: in key/signature-style
  // callers a zero scalar means broken upstream plumbing, and concrete Points already reject it.
  // Uses inRange instead of Fn.isValidNot0: validateField() only certifies the arithmetic subset.
  validateMulInput(point, scalar) {
    this.assertPoint(point);
    if (!inRange(scalar, _1n3, this.Point.Fn.ORDER))
      throw new Error("invalid scalar");
  }
  // Constant-time dispatch shared by mulCT / mulCTBlinded. Un-precomputed points (W===1, e.g.
  // ECDH peer keys) skip building a throwaway cached table in favor of a small fixed-window
  // multiply. `n` must be < 2^bits.
  runCT(point, n, bits, transform) {
    const W = getWindowSize(point);
    if (W === 1)
      return this.fixedWindowCT(point, n, bits);
    return this.wnafCachedCT(this.getWnafPrecomputes(W, point, bits, transform), n);
  }
  mulCT(point, scalar, transform) {
    this.validateMulInput(point, scalar);
    return this.runCT(point, scalar, this.bits, transform);
  }
  mulCTBlinded(point, scalar, transform) {
    this.validateMulInput(point, scalar);
    if (this.randomBytes === void 0)
      throw new Error("randomBytes is required for scalar blinding");
    const bits = this.Point.Fn.BITS + BLIND_BITS;
    const blind = this.randomBytes(BLIND_BYTES);
    if (!isBytes2(blind) || blind.length !== BLIND_BYTES)
      throw new Error("randomBytes returned invalid byte array");
    blind[0] = blind[0] & 63 | 128;
    const n = scalar + bytesToNumberBE(blind) * this.Point.Fn.ORDER;
    return this.runCT(point, n, bits, transform);
  }
  /**
   * Constant-time multiplication `n*point` for an un-precomputed point, via a small fixed window.
   * A cached wNAF table only pays off when reused; a flat 2^FW_WINDOW table (`size-1` adds) is
   * far cheaper to build for a single use. The point-operation sequence is independent of `n`:
   * build the table, then per window exactly FW_WINDOW doublings, a data-oblivious scan over
   * every table entry, and one addition (adds the identity when the window digit is 0 — never
   * skipped).
   *
   * `n` must be `< 2^bits`. Assumes complete addition (adding the identity costs the same as any
   * add), which holds for the Weierstrass/Edwards point types used here. The table is left in
   * projective form (no normalizeZ): normalizing this small a table costs more than the
   * mixed-add savings it would buy for a single multiply.
   * @returns real point `p`; `f` duplicates it only to match {@link wnafCachedCT}'s return shape
   * (this path needs no fake accumulator — its op-count is already scalar-independent).
   */
  fixedWindowCT(point, n, bits) {
    const W = FW_WINDOW;
    const size = 1 << W;
    const mask = bitMask(W);
    const table = new Array(size);
    table[0] = this.ZERO;
    for (let i = 1; i < size; i++)
      table[i] = table[i - 1].add(point);
    const windows = Math.ceil(bits / W);
    let acc = this.ZERO;
    for (let window = windows - 1; window >= 0; window--) {
      if (window !== windows - 1)
        for (let d = 0; d < W; d++)
          acc = acc.double();
      const digit = Number(n >> BigInt(window * W) & mask);
      let sel = table[0];
      for (let i = 1; i < size; i++)
        sel = i === digit ? table[i] : sel;
      acc = acc.add(sel);
    }
    return { p: acc, f: acc };
  }
  shouldBlind(point, cofactor) {
    if (this.randomBytes === void 0)
      return false;
    if (cofactor === _1n3)
      return true;
    if (point !== this.BASE)
      return false;
    if (this.baseCanBeBlinded === void 0)
      this.baseCanBeBlinded = this.mulUnsafe(this.BASE, this.Point.Fn.ORDER).is0();
    return this.baseCanBeBlinded;
  }
  mulSecret(point, scalar, cofactor, transform) {
    return this.shouldBlind(point, cofactor) ? this.mulCTBlinded(point, scalar, transform) : this.mulCT(point, scalar, transform);
  }
  mulUnsafe(point, scalar, transform) {
    this.assertPoint(point);
    if (!isPosBig(scalar))
      throw new Error("invalid scalar");
    const W = getWindowSize(point);
    if (W === 1 || scalar >= this.Point.Fn.ORDER)
      return mulAddUnsafe(this.Point, [point], [scalar], true);
    const precomputes = this.getWnafPrecomputes(W, point, this.bits, transform);
    return this.wnafCachedCT(precomputes, scalar).p;
  }
  // Remembers the window size used for precomputed wNAF multiplication of the given point
  // and drops any previously built tables. Usually only the base point is precomputed.
  // W=1 resets the point to the un-precomputed (table-less) paths.
  // W is additionally capped so tables stay under ~2 GiB ({@link TABLE_BYTES_MAX}).
  setWindowSize(point, W) {
    this.assertPoint(point);
    validateW(W, this.bits);
    const windows = Math.ceil((this.bits + BLIND_BITS) / W) + 1;
    validateTableBytes(windows * 2 ** (W - 1), this.Point.Fp.BYTES);
    pointWindowSizes.set(point, W);
    this.wnafPrecomputes.delete(point);
  }
  // True when a window size is set: tables themselves are built lazily on first multiply.
  hasWindowSize(point) {
    return getWindowSize(point) !== 1;
  }
};
function mulAddUnsafe(c, points, scalars, allowOversized = false) {
  validatePointCons(c);
  validateMSMPoints(points, c);
  abool(allowOversized, "allowOversized");
  validateMSMScalars(scalars, c.Fn, allowOversized ? c.Fn.ORDER ** _4n2 : void 0);
  if (points.length !== scalars.length)
    throw new Error("arrays of points and scalars must have equal length");
  const tables = points.map((p) => oddMultiples(p, 4));
  const digits = scalars.map((n) => wnafDigits(n, 4));
  return wnafWalk(c.ZERO, tables, digits);
}
function createField(order, field, isLE) {
  if (field) {
    if (field.ORDER !== order)
      throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
    validateField(field);
    return field;
  } else {
    return Field(order, { isLE });
  }
}
function createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
  if (type !== "weierstrass" && type !== "edwards")
    throw new Error('expected curve type "weierstrass" or "edwards"');
  if (FpFnLE === void 0)
    FpFnLE = type === "edwards";
  if (!CURVE || typeof CURVE !== "object")
    throw new Error(`expected valid ${type} CURVE object`);
  validateObject(curveOpts);
  for (const p of ["p", "n", "h"]) {
    const val = CURVE[p];
    if (!(isPosBig(val) && val !== _0n3))
      throw new Error(`CURVE.${p} must be positive bigint`);
  }
  const Fp = createField(CURVE.p, curveOpts.Fp, FpFnLE);
  const Fn = createField(CURVE.n, curveOpts.Fn, FpFnLE);
  const _b = type === "weierstrass" ? "b" : "d";
  const params = ["Gx", "Gy", "a", _b];
  for (const p of params) {
    if (!Fp.isValid(CURVE[p]))
      throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
  }
  CURVE = Object.freeze(Object.assign({}, CURVE));
  return { CURVE, Fp, Fn };
}
function createKeygen(randomSecretKey, getPublicKey) {
  return function keygen(seed) {
    const secretKey = randomSecretKey(seed);
    return { secretKey, publicKey: getPublicKey(secretKey) };
  };
}
var _HMAC = class {
  oHash;
  iHash;
  blockLen;
  outputLen;
  canXOF = false;
  finished = false;
  destroyed = false;
  constructor(hash, key) {
    ahash(hash);
    abytes(key, void 0, "key");
    this.iHash = hash.create();
    if (typeof this.iHash.update !== "function")
      throw new Error("expected Hash instance");
    this.blockLen = this.iHash.blockLen;
    this.outputLen = this.iHash.outputLen;
    const blockLen = this.blockLen;
    const pad = new Uint8Array(blockLen);
    pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54;
    this.iHash.update(pad);
    this.oHash = hash.create();
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54 ^ 92;
    this.oHash.update(pad);
    clean(pad);
  }
  update(buf) {
    aexists(this);
    this.iHash.update(buf);
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const buf = out.subarray(0, this.outputLen);
    this.iHash.digestInto(buf);
    this.oHash.update(buf);
    this.oHash.digestInto(buf);
    this.destroy();
  }
  digest() {
    const out = new Uint8Array(this.oHash.outputLen);
    this.digestInto(out);
    return out;
  }
  _cloneInto(to) {
    to ||= Object.create(Object.getPrototypeOf(this), {});
    const { oHash, iHash, finished, destroyed, blockLen, outputLen, canXOF } = this;
    to = to;
    to.finished = finished;
    to.destroyed = destroyed;
    to.blockLen = blockLen;
    to.outputLen = outputLen;
    to.canXOF = canXOF;
    to.oHash = oHash._cloneInto(to.oHash);
    to.iHash = iHash._cloneInto(to.iHash);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
  destroy() {
    this.destroyed = true;
    this.oHash.destroy();
    this.iHash.destroy();
  }
};
var hmac = /* @__PURE__ */ (() => {
  const hmac_ = ((hash, key, message) => new _HMAC(hash, key).update(message).digest());
  hmac_.create = (hash, key) => new _HMAC(hash, key);
  return hmac_;
})();
var _0n4 = /* @__PURE__ */ BigInt(0);
var DERErr = class extends Error {
  constructor(m = "") {
    super(m);
  }
};
var _DER = {
  // asn.1 DER encoding utils
  Err: DERErr,
  // Basic building block is TLV (Tag-Length-Value)
  _tlv: {
    encode: (tag, data) => {
      const { Err: E } = _DER;
      asafenumber(tag, "tag");
      if (tag < 0 || tag > 255)
        throw new E("tlv.encode: wrong tag");
      astring(data, "data");
      if (data.length & 1)
        throw new E("tlv.encode: unpadded data");
      const dataLen = data.length / 2;
      const len = numberToHexUnpadded(dataLen);
      if (len.length / 2 & 128)
        throw new E("tlv.encode: long form length too big");
      const lenLen = dataLen > 127 ? numberToHexUnpadded(len.length / 2 | 128) : "";
      const t = numberToHexUnpadded(tag);
      return t + lenLen + len + data;
    },
    // v - value, l - left bytes (unparsed)
    decode(tag, data) {
      const { Err: E } = _DER;
      data = abytes2(data, void 0, "DER data");
      let pos = 0;
      if (tag < 0 || tag > 255)
        throw new E("tlv.decode: wrong tag");
      if (data.length < 2 || data[pos++] !== tag)
        throw new E("tlv.decode: wrong tlv");
      const first = data[pos++];
      const isLong = !!(first & 128);
      let length = 0;
      if (!isLong)
        length = first;
      else {
        const lenLen = first & 127;
        if (!lenLen)
          throw new E("tlv.decode(long): indefinite length not supported");
        if (lenLen > 4)
          throw new E("tlv.decode(long): byte length is too big");
        const lengthBytes = data.subarray(pos, pos + lenLen);
        if (lengthBytes.length !== lenLen)
          throw new E("tlv.decode: length bytes not complete");
        if (lengthBytes[0] === 0)
          throw new E("tlv.decode(long): zero leftmost byte");
        for (const b of lengthBytes)
          length = length << 8 | b;
        pos += lenLen;
        if (length < 128)
          throw new E("tlv.decode(long): not minimal encoding");
      }
      const v = data.subarray(pos, pos + length);
      if (v.length !== length)
        throw new E("tlv.decode: wrong value length");
      return { v, l: data.subarray(pos + length) };
    }
  },
  // https://crypto.stackexchange.com/a/57734 Leftmost bit of first byte is 'negative' flag,
  // since we always use positive integers here. It must always be empty:
  // - add zero byte if exists
  // - if next byte doesn't have a flag, leading zero is not allowed (minimal encoding)
  _int: {
    encode(num) {
      const { Err: E } = _DER;
      abignumber(num);
      if (num < _0n4)
        throw new E("integer: negative integers are not allowed");
      let hex2 = numberToHexUnpadded(num);
      if (Number.parseInt(hex2[0], 16) & 8)
        hex2 = "00" + hex2;
      if (hex2.length & 1)
        throw new E("unexpected DER parsing assertion: unpadded hex");
      return hex2;
    },
    decode(data) {
      const { Err: E } = _DER;
      if (data.length < 1)
        throw new E("invalid signature integer: empty");
      if (data[0] & 128)
        throw new E("invalid signature integer: negative");
      if (data.length > 1 && data[0] === 0 && !(data[1] & 128))
        throw new E("invalid signature integer: unnecessary leading zero");
      return bytesToNumberBE(data);
    }
  },
  toSig(bytes2, maxScalarBytes) {
    const { Err: E, _int: int, _tlv: tlv } = _DER;
    if (maxScalarBytes !== void 0) {
      asafenumber(maxScalarBytes, "maxScalarBytes");
      if (maxScalarBytes < 1)
        throw new E("invalid signature: maxScalarBytes must be positive");
    }
    const data = abytes2(bytes2, void 0, "signature");
    const { v: seqBytes, l: seqLeftBytes } = tlv.decode(48, data);
    if (seqLeftBytes.length)
      throw new E("invalid signature: left bytes after parsing");
    const { v: rBytes, l: rLeftBytes } = tlv.decode(2, seqBytes);
    const { v: sBytes, l: sLeftBytes } = tlv.decode(2, rLeftBytes);
    if (sLeftBytes.length)
      throw new E("invalid signature: left bytes after parsing");
    if (maxScalarBytes !== void 0 && (rBytes.length > maxScalarBytes || sBytes.length > maxScalarBytes))
      throw new E("invalid signature: integer too large");
    return { r: int.decode(rBytes), s: int.decode(sBytes) };
  },
  hexFromSig(sig) {
    const { _tlv: tlv, _int: int } = _DER;
    validateObject(sig, { r: "bigint", s: "bigint" }, {}, "sig");
    const rs = tlv.encode(2, int.encode(sig.r));
    const ss = tlv.encode(2, int.encode(sig.s));
    const seq = rs + ss;
    return tlv.encode(48, seq);
  }
};
var DER = /* @__PURE__ */ (() => {
  Object.freeze(_DER._tlv);
  Object.freeze(_DER._int);
  return Object.freeze(_DER);
})();
var divNearest = (num, den) => (num + (num >= 0 ? den : -den) / _2n2) / den;
function _splitEndoScalar(k, basis, n) {
  aInRange("scalar", k, _0n5, n);
  const [[a1, b1], [a2, b2]] = basis;
  const c1 = divNearest(b2 * k, n);
  const c2 = divNearest(-b1 * k, n);
  let k1 = k - c1 * a1 - c2 * a2;
  let k2 = -c1 * b1 - c2 * b2;
  const k1neg = k1 < _0n5;
  const k2neg = k2 < _0n5;
  if (k1neg)
    k1 = -k1;
  if (k2neg)
    k2 = -k2;
  const MAX_NUM = bitMask(Math.ceil(bitLen(n) / 2)) + _1n4;
  if (k1 < _0n5 || k1 >= MAX_NUM || k2 < _0n5 || k2 >= MAX_NUM) {
    throw new Error("splitScalar (endomorphism): failed for k");
  }
  return { k1neg, k1, k2neg, k2 };
}
function validateSigFormat(format) {
  if (!["compact", "recovered", "der"].includes(format))
    throw new Error('Signature format must be "compact", "recovered", or "der"');
  return format;
}
function validateSigOpts(opts, def) {
  validateObject(opts);
  const optsn = {};
  for (let optName of Object.keys(def)) {
    optsn[optName] = opts[optName] === void 0 ? def[optName] : opts[optName];
  }
  abool(optsn.lowS, "lowS");
  abool(optsn.prehash, "prehash");
  if (optsn.format !== void 0)
    validateSigFormat(optsn.format);
  return optsn;
}
var _0n5 = /* @__PURE__ */ BigInt(0);
var _1n4 = /* @__PURE__ */ BigInt(1);
var _2n2 = /* @__PURE__ */ BigInt(2);
var _3n2 = /* @__PURE__ */ BigInt(3);
var _4n3 = /* @__PURE__ */ BigInt(4);
function weierstrass(params, extraOpts = {}) {
  const validated = createCurveFields("weierstrass", params, extraOpts);
  const Fp = validated.Fp;
  const Fn = validated.Fn;
  let CURVE = validated.CURVE;
  const { h: cofactor, n: CURVE_ORDER } = CURVE;
  validateObject(extraOpts, {}, {
    allowInfinityPoint: "boolean",
    clearCofactor: "function",
    isTorsionFree: "function",
    fromBytes: "function",
    toBytes: "function",
    endo: "object",
    randomBytes: "function"
  });
  const { endo: endoOpts, allowInfinityPoint, clearCofactor, isTorsionFree, fromBytes, toBytes } = extraOpts;
  const randomBytes32 = extraOpts.randomBytes === void 0 ? randomBytes2 : extraOpts.randomBytes;
  if (endoOpts) {
    if (!Fp.is0(CURVE.a) || typeof endoOpts.beta !== "bigint" || !Array.isArray(endoOpts.basises)) {
      throw new Error('invalid endo: expected "beta": bigint and "basises": array');
    }
  }
  const endo = endoOpts ? {
    beta: endoOpts.beta,
    basises: endoOpts.basises.map((basis) => [...basis])
  } : void 0;
  const lengths = getWLengths(Fp, Fn);
  function assertCompressionIsSupported() {
    if (!Fp.isOdd)
      throw new Error("compression is not supported: Field does not have .isOdd()");
  }
  function pointToBytes(_c, point, isCompressed) {
    if (point.is0()) {
      if (!allowInfinityPoint)
        throw new Error("bad point: ZERO");
      return Uint8Array.of(0);
    }
    const { x, y } = point.toAffine();
    const bx = Fp.toBytes(x);
    abool(isCompressed, "isCompressed");
    if (isCompressed) {
      assertCompressionIsSupported();
      const hasEvenY = !Fp.isOdd(y);
      return concatBytes2(pprefix(hasEvenY), bx);
    } else {
      return concatBytes2(Uint8Array.of(4), bx, Fp.toBytes(y));
    }
  }
  function pointFromBytes(bytes2) {
    abytes2(bytes2, void 0, "Point");
    const { publicKey: comp, publicKeyUncompressed: uncomp } = lengths;
    const length = bytes2.length;
    const head = bytes2[0];
    const tail = bytes2.subarray(1);
    if (allowInfinityPoint && length === 1 && head === 0)
      return { x: Fp.ZERO, y: Fp.ZERO };
    if (length === comp && (head === 2 || head === 3)) {
      const x = Fp.fromBytes(tail);
      if (!Fp.isValid(x))
        throw new Error("bad point: is not on curve, wrong x");
      const y2 = weierstrassEquation(x);
      let y;
      try {
        y = Fp.sqrt(y2);
      } catch (sqrtError) {
        const err = sqrtError instanceof Error ? ": " + sqrtError.message : "";
        throw new Error("bad point: is not on curve, sqrt error" + err);
      }
      assertCompressionIsSupported();
      const evenY = Fp.isOdd(y);
      const evenH = (head & 1) === 1;
      if (evenH !== evenY)
        y = Fp.neg(y);
      return { x, y };
    } else if (length === uncomp && head === 4) {
      const L = Fp.BYTES;
      const x = Fp.fromBytes(tail.subarray(0, L));
      const y = Fp.fromBytes(tail.subarray(L, L * 2));
      if (!isValidXY(x, y))
        throw new Error("bad point: is not on curve");
      return { x, y };
    } else {
      throw new Error(`bad point: got length ${length}, expected compressed=${comp} or uncompressed=${uncomp}`);
    }
  }
  const encodePoint = toBytes === void 0 ? pointToBytes : toBytes;
  const decodePoint = fromBytes === void 0 ? pointFromBytes : fromBytes;
  const b3 = Fp.mul(CURVE.b, _3n2);
  const mulA = Fp.is0(CURVE.a) ? (_) => Fp.ZERO : (x) => Fp.mul(CURVE.a, x);
  function weierstrassEquation(x) {
    const x2 = Fp.sqr(x);
    const x3 = Fp.mul(x2, x);
    return Fp.add(Fp.add(x3, Fp.mul(x, CURVE.a)), CURVE.b);
  }
  function isValidXY(x, y) {
    const left = Fp.sqr(y);
    const right = weierstrassEquation(x);
    return Fp.eql(left, right);
  }
  if (!isValidXY(CURVE.Gx, CURVE.Gy))
    throw new Error("bad curve params: generator point");
  const _4a3 = Fp.mul(Fp.pow(CURVE.a, _3n2), _4n3);
  const _27b2 = Fp.mul(Fp.sqr(CURVE.b), BigInt(27));
  if (Fp.is0(Fp.add(_4a3, _27b2)))
    throw new Error("bad curve params: a or b");
  function acoord(title, n, banZero = false) {
    if (!Fp.isValid(n) || banZero && Fp.is0(n))
      throw new Error(`bad point coordinate ${title}`);
    return typeof n === "object" && n !== null ? Fp.create(n) : n;
  }
  function aprjpoint(other) {
    if (!(other instanceof Point))
      throw new Error("Weierstrass Point expected");
  }
  function splitEndoScalarN(k) {
    if (!endo || !endo.basises)
      throw new Error("no endo");
    return _splitEndoScalar(k, endo.basises, Fn.ORDER);
  }
  function pushWnafPair(points, scalars, p, k) {
    if (!Fn.isValid(k))
      throw new RangeError("invalid scalar: out of range");
    if (endo) {
      const { k1neg, k1, k2neg, k2 } = splitEndoScalarN(k);
      const psi = new Point(Fp.mul(p.X, endo.beta), p.Y, p.Z);
      points.push(k1neg ? p.negate() : p, k2neg ? psi.negate() : psi);
      scalars.push(k1, k2);
    } else {
      points.push(p);
      scalars.push(k);
    }
  }
  const validityCache = /* @__PURE__ */ new WeakSet();
  class Point {
    static BASE = new Point(CURVE.Gx, CURVE.Gy, Fp.ONE);
    static ZERO = new Point(Fp.ZERO, Fp.ONE, Fp.ZERO);
    static Fp = Fp;
    static Fn = Fn;
    X;
    Y;
    Z;
    /** Does NOT validate if the point is valid. Use `.assertValidity()`. */
    constructor(X, Y, Z) {
      this.X = acoord("x", X);
      this.Y = acoord("y", Y, true);
      this.Z = acoord("z", Z);
      Object.freeze(this);
    }
    static CURVE() {
      return CURVE;
    }
    /** Does NOT validate if the point is valid. Use `.assertValidity()`. */
    static fromAffine(p) {
      const { x, y } = p || {};
      if (!p || !Fp.isValid(x) || !Fp.isValid(y))
        throw new Error("invalid affine point");
      if (p instanceof Point)
        throw new Error("projective point not allowed");
      if (Fp.is0(x) && Fp.is0(y))
        return Point.ZERO;
      return new Point(x, y, Fp.ONE);
    }
    static fromBytes(bytes2) {
      const P = Point.fromAffine(decodePoint(abytes2(bytes2, void 0, "point")));
      P.assertValidity();
      return P;
    }
    static fromHex(hex2) {
      return Point.fromBytes(hexToBytes2(hex2));
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    /**
     * @param isLazy - true will defer table computation until the first multiplication
     */
    precompute(windowSize = 6, isLazy = true) {
      wnaf.setWindowSize(this, windowSize);
      if (!isLazy)
        this.multiply(_3n2);
      return this;
    }
    // TODO: return `this`
    /** A point on curve is valid if it conforms to equation. */
    assertValidity() {
      const p = this;
      if (p.is0()) {
        if (allowInfinityPoint && Fp.is0(p.X) && Fp.eql(p.Y, Fp.ONE) && Fp.is0(p.Z))
          return;
        throw new Error("bad point: ZERO");
      }
      if (validityCache.has(p))
        return;
      const { x, y } = p.toAffine();
      if (!Fp.isValid(x) || !Fp.isValid(y))
        throw new Error("bad point: x or y not field elements");
      if (!isValidXY(x, y))
        throw new Error("bad point: equation left != right");
      if (!p.isTorsionFree())
        throw new Error("bad point: not in prime-order subgroup");
      validityCache.add(p);
    }
    hasEvenY() {
      const { y } = this.toAffine();
      if (!Fp.isOdd)
        throw new Error("Field doesn't support isOdd");
      return !Fp.isOdd(y);
    }
    /** Compare one point to another. */
    equals(other) {
      aprjpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      const U1 = Fp.eql(Fp.mul(X1, Z2), Fp.mul(X2, Z1));
      const U2 = Fp.eql(Fp.mul(Y1, Z2), Fp.mul(Y2, Z1));
      return U1 && U2;
    }
    /** Flips point to one corresponding to (x, -y) in Affine coordinates. */
    negate() {
      return new Point(this.X, Fp.neg(this.Y), this.Z);
    }
    // Renes-Costello-Batina exception-free doubling formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 3
    // Cost: 8M + 3S + 3*a + 2*b3 + 15add.
    double() {
      const { X: X1, Y: Y1, Z: Z1 } = this;
      let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;
      let t0 = Fp.mul(X1, X1);
      let t1 = Fp.mul(Y1, Y1);
      let t2 = Fp.mul(Z1, Z1);
      let t3 = Fp.mul(X1, Y1);
      t3 = Fp.add(t3, t3);
      Z3 = Fp.mul(X1, Z1);
      Z3 = Fp.add(Z3, Z3);
      X3 = mulA(Z3);
      Y3 = Fp.mul(b3, t2);
      Y3 = Fp.add(X3, Y3);
      X3 = Fp.sub(t1, Y3);
      Y3 = Fp.add(t1, Y3);
      Y3 = Fp.mul(X3, Y3);
      X3 = Fp.mul(t3, X3);
      Z3 = Fp.mul(b3, Z3);
      t2 = mulA(t2);
      t3 = Fp.sub(t0, t2);
      t3 = mulA(t3);
      t3 = Fp.add(t3, Z3);
      Z3 = Fp.add(t0, t0);
      t0 = Fp.add(Z3, t0);
      t0 = Fp.add(t0, t2);
      t0 = Fp.mul(t0, t3);
      Y3 = Fp.add(Y3, t0);
      t2 = Fp.mul(Y1, Z1);
      t2 = Fp.add(t2, t2);
      t0 = Fp.mul(t2, t3);
      X3 = Fp.sub(X3, t0);
      Z3 = Fp.mul(t2, t1);
      Z3 = Fp.add(Z3, Z3);
      Z3 = Fp.add(Z3, Z3);
      return new Point(X3, Y3, Z3);
    }
    // Renes-Costello-Batina exception-free addition formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 1
    // Cost: 12M + 0S + 3*a + 3*b3 + 23add.
    add(other) {
      aprjpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;
      let t0 = Fp.mul(X1, X2);
      let t1 = Fp.mul(Y1, Y2);
      let t2 = Fp.mul(Z1, Z2);
      let t3 = Fp.add(X1, Y1);
      let t4 = Fp.add(X2, Y2);
      t3 = Fp.mul(t3, t4);
      t4 = Fp.add(t0, t1);
      t3 = Fp.sub(t3, t4);
      t4 = Fp.add(X1, Z1);
      let t5 = Fp.add(X2, Z2);
      t4 = Fp.mul(t4, t5);
      t5 = Fp.add(t0, t2);
      t4 = Fp.sub(t4, t5);
      t5 = Fp.add(Y1, Z1);
      X3 = Fp.add(Y2, Z2);
      t5 = Fp.mul(t5, X3);
      X3 = Fp.add(t1, t2);
      t5 = Fp.sub(t5, X3);
      Z3 = mulA(t4);
      X3 = Fp.mul(b3, t2);
      Z3 = Fp.add(X3, Z3);
      X3 = Fp.sub(t1, Z3);
      Z3 = Fp.add(t1, Z3);
      Y3 = Fp.mul(X3, Z3);
      t1 = Fp.add(t0, t0);
      t1 = Fp.add(t1, t0);
      t2 = mulA(t2);
      t4 = Fp.mul(b3, t4);
      t1 = Fp.add(t1, t2);
      t2 = Fp.sub(t0, t2);
      t2 = mulA(t2);
      t4 = Fp.add(t4, t2);
      t0 = Fp.mul(t1, t4);
      Y3 = Fp.add(Y3, t0);
      t0 = Fp.mul(t5, t4);
      X3 = Fp.mul(t3, X3);
      X3 = Fp.sub(X3, t0);
      t0 = Fp.mul(t3, t1);
      Z3 = Fp.mul(t5, Z3);
      Z3 = Fp.add(Z3, t0);
      return new Point(X3, Y3, Z3);
    }
    subtract(other) {
      aprjpoint(other);
      return this.add(other.negate());
    }
    is0() {
      return this.equals(Point.ZERO);
    }
    /**
     * Constant time multiplication.
     * Uses precomputed tables (signed fixed-window wNAF) when available.
     * Uses scalar blinding and avoids endomorphism splitting in the secret-scalar path.
     * @param scalar - by which the point would be multiplied
     * @returns New point
     */
    multiply(scalar) {
      if (!Fn.isValidNot0(scalar))
        throw new RangeError("invalid scalar: out of range");
      const { p, f } = wnaf.mulSecret(this, scalar, cofactor, normalize);
      return normalize([p, f])[0];
    }
    /**
     * Non-constant-time multiplication. Uses width-4 wNAF with GLV endomorphism splitting
     * when available (two half-width scalars sharing one halved doubling chain).
     * It's faster, but should only be used when you don't care about
     * an exposed secret key e.g. sig verification, which works over *public* keys.
     */
    multiplyUnsafe(scalar) {
      const p = this;
      const sc = scalar;
      if (!Fn.isValid(sc))
        throw new RangeError("invalid scalar: out of range");
      if (sc === _0n5 || p.is0())
        return Point.ZERO;
      if (sc === _1n4)
        return p;
      if (wnaf.hasWindowSize(this))
        return wnaf.mulUnsafe(p, sc, normalize);
      const points = [];
      const scalars = [];
      pushWnafPair(points, scalars, p, sc);
      return mulAddUnsafe(Point, points, scalars);
    }
    /**
     * Non-constant-time double-scalar multiplication `a⋅this + b⋅other` (Strauss–Shamir).
     * Both walks share one doubling chain via {@link mulAddUnsafe}, and GLV endomorphism
     * (when available) halves the chain again by splitting each scalar into two half-width
     * parts. Used by ECDSA verification and public-key recovery for `R = u1⋅G + u2⋅P`.
     * Only for public scalars.
     */
    mulAddUnsafe(a, other, b) {
      aprjpoint(other);
      const points = [];
      const scalars = [];
      pushWnafPair(points, scalars, this, a);
      pushWnafPair(points, scalars, other, b);
      return mulAddUnsafe(Point, points, scalars);
    }
    /**
     * Converts Projective point to affine (x, y) coordinates.
     * (X, Y, Z) ∋ (x=X/Z, y=Y/Z).
     * @param invertedZ - Z^-1 (inverted zero) - optional, precomputation is useful for invertBatch
     */
    toAffine(invertedZ) {
      const p = this;
      let iz = invertedZ;
      if (iz != null && !Fp.isValid(iz))
        throw new RangeError('"invertedZ" expected valid field element');
      const { X, Y, Z } = p;
      if (Fp.eql(Z, Fp.ONE))
        return { x: X, y: Y };
      const is0 = p.is0();
      if (iz == null)
        iz = is0 ? Fp.ONE : Fp.inv(Z);
      const x = Fp.mul(X, iz);
      const y = Fp.mul(Y, iz);
      const zz = Fp.mul(Z, iz);
      if (is0)
        return { x: Fp.ZERO, y: Fp.ZERO };
      if (!Fp.eql(zz, Fp.ONE))
        throw new Error("invZ was invalid");
      return { x, y };
    }
    /**
     * Checks whether Point is free of torsion elements (is in prime subgroup).
     * Always torsion-free for cofactor=1 curves.
     */
    isTorsionFree() {
      if (cofactor === _1n4)
        return true;
      if (isTorsionFree)
        return isTorsionFree(Point, this);
      return wnaf.mulUnsafe(this, CURVE_ORDER).is0();
    }
    clearCofactor() {
      if (cofactor === _1n4)
        return this;
      if (clearCofactor)
        return clearCofactor(Point, this);
      return this.multiplyUnsafe(cofactor);
    }
    isSmallOrder() {
      if (cofactor === _1n4)
        return this.is0();
      return this.clearCofactor().is0();
    }
    toBytes(isCompressed = true) {
      abool(isCompressed, "isCompressed");
      this.assertValidity();
      return encodePoint(Point, this, isCompressed);
    }
    toHex(isCompressed = true) {
      return bytesToHex2(this.toBytes(isCompressed));
    }
    toString() {
      return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
    }
  }
  const normalize = (points) => normalizeZ(Point, points);
  const wnaf = new ScalarMultiplier(Point, randomBytes32);
  if (wnaf.bits >= 6)
    Point.BASE.precompute(6);
  Object.freeze(Point.prototype);
  Object.freeze(Point);
  return Point;
}
function pprefix(hasEvenY) {
  return Uint8Array.of(hasEvenY ? 2 : 3);
}
function getWLengths(Fp, Fn) {
  return {
    secretKey: Fn.BYTES,
    publicKey: 1 + Fp.BYTES,
    publicKeyUncompressed: 1 + 2 * Fp.BYTES,
    publicKeyHasPrefix: true,
    // Raw compact `(r || s)` signature width; DER and recovered signatures use
    // different lengths outside this helper.
    signature: 2 * Fn.BYTES
  };
}
function ecdh(Point, ecdhOpts = {}) {
  validatePointCons(Point);
  const { Fn } = Point;
  const randomBytes_ = ecdhOpts.randomBytes === void 0 ? randomBytes2 : ecdhOpts.randomBytes;
  const lengths = Object.assign(getWLengths(Point.Fp, Fn), {
    seed: Math.max(getMinHashLength(Fn.ORDER), 16)
  });
  function isValidSecretKey(secretKey) {
    try {
      const num = Fn.fromBytes(secretKey);
      return Fn.isValidNot0(num);
    } catch (error) {
      return false;
    }
  }
  function isValidPublicKey(publicKey, isCompressed) {
    const { publicKey: comp, publicKeyUncompressed } = lengths;
    try {
      const l = publicKey.length;
      if (isCompressed === true && l !== comp)
        return false;
      if (isCompressed === false && l !== publicKeyUncompressed)
        return false;
      return !Point.fromBytes(publicKey).is0();
    } catch (error) {
      return false;
    }
  }
  function randomSecretKey(seed) {
    seed = seed === void 0 ? randomBytes_(lengths.seed) : seed;
    return mapHashToField(abytes2(seed, lengths.seed, "seed"), Fn.ORDER);
  }
  function getPublicKey(secretKey, isCompressed = true) {
    return Point.BASE.multiply(Fn.fromBytes(secretKey)).toBytes(isCompressed);
  }
  function isProbPub(item) {
    const { secretKey, publicKey, publicKeyUncompressed } = lengths;
    const allowedLengths = Fn._lengths;
    if (!isBytes2(item))
      return void 0;
    const l = abytes2(item, void 0, "key").length;
    const isPub = l === publicKey || l === publicKeyUncompressed;
    const isSec = l === secretKey || !!allowedLengths?.includes(l);
    if (isPub && isSec)
      return void 0;
    return isPub;
  }
  function getSharedSecret(secretKeyA, publicKeyB, isCompressed = true) {
    if (isProbPub(secretKeyA) === true)
      throw new Error("first arg must be private key");
    if (isProbPub(publicKeyB) === false)
      throw new Error("second arg must be public key");
    const s = Fn.fromBytes(secretKeyA);
    const b = Point.fromBytes(publicKeyB);
    if (b.is0())
      throw new Error("invalid public key: point at infinity");
    return b.multiply(s).toBytes(isCompressed);
  }
  const utils = {
    isValidSecretKey,
    isValidPublicKey,
    randomSecretKey
  };
  const keygen = createKeygen(randomSecretKey, getPublicKey);
  Object.freeze(utils);
  Object.freeze(lengths);
  return Object.freeze({ getPublicKey, getSharedSecret, keygen, Point, utils, lengths });
}
function ecdsa(Point, hash, ecdsaOpts = {}) {
  validatePointCons(Point);
  const hash_ = hash;
  ahash(hash_);
  validateObject(ecdsaOpts, {}, {
    hmac: "function",
    lowS: "boolean",
    randomBytes: "function",
    bits2int: "function",
    bits2int_modN: "function"
  });
  const opts = Object.assign({}, ecdsaOpts);
  const randomBytes32 = opts.randomBytes === void 0 ? randomBytes2 : opts.randomBytes;
  const hmac2 = opts.hmac === void 0 ? (key, msg) => hmac(hash_, key, msg) : opts.hmac;
  const { Fp, Fn } = Point;
  const { ORDER: CURVE_ORDER, BITS: fnBits } = Fn;
  const blindLength = getMinHashLength(CURVE_ORDER);
  const csprng = probeRandomBytes(randomBytes32, blindLength);
  const { keygen, getPublicKey, getSharedSecret, utils, lengths } = ecdh(Point, opts);
  const defaultSigOpts = {
    prehash: true,
    lowS: typeof opts.lowS === "boolean" ? opts.lowS : true,
    format: "compact",
    extraEntropy: false
  };
  const hasLargeRecoveryLifts = CURVE_ORDER * _2n2 + _1n4 < Fp.ORDER;
  function isBiggerThanHalfOrder(number) {
    const HALF = CURVE_ORDER >> _1n4;
    return number > HALF;
  }
  function validateRS(title, num) {
    if (!Fn.isValidNot0(num))
      throw new Error(`invalid signature ${title}: out of range 1..Point.Fn.ORDER`);
    return num;
  }
  function assertFieldSignIsSupported() {
    if (!Fp.isOdd)
      throw new Error("Field doesn't support isOdd");
  }
  function getRecoveryBit(x, y, r) {
    assertFieldSignIsSupported();
    return (x === r ? 0 : 2) | Number(Fp.isOdd(y));
  }
  function assertRecoverableCurve() {
    if (hasLargeRecoveryLifts)
      throw new Error('"recovered" sig type is not supported for cofactor >2 curves');
  }
  function validateSigLength(bytes2, format) {
    validateSigFormat(format);
    const size = lengths.signature;
    const sizer = format === "compact" ? size : format === "recovered" ? size + 1 : void 0;
    return abytes2(bytes2, sizer);
  }
  class Signature {
    r;
    s;
    recovery;
    constructor(r, s, recovery) {
      this.r = validateRS("r", r);
      this.s = validateRS("s", s);
      if (recovery != null) {
        assertRecoverableCurve();
        if (![0, 1, 2, 3].includes(recovery))
          throw new Error("invalid recovery id");
        this.recovery = recovery;
      }
      Object.freeze(this);
    }
    static fromBytes(bytes2, format = defaultSigOpts.format) {
      validateSigLength(bytes2, format);
      let recid;
      if (format === "der") {
        if (bytes2.length > 2 * Fn.BYTES + 16)
          throw new DER.Err("invalid signature: DER signature too long");
        const { r: r2, s: s2 } = DER.toSig(abytes2(bytes2), Fn.BYTES + 1);
        return new Signature(r2, s2);
      }
      if (format === "recovered") {
        recid = bytes2[0];
        format = "compact";
        bytes2 = bytes2.subarray(1);
      }
      const L = lengths.signature / 2;
      const r = bytes2.subarray(0, L);
      const s = bytes2.subarray(L, L * 2);
      return new Signature(Fn.fromBytes(r), Fn.fromBytes(s), recid);
    }
    static fromHex(hex2, format) {
      return this.fromBytes(hexToBytes2(hex2), format);
    }
    assertRecovery() {
      const { recovery } = this;
      if (recovery == null)
        throw new Error("invalid recovery id: must be present");
      return recovery;
    }
    addRecoveryBit(recovery) {
      return new Signature(this.r, this.s, recovery);
    }
    // Unlike the top-level helper below, this method expects a digest that has
    // already been hashed to the curve's message representative.
    recoverPublicKey(messageHash) {
      const { r, s } = this;
      const recovery = this.assertRecovery();
      const radj = recovery === 2 || recovery === 3 ? r + CURVE_ORDER : r;
      if (!Fp.isValid(radj))
        throw new Error("invalid recovery id: sig.r+curve.n != R.x");
      const x = Fp.toBytes(radj);
      const R = Point.fromBytes(concatBytes2(pprefix((recovery & 1) === 0), x));
      const ir = Fn.inv(radj);
      const h = bits2int_modN(abytes2(messageHash, void 0, "msgHash"));
      const u1 = Fn.create(-h * ir);
      const u2 = Fn.create(s * ir);
      const Q = Point.BASE.mulAddUnsafe(u1, R, u2);
      if (Q.is0())
        throw new Error("invalid recovery: point at infinify");
      Q.assertValidity();
      return Q;
    }
    // Signatures should be low-s, to prevent malleability.
    hasHighS() {
      return isBiggerThanHalfOrder(this.s);
    }
    toBytes(format = defaultSigOpts.format) {
      validateSigFormat(format);
      if (format === "der")
        return hexToBytes2(DER.hexFromSig(this));
      const { r, s } = this;
      const rb = Fn.toBytes(r);
      const sb = Fn.toBytes(s);
      if (format === "recovered") {
        assertRecoverableCurve();
        return concatBytes2(Uint8Array.of(this.assertRecovery()), rb, sb);
      }
      return concatBytes2(rb, sb);
    }
    toHex(format) {
      return bytesToHex2(this.toBytes(format));
    }
  }
  Object.freeze(Signature.prototype);
  Object.freeze(Signature);
  const bits2int = opts.bits2int === void 0 ? function bits2int_def(bytes2) {
    if (bytes2.length > 8192)
      throw new Error("input is too large");
    const num = bytesToNumberBE(bytes2);
    const delta = bytes2.length * 8 - fnBits;
    return delta > 0 ? num >> BigInt(delta) : num;
  } : opts.bits2int;
  const bits2int_modN = opts.bits2int_modN === void 0 ? function bits2int_modN_def(bytes2) {
    return Fn.create(bits2int(bytes2));
  } : opts.bits2int_modN;
  const ORDER_MASK = bitMask(fnBits);
  function int2octets(num) {
    aInRange("num < 2^" + fnBits, num, _0n5, ORDER_MASK);
    return Fn.toBytes(num);
  }
  function validateMsgAndHash(message, prehash) {
    abytes2(message, void 0, "message");
    return prehash ? abytes2(hash_(message), void 0, "prehashed message") : message;
  }
  function prepSig(message, secretKey, opts2) {
    const { lowS, prehash, extraEntropy } = validateSigOpts(opts2, defaultSigOpts);
    message = validateMsgAndHash(message, prehash);
    const h1int = bits2int_modN(message);
    const d = Fn.fromBytes(secretKey);
    if (!Fn.isValidNot0(d))
      throw new Error("invalid private key");
    const seedArgs = [int2octets(d), int2octets(h1int)];
    if (extraEntropy != null && extraEntropy !== false) {
      const e = extraEntropy === true ? randomBytes32(lengths.secretKey) : extraEntropy;
      seedArgs.push(abytes2(e, void 0, "extraEntropy"));
    }
    const seed = concatBytes2(...seedArgs);
    const m = h1int;
    function k2sig(kBytes) {
      const k = bits2int(kBytes);
      if (!Fn.isValidNot0(k))
        return;
      const q = Point.BASE.multiply(k).toAffine();
      const r = Fn.create(q.x);
      if (r === _0n5)
        return;
      let s;
      if (csprng !== void 0) {
        const b = bytesToNumberBE(mapHashToField(csprng(blindLength), CURVE_ORDER));
        const ibk = Fn.inv(Fn.mul(b, k));
        const bm = Fn.mul(b, m);
        const bd = Fn.mul(b, d);
        s = Fn.create(ibk * Fn.create(bm + bd * r));
      } else {
        const ik = invertCt(k, CURVE_ORDER);
        s = Fn.create(ik * Fn.create(m + r * d));
      }
      if (s === _0n5)
        return;
      let recovery = getRecoveryBit(q.x, q.y, r);
      let normS = s;
      if (lowS && isBiggerThanHalfOrder(s)) {
        normS = Fn.neg(s);
        recovery ^= 1;
      }
      return new Signature(r, normS, hasLargeRecoveryLifts ? void 0 : recovery);
    }
    return { seed, k2sig };
  }
  function sign(message, secretKey, opts2 = {}) {
    const { seed, k2sig } = prepSig(message, secretKey, opts2);
    const drbg = createHmacDrbg(hash_.outputLen, Fn.BYTES, hmac2);
    const sig = drbg(seed, k2sig);
    return sig.toBytes(opts2.format);
  }
  function verify(signature, message, publicKey, opts2 = {}) {
    const { lowS, prehash, format } = validateSigOpts(opts2, defaultSigOpts);
    publicKey = abytes2(publicKey, void 0, "publicKey");
    message = validateMsgAndHash(message, prehash);
    if (!isBytes2(signature)) {
      const end = signature instanceof Signature ? ", use sig.toBytes()" : "";
      throw new Error("verify expects Uint8Array signature" + end);
    }
    validateSigLength(signature, format);
    try {
      const sig = Signature.fromBytes(signature, format);
      const P = Point.fromBytes(publicKey);
      if (P.is0())
        return false;
      if (lowS && sig.hasHighS())
        return false;
      const { r, s } = sig;
      const h = bits2int_modN(message);
      const is = Fn.inv(s);
      const u1 = Fn.create(h * is);
      const u2 = Fn.create(r * is);
      const R = Point.BASE.mulAddUnsafe(u1, P, u2);
      if (R.is0())
        return false;
      const q = R.toAffine();
      const v = Fn.create(q.x);
      if (v !== r)
        return false;
      if (format === "recovered" && sig.recovery !== getRecoveryBit(q.x, q.y, r))
        return false;
      return true;
    } catch (e) {
      return false;
    }
  }
  function recoverPublicKey(signature, message, opts2 = {}) {
    const { prehash } = validateSigOpts(opts2, defaultSigOpts);
    message = validateMsgAndHash(message, prehash);
    return Signature.fromBytes(signature, "recovered").recoverPublicKey(message).toBytes();
  }
  return Object.freeze({
    keygen,
    getPublicKey,
    getSharedSecret,
    utils,
    lengths,
    Point,
    sign,
    verify,
    recoverPublicKey,
    Signature,
    hash: hash_
  });
}
var p256_CURVE = /* @__PURE__ */ (() => ({
  p: BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff"),
  n: BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"),
  h: BigInt(1),
  a: BigInt("0xffffffff00000001000000000000000000000000fffffffffffffffffffffffc"),
  b: BigInt("0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b"),
  Gx: BigInt("0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"),
  Gy: BigInt("0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5")
}))();
var p256_Point = /* @__PURE__ */ weierstrass(p256_CURVE);
var p256 = /* @__PURE__ */ ecdsa(p256_Point, sha256);

// src/core/perm/verify.ts
var curve = p256;
var sha2562 = sha256;
var P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
var SPKI_PREFIX = Uint8Array.from([
  48,
  89,
  48,
  19,
  6,
  7,
  42,
  134,
  72,
  206,
  61,
  2,
  1,
  6,
  8,
  42,
  134,
  72,
  206,
  61,
  3,
  1,
  7,
  3,
  66,
  0
]);
var SPKI_LEN = 91;
var TS_SKEW_SEC = 30;
var REJECT_WIRE = {
  malformed: "malformed",
  nonce: "nonce",
  tool_use_id: "tool_use_id",
  ph: "ph",
  replay: "replay",
  kid: "kid",
  sig: "sig",
  "expired-ts": "expired",
  "expired-now": "expired",
  forbidden: "forbidden"
};
function reject(cause) {
  return { ok: false, cause, reject: REJECT_WIRE[cause] };
}
function eq(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
function bigOf(b) {
  let x = 0n;
  for (const v of b) x = x << 8n | BigInt(v);
  return x;
}
function kidOf(spki) {
  return sha2562(spki).slice(0, 8);
}
function spkiPoint(spki) {
  if (spki.length !== SPKI_LEN) throw new Error(`SPKI de ${spki.length} bytes (se esperaban ${SPKI_LEN})`);
  if (!eq(spki.subarray(0, SPKI_PREFIX.length), SPKI_PREFIX)) throw new Error("SPKI que no es P-256 sin comprimir");
  const point = spki.slice(SPKI_PREFIX.length);
  if (point[0] !== 4) throw new Error("punto comprimido o inv\xE1lido");
  let p;
  try {
    p = curve.Point.fromBytes(point);
  } catch (err) {
    throw new Error(`el punto no est\xE1 en P-256 (${String(err)})`);
  }
  if (p.is0()) throw new Error("punto en el infinito");
  return point;
}
function verifySignature(spki, msg, sig) {
  try {
    if (sig.length !== 64) return false;
    const r = bigOf(sig.subarray(0, 32));
    const s = bigOf(sig.subarray(32));
    if (r === 0n || s === 0n || r >= P256_N || s >= P256_N) return false;
    return curve.verify(sig, msg, spkiPoint(spki), { lowS: false, prehash: true, format: "compact" }) === true;
  } catch {
    return false;
  }
}
function permHash(p) {
  return sha2562(encode(permHashInputToCbor({ instanceId: p.instanceId, nonce: p.nonce, toolUseId: p.toolUseId, tool: p.tool, sum: p.sum, wok: p.wok, exp: p.exp })));
}
function signingInput(nonce, toolUseId2, decision, ts, ph) {
  return encode(signingInputToCbor({ nonce, toolUseId: toolUseId2, decision, ts, ph }));
}
function verifyDecision(pending, decBytes, pairedKeys, now) {
  let frame;
  try {
    frame = decodeFrame(decBytes);
  } catch {
    return reject("malformed");
  }
  if (frame.type !== "dec") return reject("malformed");
  if (!eq(frame.nonce, pending.nonce)) return reject("nonce");
  if (pending.resolved === true) return reject("replay");
  if (frame.toolUseId !== pending.toolUseId) return reject("tool_use_id");
  let ph;
  try {
    ph = permHash(pending);
  } catch {
    return reject("ph");
  }
  if (!eq(frame.ph, ph)) return reject("ph");
  const key = pairedKeys.find((k) => eq(k.kid, frame.kid) && eq(kidOf(k.spki), frame.kid));
  if (key === void 0) return reject("kid");
  const msg = signingInput(frame.nonce, pending.toolUseId, frame.decision, frame.ts, ph);
  if (!verifySignature(key.spki, msg, frame.sig)) return reject("sig");
  if (frame.ts > pending.exp + TS_SKEW_SEC) return reject("expired-ts");
  if (!(now <= pending.exp)) return reject("expired-now");
  if (frame.decision === "allow" && !pending.wok) return reject("forbidden");
  return { ok: true, decision: frame.decision, ts: frame.ts, kid: frame.kid };
}

// src/core/perm/hold.ts
var REJECT_REASONS = ["sig", "nonce", "expired", "replay", "forbidden", "kid", "malformed", "tool_use_id", "ph"];
var RESOLVED_RETRY_AFTER_EXP_MS = 6e3;
var RESOLVED_RETRY_MAX_DELAY_MS = 8e3;
var TEST_KIDS = ["058f0152861814b2", "c5ce142e84259e6f"];
function kidHex(kid) {
  return Array.from(kid, (b) => b.toString(16).padStart(2, "0")).join("");
}
function isTestKey(kid) {
  return TEST_KIDS.includes(kidHex(kid));
}
function dropTestKeys(keys) {
  const kept = keys.filter((k) => !isTestKey(k.kid));
  return { keys: kept, dropped: keys.length - kept.length };
}
function k1Verifier(keys) {
  return (p, bytes2, nowMs) => {
    const paired = typeof keys === "function" ? keys() : keys;
    const pending = { nonce: p.nonce, toolUseId: p.toolUseId, exp: p.exp, wok: p.wok, instanceId: p.instanceId, tool: p.tool, sum: p.sum, resolved: false };
    const r = verifyDecision(pending, bytes2, paired, nowMs / 1e3);
    return r.ok ? { ok: true } : { ok: false, reason: r.reject };
  };
}
function parseWatchKeys(raw) {
  const text = (raw ?? "").trim();
  if (text === "") return { ok: true, keys: [] };
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    return { ok: false, error: "debe ser un array JSON de SPKI en base64url" };
  }
  if (!Array.isArray(list)) return { ok: false, error: "debe ser un array JSON de SPKI en base64url" };
  const keys = [];
  for (const item of list) {
    if (typeof item !== "string") return { ok: false, error: "cada llave debe ser un string base64url" };
    try {
      const spki = b64uDecode(item);
      spkiPoint(spki);
      const kid = kidOf(spki);
      if (isTestKey(kid)) return { ok: false, error: `llave de prueba ${kidHex(kid)} (su clave privada es p\xFAblica): no se acepta` };
      keys.push({ kid, spki });
    } catch (err) {
      return { ok: false, error: `llave inv\xE1lida (${String(err)})` };
    }
  }
  return { ok: true, keys };
}
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function b64uEncode(bytes2) {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes2.length; i += 3) {
    const n = bytes2[i] << 16 | bytes2[i + 1] << 8 | bytes2[i + 2];
    out += B64[n >> 18 & 63] + B64[n >> 12 & 63] + B64[n >> 6 & 63] + B64[n & 63];
  }
  const rest = bytes2.length - i;
  if (rest === 1) {
    const n = bytes2[i] << 16;
    out += B64[n >> 18 & 63] + B64[n >> 12 & 63];
  } else if (rest === 2) {
    const n = bytes2[i] << 16 | bytes2[i + 1] << 8;
    out += B64[n >> 18 & 63] + B64[n >> 12 & 63] + B64[n >> 6 & 63];
  }
  return out;
}
function b64uDecode(s) {
  if (s.length % 4 === 1) throw new Error("base64url: longitud inv\xE1lida");
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error("base64url: car\xE1cter inv\xE1lido");
    acc = acc << 6 | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push(acc >> bits & 255);
    }
  }
  return Uint8Array.from(out);
}
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function asRejectReason(reason) {
  return REJECT_REASONS.includes(reason) ? reason : void 0;
}
function newActive() {
  let resolve;
  const done = new Promise((r) => resolve = r);
  const a = {
    settled: void 0,
    done,
    wakers: /* @__PURE__ */ new Set(),
    settle(o) {
      if (a.settled !== void 0) return false;
      a.settled = o;
      resolve(o);
      for (const w of [...a.wakers]) w();
      a.wakers.clear();
      return true;
    }
  };
  return a;
}
var TOOL_USE_ID_MAX = 64;
var PermHolder = class {
  constructor(deps) {
    this.deps = deps;
    this.pollWaitMs = deps.pollWaitMs ?? 2e3;
    this.retryMs = deps.retryMs ?? 500;
    this.resolvedTimeoutMs = deps.resolvedTimeoutMs ?? 3e3;
    this.pendingTimeoutMs = deps.pendingTimeoutMs ?? 5e3;
  }
  deps;
  active = /* @__PURE__ */ new Map();
  pollWaitMs;
  retryMs;
  resolvedTimeoutMs;
  pendingTimeoutMs;
  /** Últimas resoluciones (para /orbit y los tests). */
  reports = [];
  /** Número de permisos retenidos ahora mismo. */
  pendingCount() {
    return this.active.size;
  }
  /**
   * El terminal respondió para `toolUseId` (U1). Devuelve true si esta llamada ganó la carrera.
   * `decision` es la del terminal si se conoce; si no, "none".
   */
  terminal(toolUseId2, decision = "none") {
    const a = this.active.get(toolUseId2);
    return a === void 0 ? false : a.settle({ by: "terminal", decision });
  }
  /**
   * §6.1 a partir del veredicto ya calculado (`v = await next(e)`). Nunca lanza y nunca devuelve algo
   * más permisivo que `v` salvo un `allow` del reloj verificado.
   */
  async hold(e, v, ctx) {
    if (v === null || typeof v !== "object" || v.decision !== "ask") return v;
    try {
      return await this.holdAsk(e, v, ctx);
    } catch (err) {
      this.log(`retenci\xF3n fall\xF3, se devuelve el veredicto original (${String(err)})`, ctx.io);
      return v;
    }
  }
  log(message, io = this.deps.io) {
    try {
      io.log(`orbit perm: ${message}`);
    } catch {
    }
  }
  async holdAsk(e, v, ctx) {
    if (!this.deps.perm.enabled) return v;
    const toolUseId2 = typeof e.tool_use_id === "string" ? e.tool_use_id : "";
    if (toolUseId2 === "" || Array.from(toolUseId2).length > TOOL_USE_ID_MAX) return v;
    const tool = typeof e.tool === "string" ? e.tool : "";
    if (tool === "" || ctx.sessionId === "") return v;
    if (ctx.signal?.aborted === true) return v;
    if (this.active.has(toolUseId2)) return v;
    const a = newActive();
    this.active.set(toolUseId2, a);
    try {
      return await this.race(a, e, v, ctx, ctx.io ?? this.deps.io, toolUseId2, tool);
    } finally {
      if (a.settled === void 0) a.settle({ by: "error", decision: "none" });
      if (this.active.get(toolUseId2) === a) this.active.delete(toolUseId2);
    }
  }
  async race(a, e, v, ctx, io, toolUseId2, tool) {
    const { config, perm } = this.deps;
    const nonce = await io.random(16);
    if (!(nonce instanceof Uint8Array) || nonce.length !== 16) throw new Error("nonce: el CSPRNG no devolvi\xF3 16 bytes");
    const start = await io.now();
    const deadline = start + (ctx.holdMs ?? perm.holdMs);
    const summary = summarizeExact(effectiveCtx(config), tool, e.input);
    const pending = {
      instanceId: config.instanceId,
      nonce,
      nonceB64: b64uEncode(nonce),
      toolUseId: toolUseId2,
      exp: Math.floor(deadline / 1e3),
      wok: summary.exact && watchOk(tool, e.input, perm.forbidden),
      tool: toolLabel(tool),
      sum: summary.sum,
      sessionId: ctx.sessionId
    };
    if (typeof e.agentId === "string" && e.agentId !== "") pending.agentId = e.agentId;
    const body = {
      orbit: ORBIT_VERSION,
      instance_id: config.instanceId,
      session_id: pending.sessionId,
      tool_use_id: toolUseId2,
      nonce: pending.nonceB64,
      exp: pending.exp,
      tool: pending.tool,
      sum: pending.sum,
      wok: pending.wok
    };
    if (pending.agentId !== void 0) body.agent_id = pending.agentId;
    const request = io.fetch(`${config.url}/v0/perm/pending`, { method: "POST", headers: this.headers(true), body: JSON.stringify(body) }).catch((err) => {
      this.log(`POST /v0/perm/pending fall\xF3 (${String(err)})`, io);
      return void 0;
    });
    const gave = await this.capPending(io, request, ctx.signal);
    if (gave !== void 0) {
      this.log(`POST /v0/perm/pending sin respuesta (${gave}): se devuelve el veredicto original`, io);
      void request.then((late) => {
        if (late?.ok !== true) return;
        const orphan = { tool_use_id: toolUseId2, nonce: pending.nonceB64, by: gave === "abort" ? "abort" : "timeout", decision: "none" };
        void this.postResolved(io, orphan, pending.exp * 1e3 + RESOLVED_RETRY_AFTER_EXP_MS);
      });
      return v;
    }
    const posted = await request;
    if (posted === void 0 || !posted.ok) {
      if (posted !== void 0) this.log(`POST /v0/perm/pending respondi\xF3 ${posted.status}`, io);
      return v;
    }
    const remaining = Math.max(0, deadline - await io.now());
    const timer = io.after(remaining, () => a.settle({ by: "timeout", decision: "none" }));
    const signal = ctx.signal;
    const onAbort = () => {
      a.settle({ by: "abort", decision: "none" });
    };
    let listening = false;
    if (signal !== void 0 && typeof signal.addEventListener === "function") {
      try {
        signal.addEventListener("abort", onAbort);
        listening = true;
      } catch {
        listening = false;
      }
    }
    if (signal?.aborted === true) onAbort();
    const state = { reject: void 0, rejected: 0 };
    const loop = this.pollLoop(a, io, pending, deadline, signal, state).catch((err) => {
      this.log(`bucle de long-poll fall\xF3 (${String(err)})`, io);
      a.settle({ by: "error", decision: "none" });
    });
    const outcome = await a.done;
    timer.cancel();
    if (listening) {
      try {
        signal?.removeEventListener?.("abort", onAbort);
      } catch {
      }
    }
    void loop;
    this.active.delete(toolUseId2);
    const resolved = {
      tool_use_id: toolUseId2,
      nonce: pending.nonceB64,
      by: outcome.by,
      decision: outcome.decision
    };
    if (state.reject !== void 0) resolved.reject = state.reject;
    await this.postResolved(io, resolved, pending.exp * 1e3 + RESOLVED_RETRY_AFTER_EXP_MS);
    const report = { toolUseId: toolUseId2, outcome, rejected: state.rejected };
    if (state.reject !== void 0) report.reject = state.reject;
    this.reports.push(report);
    if (this.reports.length > 20) this.reports.shift();
    if (outcome.by === "watch" && outcome.decision === "allow") return { decision: "allow", reason: "aprobado desde el reloj (Orbit)" };
    if (outcome.by === "watch" && outcome.decision === "deny") return { decision: "deny", reason: "denegado desde el reloj (Orbit)" };
    return v;
  }
  headers(json) {
    const h = { authorization: `Bearer ${this.deps.config.token}` };
    if (json) h["content-type"] = "application/json";
    return h;
  }
  /**
   * Espera la respuesta de POST /v0/perm/pending como mucho `pendingTimeoutMs` y hasta un abort.
   * Devuelve undefined si respondió (bien o mal) a tiempo, o el motivo por el que se dejó de esperar.
   */
  capPending(io, request, signal) {
    if (signal?.aborted === true) return Promise.resolve("abort");
    return new Promise((resolve) => {
      let done = false;
      let listening = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        timer.cancel();
        if (listening) {
          try {
            signal?.removeEventListener?.("abort", onAbort);
          } catch {
          }
        }
        resolve(r);
      };
      const onAbort = () => finish("abort");
      const timer = io.after(this.pendingTimeoutMs, () => finish("timeout"));
      if (signal !== void 0 && typeof signal.addEventListener === "function") {
        try {
          signal.addEventListener("abort", onAbort);
          listening = true;
        } catch {
          listening = false;
        }
      }
      void request.then(() => finish(void 0));
    });
  }
  /**
   * POST /v0/perm/resolved. Espera como mucho `resolvedTimeoutMs` (no retrasa la respuesta al motor);
   * si falla por red, 429 o 5xx, se reintenta en segundo plano con espera creciente hasta `untilMs`.
   * Un 4xx (p. ej. 404: el servidor ya lo olvidó) es definitivo.
   */
  async postResolved(io, body, untilMs) {
    let timer;
    const cap = new Promise((r) => {
      timer = io.after(this.resolvedTimeoutMs, r);
    });
    const post = this.sendResolved(io, body).then((done) => {
      if (!done) this.retryResolved(io, body, untilMs, 0);
    });
    await Promise.race([post, cap]);
    timer?.cancel();
  }
  /** Un intento. true = terminado (aceptado o rechazo definitivo); false = hay que reintentar. */
  sendResolved(io, body) {
    const { config } = this.deps;
    return io.fetch(`${config.url}/v0/perm/resolved`, { method: "POST", headers: this.headers(true), body: JSON.stringify(body) }).then(
      (r) => {
        if (r.ok) return true;
        this.log(`POST /v0/perm/resolved respondi\xF3 ${r.status}`, io);
        return !(r.status === 429 || r.status >= 500);
      },
      (err) => {
        this.log(`POST /v0/perm/resolved fall\xF3 (${String(err)})`, io);
        return false;
      }
    );
  }
  retryResolved(io, body, untilMs, attempt) {
    const delay = Math.min(RESOLVED_RETRY_MAX_DELAY_MS, 1e3 * 2 ** attempt);
    void Promise.resolve().then(() => io.now()).then((now) => {
      if (now + delay > untilMs) {
        this.log(`POST /v0/perm/resolved sin entregar para ${String(body.tool_use_id)}: el servidor lo cerrar\xE1 por timeout`, io);
        return;
      }
      io.after(delay, () => {
        void this.sendResolved(io, body).then((done) => {
          if (!done) this.retryResolved(io, body, untilMs, attempt + 1);
        });
      });
    }).catch(() => void 0);
  }
  /** Espera `ms` o hasta que la retención se resuelva, lo que ocurra antes. */
  pause(a, io, ms) {
    if (a.settled !== void 0) return Promise.resolve();
    return new Promise((resolve) => {
      let t;
      const wake = () => {
        t?.cancel();
        a.wakers.delete(wake);
        resolve();
      };
      a.wakers.add(wake);
      t = io.after(ms, wake);
    });
  }
  async pollLoop(a, io, pending, deadline, signal, state) {
    const { config } = this.deps;
    const seen = /* @__PURE__ */ new Set();
    while (a.settled === void 0) {
      if (signal?.aborted === true) {
        a.settle({ by: "abort", decision: "none" });
        return;
      }
      const t0 = await io.now();
      if (t0 >= deadline) {
        a.settle({ by: "timeout", decision: "none" });
        return;
      }
      const wait = Math.max(1, Math.min(this.pollWaitMs, deadline - t0));
      const url = `${config.url}/v0/perm/decision?tool_use_id=${encodeURIComponent(pending.toolUseId)}&wait=${wait}`;
      const r = await io.fetch(url, { method: "GET", headers: this.headers(false) }).catch(() => void 0);
      if (a.settled !== void 0) return;
      let decB64;
      if (r !== void 0 && r.status === 200) {
        try {
          const j = JSON.parse(r.text);
          if (j !== null && typeof j === "object" && typeof j.dec === "string") decB64 = j.dec;
        } catch {
          decB64 = void 0;
        }
      }
      if (decB64 !== void 0) {
        const verdict = await this.consider(io, pending, decB64, seen);
        if (a.settled !== void 0) return;
        if (verdict.ok) {
          a.settle({ by: "watch", decision: verdict.decision });
          return;
        }
        if (verdict.reason !== void 0) {
          if (!(verdict.reason === "replay" && state.reject !== void 0)) state.reject = verdict.reason;
          state.rejected++;
          this.log(`dec descartada para ${pending.toolUseId}: ${verdict.reason}`, io);
        }
      }
      const t1 = await io.now();
      const quick = t1 - t0 < Math.min(this.retryMs, wait);
      if (r === void 0 || r.status >= 300 || decB64 !== void 0 || quick) {
        await this.pause(a, io, Math.max(1, Math.min(this.retryMs, deadline - t1)));
      }
    }
  }
  /** Verifica una `dec` (§6.3) y aplica las reglas propias del holder (nonce sin usar, wok). */
  async consider(io, pending, decB64, seen) {
    if (seen.has(decB64)) return { ok: false, reason: "replay" };
    seen.add(decB64);
    let bytes2;
    try {
      bytes2 = b64uDecode(decB64);
    } catch {
      return { ok: false, reason: "malformed" };
    }
    const now = await io.now();
    let vr;
    try {
      vr = await this.deps.verify(pending, bytes2, now);
    } catch (err) {
      this.log(`el verificador lanz\xF3 (${String(err)})`, io);
      vr = { ok: false, reason: "sig" };
    }
    if (!vr.ok) return { ok: false, reason: asRejectReason(vr.reason) ?? "sig" };
    let frame;
    try {
      frame = decodeFrame(bytes2);
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (frame.type !== "dec") return { ok: false, reason: "malformed" };
    if (!sameBytes(frame.nonce, pending.nonce)) return { ok: false, reason: "nonce" };
    if (frame.toolUseId !== pending.toolUseId) return { ok: false, reason: "tool_use_id" };
    if (!sameBytes(frame.ph, permHash(pending))) return { ok: false, reason: "ph" };
    if (frame.ts > pending.exp + TS_SKEW_SEC || Math.floor(now / 1e3) > pending.exp) return { ok: false, reason: "expired" };
    if (frame.decision === "allow" && !pending.wok) return { ok: false, reason: "forbidden" };
    return { ok: true, decision: frame.decision };
  }
};

// src/core/say.ts
var sha2563 = sha256;
var SAY_FORMAT = 2;
var SAY_MAX_TEXT_BYTES = 1e3;
var SID_BYTES = 16;
var SAY_MAX_AGE_SEC = 120;
var SAY_SKEW_SEC = 30;
var SAY_KINDS = ["text", "stop", "recap"];
var RECAP_PROMPT = "Detente aqu\xED. Resume en pocas l\xEDneas en qu\xE9 estabas, qu\xE9 has hecho hasta ahora y qu\xE9 te bloquea o qu\xE9 necesitas de m\xED. No sigas trabajando hasta que te responda.";
var hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
function sessionSid(instanceId2, sessionId2) {
  return sha2563(encode(["orbit-sid", 1, instanceId2, sessionId2])).slice(0, SID_BYTES);
}
function sayInput(s) {
  return encode(["orbit-say", SAY_FORMAT, s.nonce, s.ts, s.instanceId, s.sid, s.kind, s.text]);
}
function parseSay(bytes2) {
  try {
    const v = decodeStrict(bytes2);
    if (!Array.isArray(v) || v.length !== 9 || v[0] !== "say") return void 0;
    const [, nonce, ts, instanceId2, sid, kind, text, kid, sig] = v;
    if (!(nonce instanceof Uint8Array) || nonce.length !== 16) return void 0;
    if (typeof ts !== "number" || !Number.isInteger(ts) || ts < 0) return void 0;
    if (typeof instanceId2 !== "string" || !(sid instanceof Uint8Array) || sid.length !== SID_BYTES) return void 0;
    if (!SAY_KINDS.includes(kind) || typeof text !== "string") return void 0;
    if (new TextEncoder().encode(text).length > SAY_MAX_TEXT_BYTES) return void 0;
    if (!(kid instanceof Uint8Array) || kid.length !== 8 || !(sig instanceof Uint8Array) || sig.length !== 64) return void 0;
    return { nonce, ts, instanceId: instanceId2, sid, kind, text, kid, sig };
  } catch {
    return void 0;
  }
}
function verifySay(bytes2, keys, now, instanceId2, sessionId2, seen) {
  const s = parseSay(bytes2);
  if (s === void 0) return { ok: false, reason: "malformed" };
  if (s.instanceId !== instanceId2) return { ok: false, reason: "instance" };
  if (hex(s.sid) !== hex(sessionSid(instanceId2, sessionId2))) return { ok: false, reason: "session" };
  const key = keys.find((k) => hex(k.kid) === hex(s.kid));
  if (key === void 0) return { ok: false, reason: "kid" };
  if (!verifySignature(key.spki, sayInput(s), s.sig)) return { ok: false, reason: "sig" };
  if (s.ts > now + SAY_SKEW_SEC || s.ts < now - SAY_MAX_AGE_SEC) return { ok: false, reason: "expired" };
  const nonceHex = hex(s.nonce);
  if (seen.has(nonceHex)) return { ok: false, reason: "replay" };
  return { ok: true, kind: s.kind, text: s.text, nonceHex };
}
function sayPlan(kind, text, turnActive) {
  switch (kind) {
    case "text":
      return turnActive ? { abort: false, note: text } : { abort: false, submitNow: text };
    case "stop":
      return { abort: turnActive };
    case "recap": {
      const prompt = text.trim() === "" ? RECAP_PROMPT : text;
      return turnActive ? { abort: true, submitAfterTurn: prompt } : { abort: false, submitNow: prompt };
    }
  }
}

// src/core/replies.ts
var REPLIES_MAX = 8;
var REPLY_MAX_BYTES = 64;
var DEFAULT_REPLIES = ["Contin\xFAa", "S\xED", "No", "Resume en qu\xE9 est\xE1s", "Prueba otra forma"];
var REPLIES_KEY = "orbit.replies";
var REPLIES_FILE = "replies.json";
var bytes = (s) => new TextEncoder().encode(s).length;
var CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
function replyProblem(text) {
  const t = text.trim();
  if (t === "") return "est\xE1 vac\xEDa";
  if (bytes(t) > REPLY_MAX_BYTES) return `pasa de ${REPLY_MAX_BYTES} bytes`;
  if (CONTROL.test(t)) return "lleva caracteres de control";
  return void 0;
}
function cleanReplies(list) {
  const out = [];
  for (const r of list) {
    if (typeof r !== "string" || replyProblem(r) !== void 0) continue;
    const t = r.trim();
    if (!out.includes(t)) out.push(t);
    if (out.length === REPLIES_MAX) break;
  }
  return out;
}
function readReplies(raw) {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return void 0;
    }
  }
  if (v === null || typeof v !== "object" || !Array.isArray(v.replies)) return void 0;
  return cleanReplies(v.replies);
}
function writeReplies(list) {
  return { v: 1, replies: cleanReplies(list) };
}
var REPLIES_USAGE = "uso: /orbit respuestas [a\xF1adir <texto> | quitar <n> | restablecer]";
function parseRepliesCommand(args) {
  const m = /^\s*(respuestas|replies)(?:\s+([\s\S]*))?$/i.exec(args);
  if (m === null) return void 0;
  const rest = (m[2] ?? "").trim();
  if (rest === "" || /^(lista|list)$/i.test(rest)) return { kind: "list" };
  if (/^(restablecer|reset)$/i.test(rest)) return { kind: "reset" };
  const add = /^(añadir|anadir|add)\s+([\s\S]+)$/i.exec(rest);
  if (add !== null) {
    const text = add[2].trim().replace(/^"(.*)"$/s, "$1").trim();
    const why = replyProblem(text);
    return why === void 0 ? { kind: "add", text } : { kind: "invalid", why: `la respuesta ${why}` };
  }
  const rm = /^(quitar|remove|rm)\s+(\d+)$/i.exec(rest);
  if (rm !== null) return { kind: "remove", index: Number(rm[2]) };
  return { kind: "invalid", why: REPLIES_USAGE };
}
function applyRepliesCommand(current, cmd) {
  const list = [...current ?? DEFAULT_REPLIES];
  const show = (l) => [`respuestas r\xE1pidas del reloj (${l.length}/${REPLIES_MAX})${current === void 0 ? ", las de por defecto" : ""}:`, ...l.map((r, i) => `  ${i + 1}. ${r}`), "  adem\xE1s, siempre: Detente y Detente y resume"].join("\n");
  switch (cmd.kind) {
    case "list":
      return { list, changed: false, message: show(list) };
    case "reset":
      return { list: [...DEFAULT_REPLIES], changed: true, message: `restablecidas
${show(DEFAULT_REPLIES)}` };
    case "add": {
      if (list.includes(cmd.text)) return { list, changed: false, message: `ya estaba
${show(list)}` };
      if (list.length >= REPLIES_MAX) return { list, changed: false, message: `ya hay ${REPLIES_MAX}: quita una antes (/orbit respuestas quitar <n>)` };
      const next = [...list, cmd.text];
      return { list: next, changed: true, message: `a\xF1adida: ${cmd.text}
${show(next)}` };
    }
    case "remove": {
      if (cmd.index < 1 || cmd.index > list.length) return { list, changed: false, message: `no hay respuesta ${cmd.index}
${show(list)}` };
      const next = list.filter((_, i) => i !== cmd.index - 1);
      return { list: next, changed: true, message: `quitada: ${list[cmd.index - 1]}
${show(next)}` };
    }
    case "invalid":
      return { list, changed: false, message: cmd.why };
  }
}

// src/core/links.ts
var LINKS_PER_RESULT = 3;
var ARTIFACT_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/g;
var GITHUB_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(pull|issues)\/(\d+)/g;
var DOC_RE = /\.(html?|md|pdf|png|jpe?g|gif|svg|webp|csv|mp4)$/i;
var BASH_OUT_RE = /(?:>>?|\s-o|--output[= ])\s*(['"]?)([^\s'"|;&<>]+)\1/g;
function basename(p) {
  const parts = p.split(/[\\/]/).filter((x) => x !== "");
  return parts[parts.length - 1] ?? p;
}
function str3(v) {
  return typeof v === "string" && v !== "" ? v : void 0;
}
function absolute(p, cwd) {
  if (p.startsWith("/")) return p;
  if (cwd === void 0 || p.startsWith("~") || p.startsWith("$")) return void 0;
  return `${cwd.replace(/\/+$/, "")}/${p.replace(/^\.\//, "")}`;
}
function linksOf(tool, input, resultText, isError, cwd) {
  if (isError) return [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (l) => {
    const key = l.url ?? l.path ?? "";
    if (key === "" || seen.has(key) || out.length >= LINKS_PER_RESULT) return;
    seen.add(key);
    out.push(l);
  };
  const inp = input !== null && typeof input === "object" ? input : {};
  if (tool === "Write") {
    const p = str3(inp.file_path);
    if (p !== void 0) add({ kind: "file", name: basename(p), path: p });
  }
  if (tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") {
    const p = str3(inp.file_path) ?? str3(inp.notebook_path);
    if (p !== void 0 && DOC_RE.test(p)) add({ kind: "file", name: basename(p), path: p });
  }
  if (tool === "Bash") {
    const cmd = str3(inp.command) ?? "";
    for (const m of cmd.matchAll(BASH_OUT_RE)) {
      const p = m[2] !== void 0 && DOC_RE.test(m[2]) ? absolute(m[2], cwd) : void 0;
      if (p !== void 0) add({ kind: "file", name: basename(p), path: p });
    }
  }
  const text = typeof resultText === "string" ? resultText.slice(0, 2e4) : "";
  for (const m of text.matchAll(ARTIFACT_RE)) add({ kind: "link", name: "Artifact", url: m[0] });
  for (const m of text.matchAll(GITHUB_RE)) add({ kind: "link", name: `${m[1] === "pull" ? "PR" : "Issue"} #${m[2]}`, url: m[0] });
  return out;
}
function profileOf(configDir) {
  const d = str3(configDir);
  if (d === void 0) return "claude";
  const b = basename(d);
  return b === ".claude" ? "claude" : b;
}
var WatchNotes = class {
  notes = [];
  push(text) {
    this.notes.push(text);
  }
  get size() {
    return this.notes.length;
  }
  /** Vacía las notas como texto de contexto, o undefined si no hay ninguna. */
  takeContext() {
    if (this.notes.length === 0) return void 0;
    const t = this.notes.map((n) => `Mensaje del usuario desde su reloj (Orbit), mientras trabajas: ${n}`).join("\n");
    this.notes = [];
    return t;
  }
  /** Vacía las notas como un único prompt (fin de turno sin tool de por medio). */
  takePrompt() {
    if (this.notes.length === 0) return void 0;
    const t = this.notes.join("\n");
    this.notes = [];
    return t;
  }
};
function withContext(result, extra) {
  if (result === null || typeof result !== "object") return result;
  const r = result;
  const prev = r.context;
  const list = typeof prev === "string" ? [prev] : Array.isArray(prev) ? prev.filter((x) => typeof x === "string") : [];
  return { ...r, context: [...list, extra] };
}

// src/core/pairing.ts
var WORDS = [
  "abeja",
  "abeto",
  "abrigo",
  "aceite",
  "acero",
  "agua",
  "aguila",
  "ajo",
  "ala",
  "alamo",
  "alce",
  "alga",
  "almeja",
  "alto",
  "ancla",
  "angel",
  "anillo",
  "anis",
  "apio",
  "arbol",
  "arco",
  "arena",
  "arpa",
  "arroz",
  "asno",
  "atun",
  "aula",
  "ave",
  "avena",
  "azul",
  "bahia",
  "balsa",
  "banco",
  "barco",
  "barro",
  "bata",
  "baul",
  "bello",
  "beso",
  "bici",
  "boca",
  "bola",
  "bolsa",
  "bosque",
  "bota",
  "brisa",
  "brujo",
  "buho",
  "burro",
  "cabra",
  "cacao",
  "cactus",
  "cafe",
  "caja",
  "caldo",
  "calle",
  "cama",
  "campo",
  "canoa",
  "capa",
  "carne",
  "carta",
  "casa",
  "cebra",
  "cedro",
  "cena",
  "cerdo",
  "cesta",
  "cielo",
  "cine",
  "cisne",
  "clavo",
  "cobre",
  "coco",
  "cofre",
  "coral",
  "corcho",
  "cuervo",
  "cuna",
  "danza",
  "dardo",
  "dedo",
  "delfin",
  "diente",
  "disco",
  "dolar",
  "dragon",
  "duna",
  "eco",
  "eje",
  "elfo",
  "enano",
  "erizo",
  "espiga",
  "faro",
  "fiesta",
  "flan",
  "flor",
  "fresa",
  "fruta",
  "fuego",
  "fuente",
  "gafas",
  "gallo",
  "ganso",
  "gato",
  "globo",
  "gnomo",
  "gorila",
  "gorra",
  "grano",
  "grillo",
  "grulla",
  "guante",
  "haba",
  "hacha",
  "hada",
  "hielo",
  "hierba",
  "higo",
  "hoja",
  "hongo",
  "horno",
  "hueso",
  "huevo",
  "iglu",
  "iman",
  "isla",
  "jabon",
  "jade",
  "jarra",
  "jaula",
  "jirafa",
  "joya",
  "judia",
  "jugo",
  "kayak",
  "kiwi",
  "koala",
  "lago",
  "lana",
  "lapiz",
  "laurel",
  "leche",
  "lemur",
  "leon",
  "libro",
  "limon",
  "lince",
  "lirio",
  "llama",
  "llave",
  "lobo",
  "loro",
  "luna",
  "madera",
  "maiz",
  "malva",
  "mango",
  "mano",
  "manta",
  "mapa",
  "mar",
  "marco",
  "mesa",
  "miel",
  "mina",
  "mirlo",
  "monte",
  "muro",
  "nariz",
  "nave",
  "nido",
  "niebla",
  "nieve",
  "noche",
  "nogal",
  "nube",
  "nuez",
  "oasis",
  "ola",
  "olivo",
  "olmo",
  "onda",
  "orca",
  "oreja",
  "oro",
  "oso",
  "ostra",
  "oveja",
  "pala",
  "palma",
  "pan",
  "panda",
  "pato",
  "perla",
  "pez",
  "piano",
  "piedra",
  "pino",
  "plata",
  "playa",
  "pluma",
  "polen",
  "pollo",
  "pomelo",
  "pozo",
  "puente",
  "pulpo",
  "puma",
  "queso",
  "quinoa",
  "rana",
  "raton",
  "rayo",
  "remo",
  "reno",
  "roble",
  "roca",
  "rosa",
  "rubi",
  "rueda",
  "salmon",
  "salvia",
  "selva",
  "silla",
  "sol",
  "sopa",
  "taza",
  "tejon",
  "tigre",
  "tinta",
  "tomate",
  "toro",
  "torre",
  "tren",
  "trigo",
  "trucha",
  "urraca",
  "uva",
  "vaca",
  "valle",
  "vela",
  "velero",
  "verde",
  "vino",
  "violin",
  "volcan",
  "yate",
  "yegua",
  "yeso",
  "yoyo",
  "zafiro",
  "zanja",
  "zorro",
  "zumo"
];
var MAX_PAIRED_KEYS = 8;
var PAIR_STORE_KEY = (instanceId2) => `orbit.pair.keys.${instanceId2}`;
function hexOf(b) {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function fingerprint(kid) {
  if (kid.length !== 8) throw new Error(`kid de ${kid.length} bytes (se esperaban 8)`);
  const h = hexOf(kid);
  return { hex: (h.match(/.{4}/g) ?? []).join(" "), words: Array.from(kid, (b) => WORDS[b]) };
}
function parseKidInput(input) {
  const s = input.trim().toLowerCase();
  const compact = s.replace(/[\s:-]/g, "");
  if (/^[0-9a-f]{16}$/.test(compact)) {
    const out = new Uint8Array(8);
    for (let i = 0; i < 8; i++) out[i] = parseInt(compact.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  const words = s.split(/[\s,-]+/).filter((w) => w !== "");
  if (words.length === 8) {
    const out = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      const idx = WORDS.indexOf(words[i]);
      if (idx < 0) return void 0;
      out[i] = idx;
    }
    return out;
  }
  return void 0;
}
var B642 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function b64uEncode2(b) {
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = b[i] << 16 | (b[i + 1] ?? 0) << 8 | (b[i + 2] ?? 0);
    const chars = [B642[n >> 18 & 63], B642[n >> 12 & 63], B642[n >> 6 & 63], B642[n & 63]];
    out += chars.slice(0, b.length - i >= 3 ? 4 : b.length - i + 1).join("");
  }
  return out;
}
function b64uDecode2(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error("base64url inv\xE1lido");
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const c of s) {
    acc = acc << 6 | B642.indexOf(c);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push(acc >> bits & 255);
    }
  }
  if (bits > 0 && (acc & (1 << bits) - 1) !== 0) throw new Error("base64url no can\xF3nico");
  return Uint8Array.from(out);
}
function readStoredKeys(raw) {
  const stored = [];
  const keys = [];
  let invalid = 0;
  const list = raw !== null && typeof raw === "object" && raw.v === 1 ? raw.keys : void 0;
  if (!Array.isArray(list)) return { stored, keys, invalid: raw === void 0 || raw === null ? 0 : 1 };
  for (const e of list) {
    try {
      const o = e;
      if (typeof o.kid !== "string" || typeof o.spki !== "string") throw new Error("forma");
      const spki = b64uDecode2(o.spki);
      spkiPoint(spki);
      const kid = kidOf(spki);
      if (hexOf(kid) !== o.kid) throw new Error("kid");
      if (keys.some((k) => hexOf(k.kid) === o.kid)) continue;
      stored.push({ kid: o.kid, spki: o.spki, label: sanitizeLabel(o.label), paired_at: Number(o.paired_at) || 0 });
      keys.push({ kid, spki });
    } catch {
      invalid++;
    }
  }
  return { stored, keys, invalid };
}
function sanitizeLabel(v) {
  if (typeof v !== "string") return "";
  return Array.from(v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "")).slice(0, 32).join("");
}
function parseOffers(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("respuesta del servidor que no es JSON");
  }
  const list = body !== null && typeof body === "object" ? body.offers : void 0;
  if (!Array.isArray(list)) throw new Error("respuesta del servidor sin 'offers'");
  const offers = [];
  let dropped = 0;
  for (const e of list) {
    try {
      const o = e;
      const spki = b64uDecode2(String(o.spki));
      spkiPoint(spki);
      const kid = kidOf(spki);
      if (typeof o.kid !== "string" || o.kid !== b64uEncode2(kid)) throw new Error("kid");
      if (offers.some((x) => hexOf(x.kid) === hexOf(kid))) continue;
      let tag;
      if (typeof o.tag === "string") {
        try {
          const t = b64uDecode2(o.tag);
          if (t.length === 32) tag = t;
        } catch {
        }
      }
      offers.push({ kid, spki, label: sanitizeLabel(o.label), createdMs: Number(o.created_ms) || 0, expiresMs: Number(o.expires_ms) || 0, tag });
    } catch {
      dropped++;
    }
  }
  return { offers, dropped };
}
var PAIR_USAGE = [
  "uso:",
  "  /orbit setup                     QR para el tel\xE9fono: lo configura y empareja el reloj solo",
  "  /orbit pair                      ofertas pendientes del reloj, con su huella",
  "  /orbit pair confirm <huella>     empareja la llave cuya huella coincide con la del reloj",
  "  /orbit pair reject <huella>      descarta una oferta",
  "  /orbit pair keys                 llaves emparejadas",
  "  /orbit unpair <huella>           revoca una llave emparejada"
].join("\n");
function parsePairCommand(args) {
  const parts = args.trim().split(/\s+/);
  const head = (parts[0] ?? "").toLowerCase();
  if (head !== "pair" && head !== "unpair") return void 0;
  const kidArg = (from) => parseKidInput(parts.slice(from).join(" "));
  if (head === "unpair") {
    const kid = kidArg(1);
    return kid === void 0 ? { kind: "invalid", message: `huella inv\xE1lida
${PAIR_USAGE}` } : { kind: "unpair", kid };
  }
  const sub = (parts[1] ?? "").toLowerCase();
  if (sub === "" || sub === "list") return { kind: "list" };
  if (sub === "keys") return { kind: "keys" };
  if (sub === "confirm" || sub === "reject") {
    const kid = kidArg(2);
    if (kid === void 0) return { kind: "invalid", message: `huella inv\xE1lida: escribe las 16 cifras hex (o las 8 palabras) que muestra el reloj
${PAIR_USAGE}` };
    return { kind: sub, kid };
  }
  return { kind: "invalid", message: PAIR_USAGE };
}
function ago2(now, at) {
  const s = Math.max(0, Math.round((now - at) / 1e3));
  return s < 60 ? `hace ${s}s` : s < 3600 ? `hace ${Math.round(s / 60)}min` : `hace ${Math.round(s / 3600)}h`;
}
function clockTime(ms) {
  const two = (n) => String(n).padStart(2, "0");
  try {
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  } catch {
  }
  const s = Math.floor(ms / 1e3) % 86400;
  return `${two(Math.floor(s / 3600))}:${two(Math.floor(s % 3600 / 60))}:${two(s % 60)} UTC`;
}
function describe(kid) {
  const f = fingerprint(kid);
  return `${f.hex}  (${f.words.join(" ")})`;
}
async function fetchOffers(cfg, io) {
  const r = await io.fetch(`${cfg.url}/v0/pair/offers`, { method: "GET", headers: { authorization: `Bearer ${cfg.token}` } });
  if (r.status === 401) throw new Error("el servidor rechaz\xF3 el token (401)");
  if (!r.ok) throw new Error(`el servidor respondi\xF3 ${r.status}`);
  return parseOffers(r.text);
}
async function deleteOffer(cfg, io, kid) {
  try {
    const r = await io.fetch(`${cfg.url}/v0/pair/offers/${b64uEncode2(kid)}`, { method: "DELETE", headers: { authorization: `Bearer ${cfg.token}` } });
    return r.ok || r.status === 404;
  } catch {
    return false;
  }
}
async function loadPairedKeys(instanceId2, io) {
  return readStoredKeys(await io.load(PAIR_STORE_KEY(instanceId2))).keys;
}
async function runPairCommand(cfg, io, action, instanceId2) {
  if (action.kind === "invalid") return action.message;
  const inst = cfg?.instanceId ?? instanceId2;
  if (inst === void 0) return "orbit sin configurar: no hay instancia (ORBIT_INSTANCE_ID)";
  const storeKey = PAIR_STORE_KEY(inst);
  const current = readStoredKeys(await io.load(storeKey));
  const now = Number(await io.now());
  const save = (stored) => io.save(storeKey, stored.length === 0 ? null : { v: 1, keys: stored });
  if (action.kind === "keys") {
    if (current.stored.length === 0) return "no hay ninguna llave emparejada (el reloj no puede aprobar nada)";
    const lines = [`llaves emparejadas (${current.stored.length}):`];
    for (const k of current.stored) lines.push(`  ${describe(hexToBytes3(k.kid))}  ${k.label || "(sin nombre)"}  emparejada ${ago2(now, k.paired_at)}`);
    if (current.invalid > 0) lines.push(`  (${current.invalid} entradas inv\xE1lidas ignoradas)`);
    return lines.join("\n");
  }
  if (action.kind === "unpair") {
    const hex3 = hexOf(action.kid);
    const rest = current.stored.filter((k) => k.kid !== hex3);
    if (rest.length === current.stored.length) return `no hay ninguna llave emparejada con la huella ${fingerprint(action.kid).hex}`;
    await save(rest);
    return `llave revocada: ${describe(action.kid)}. Sus decisiones se rechazan desde ya.`;
  }
  if (cfg === void 0) return "orbit sin configurar: hace falta ORBIT_URL y ORBIT_TOKEN para ver las ofertas del reloj";
  if (action.kind === "list") {
    const { offers: offers2, dropped } = await fetchOffers(cfg, io);
    const lines = [];
    if (offers2.length === 0) lines.push("no hay ofertas de emparejamiento pendientes. Lo m\xE1s f\xE1cil: /orbit setup y escanear el QR con el tel\xE9fono (o, en el reloj, Orbit > Emparejar).");
    else {
      lines.push(`ofertas pendientes (${offers2.length}). Compara la huella con la que muestra el reloj:`);
      for (const o of offers2) {
        const paired = current.stored.some((k) => k.kid === hexOf(o.kid)) ? "  [ya emparejada]" : "";
        lines.push(`  ${describe(o.kid)}  ${o.label || "(sin nombre)"}  publicada a las ${clockTime(o.createdMs)} (${ago2(now, o.createdMs)})${paired}`);
      }
      if (offers2.length > 1) {
        lines.push(
          `AVISO: hay ${offers2.length} ofertas pendientes. Si solo has pedido emparejar un reloj, alguna no es tuya: confirma \xFAnicamente la que coincide con la huella y la hora que ves en el reloj.`
        );
      }
      lines.push("Si coincide ENTERA: /orbit pair confirm <huella>. Si no coincide, no la confirmes: /orbit pair reject <huella>.");
    }
    if (dropped > 0) lines.push(`(${dropped} ofertas descartadas: SPKI inv\xE1lido o kid que no corresponde a su llave)`);
    lines.push(`llaves emparejadas: ${current.stored.length} (/orbit pair keys)`);
    return lines.join("\n");
  }
  const hex2 = hexOf(action.kid);
  if (action.kind === "reject") {
    const ok = await deleteOffer(cfg, io, action.kid);
    return ok ? `oferta descartada: ${fingerprint(action.kid).hex}` : "no se pudo descartar la oferta en el servidor";
  }
  if (current.stored.some((k) => k.kid === hex2)) return `esa llave ya est\xE1 emparejada: ${describe(action.kid)}`;
  const { offers } = await fetchOffers(cfg, io);
  const offer = offers.find((o) => hexOf(o.kid) === hex2);
  if (offer === void 0) return `no hay ninguna oferta pendiente con la huella ${fingerprint(action.kid).hex}. Lista: /orbit pair`;
  if (current.stored.length >= MAX_PAIRED_KEYS) return `ya hay ${MAX_PAIRED_KEYS} llaves emparejadas: revoca alguna con /orbit unpair <huella>`;
  await save([...current.stored, { kid: hex2, spki: b64uEncode2(offer.spki), label: offer.label, paired_at: now }]);
  const removed = await deleteOffer(cfg, io, offer.kid);
  return [
    `llave emparejada: ${describe(offer.kid)}  ${offer.label || "(sin nombre)"}`,
    "desde ahora el reloj puede aprobar y denegar permisos de esta instancia.",
    removed ? "" : "(no se pudo borrar la oferta del servidor; caducar\xE1 sola)"
  ].filter((l) => l !== "").join("\n");
}
function hexToBytes3(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
var SHARED_KEYS_FILE = "paired-keys.json";
function readSharedKeys(text) {
  const out = { v: 1, instances: {} };
  if (text === void 0) return out;
  try {
    const raw = JSON.parse(text);
    if (raw.v !== 1 || raw.instances === null || typeof raw.instances !== "object") return out;
    for (const [inst, list] of Object.entries(raw.instances)) {
      const { stored } = readStoredKeys({ v: 1, keys: list });
      if (stored.length > 0) out.instances[inst] = stored;
    }
  } catch {
  }
  return out;
}
function mergeStoredKeys(a, b) {
  const byKid = /* @__PURE__ */ new Map();
  for (const k of [...a, ...b]) if (!byKid.has(k.kid)) byKid.set(k.kid, k);
  return [...byKid.values()].sort((x, y) => y.paired_at - x.paired_at).slice(0, MAX_PAIRED_KEYS);
}
function writeSharedKeys(current, instanceId2, value) {
  const next = { v: 1, instances: { ...current.instances } };
  const keys = value === null ? [] : readStoredKeys(value).stored;
  if (keys.length === 0) delete next.instances[instanceId2];
  else next.instances[instanceId2] = keys;
  return JSON.stringify(next, null, 2) + "\n";
}

// src/vendor/qrcode.ts
var qrcode = function(typeNumber, errorCorrectionLevel) {
  const PAD0 = 236;
  const PAD1 = 17;
  let _typeNumber = typeNumber;
  const _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
  let _modules = null;
  let _moduleCount = 0;
  let _dataCache = null;
  const _dataList = [];
  const _this = {};
  const makeImpl = function(test, maskPattern) {
    _moduleCount = _typeNumber * 4 + 17;
    _modules = (function(moduleCount) {
      const modules = new Array(moduleCount);
      for (let row = 0; row < moduleCount; row += 1) {
        modules[row] = new Array(moduleCount);
        for (let col = 0; col < moduleCount; col += 1) {
          modules[row][col] = null;
        }
      }
      return modules;
    })(_moduleCount);
    setupPositionProbePattern(0, 0);
    setupPositionProbePattern(_moduleCount - 7, 0);
    setupPositionProbePattern(0, _moduleCount - 7);
    setupPositionAdjustPattern();
    setupTimingPattern();
    setupTypeInfo(test, maskPattern);
    if (_typeNumber >= 7) {
      setupTypeNumber(test);
    }
    if (_dataCache == null) {
      _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
    }
    mapData(_dataCache, maskPattern);
  };
  const setupPositionProbePattern = function(row, col) {
    for (let r = -1; r <= 7; r += 1) {
      if (row + r <= -1 || _moduleCount <= row + r) continue;
      for (let c = -1; c <= 7; c += 1) {
        if (col + c <= -1 || _moduleCount <= col + c) continue;
        if (0 <= r && r <= 6 && (c == 0 || c == 6) || 0 <= c && c <= 6 && (r == 0 || r == 6) || 2 <= r && r <= 4 && 2 <= c && c <= 4) {
          _modules[row + r][col + c] = true;
        } else {
          _modules[row + r][col + c] = false;
        }
      }
    }
  };
  const getBestMaskPattern = function() {
    let minLostPoint = 0;
    let pattern = 0;
    for (let i = 0; i < 8; i += 1) {
      makeImpl(true, i);
      const lostPoint = QRUtil.getLostPoint(_this);
      if (i == 0 || minLostPoint > lostPoint) {
        minLostPoint = lostPoint;
        pattern = i;
      }
    }
    return pattern;
  };
  const setupTimingPattern = function() {
    for (let r = 8; r < _moduleCount - 8; r += 1) {
      if (_modules[r][6] != null) {
        continue;
      }
      _modules[r][6] = r % 2 == 0;
    }
    for (let c = 8; c < _moduleCount - 8; c += 1) {
      if (_modules[6][c] != null) {
        continue;
      }
      _modules[6][c] = c % 2 == 0;
    }
  };
  const setupPositionAdjustPattern = function() {
    const pos = QRUtil.getPatternPosition(_typeNumber);
    for (let i = 0; i < pos.length; i += 1) {
      for (let j = 0; j < pos.length; j += 1) {
        const row = pos[i];
        const col = pos[j];
        if (_modules[row][col] != null) {
          continue;
        }
        for (let r = -2; r <= 2; r += 1) {
          for (let c = -2; c <= 2; c += 1) {
            if (r == -2 || r == 2 || c == -2 || c == 2 || r == 0 && c == 0) {
              _modules[row + r][col + c] = true;
            } else {
              _modules[row + r][col + c] = false;
            }
          }
        }
      }
    }
  };
  const setupTypeNumber = function(test) {
    const bits = QRUtil.getBCHTypeNumber(_typeNumber);
    for (let i = 0; i < 18; i += 1) {
      const mod2 = !test && (bits >> i & 1) == 1;
      _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod2;
    }
    for (let i = 0; i < 18; i += 1) {
      const mod2 = !test && (bits >> i & 1) == 1;
      _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod2;
    }
  };
  const setupTypeInfo = function(test, maskPattern) {
    const data = _errorCorrectionLevel << 3 | maskPattern;
    const bits = QRUtil.getBCHTypeInfo(data);
    for (let i = 0; i < 15; i += 1) {
      const mod2 = !test && (bits >> i & 1) == 1;
      if (i < 6) {
        _modules[i][8] = mod2;
      } else if (i < 8) {
        _modules[i + 1][8] = mod2;
      } else {
        _modules[_moduleCount - 15 + i][8] = mod2;
      }
    }
    for (let i = 0; i < 15; i += 1) {
      const mod2 = !test && (bits >> i & 1) == 1;
      if (i < 8) {
        _modules[8][_moduleCount - i - 1] = mod2;
      } else if (i < 9) {
        _modules[8][15 - i - 1 + 1] = mod2;
      } else {
        _modules[8][15 - i - 1] = mod2;
      }
    }
    _modules[_moduleCount - 8][8] = !test;
  };
  const mapData = function(data, maskPattern) {
    let inc = -1;
    let row = _moduleCount - 1;
    let bitIndex = 7;
    let byteIndex = 0;
    const maskFunc = QRUtil.getMaskFunction(maskPattern);
    for (let col = _moduleCount - 1; col > 0; col -= 2) {
      if (col == 6) col -= 1;
      while (true) {
        for (let c = 0; c < 2; c += 1) {
          if (_modules[row][col - c] == null) {
            let dark = false;
            if (byteIndex < data.length) {
              dark = (data[byteIndex] >>> bitIndex & 1) == 1;
            }
            const mask = maskFunc(row, col - c);
            if (mask) {
              dark = !dark;
            }
            _modules[row][col - c] = dark;
            bitIndex -= 1;
            if (bitIndex == -1) {
              byteIndex += 1;
              bitIndex = 7;
            }
          }
        }
        row += inc;
        if (row < 0 || _moduleCount <= row) {
          row -= inc;
          inc = -inc;
          break;
        }
      }
    }
  };
  const createBytes = function(buffer, rsBlocks) {
    let offset = 0;
    let maxDcCount = 0;
    let maxEcCount = 0;
    const dcdata = new Array(rsBlocks.length);
    const ecdata = new Array(rsBlocks.length);
    for (let r = 0; r < rsBlocks.length; r += 1) {
      const dcCount = rsBlocks[r].dataCount;
      const ecCount = rsBlocks[r].totalCount - dcCount;
      maxDcCount = Math.max(maxDcCount, dcCount);
      maxEcCount = Math.max(maxEcCount, ecCount);
      dcdata[r] = new Array(dcCount);
      for (let i = 0; i < dcdata[r].length; i += 1) {
        dcdata[r][i] = 255 & buffer.getBuffer()[i + offset];
      }
      offset += dcCount;
      const rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
      const rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);
      const modPoly = rawPoly.mod(rsPoly);
      ecdata[r] = new Array(rsPoly.getLength() - 1);
      for (let i = 0; i < ecdata[r].length; i += 1) {
        const modIndex = i + modPoly.getLength() - ecdata[r].length;
        ecdata[r][i] = modIndex >= 0 ? modPoly.getAt(modIndex) : 0;
      }
    }
    let totalCodeCount = 0;
    for (let i = 0; i < rsBlocks.length; i += 1) {
      totalCodeCount += rsBlocks[i].totalCount;
    }
    const data = new Array(totalCodeCount);
    let index = 0;
    for (let i = 0; i < maxDcCount; i += 1) {
      for (let r = 0; r < rsBlocks.length; r += 1) {
        if (i < dcdata[r].length) {
          data[index] = dcdata[r][i];
          index += 1;
        }
      }
    }
    for (let i = 0; i < maxEcCount; i += 1) {
      for (let r = 0; r < rsBlocks.length; r += 1) {
        if (i < ecdata[r].length) {
          data[index] = ecdata[r][i];
          index += 1;
        }
      }
    }
    return data;
  };
  const createData = function(typeNumber2, errorCorrectionLevel2, dataList) {
    const rsBlocks = QRRSBlock.getRSBlocks(typeNumber2, errorCorrectionLevel2);
    const buffer = qrBitBuffer();
    for (let i = 0; i < dataList.length; i += 1) {
      const data = dataList[i];
      buffer.put(data.getMode(), 4);
      buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber2));
      data.write(buffer);
    }
    let totalDataCount = 0;
    for (let i = 0; i < rsBlocks.length; i += 1) {
      totalDataCount += rsBlocks[i].dataCount;
    }
    if (buffer.getLengthInBits() > totalDataCount * 8) {
      throw "code length overflow. (" + buffer.getLengthInBits() + ">" + totalDataCount * 8 + ")";
    }
    if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
      buffer.put(0, 4);
    }
    while (buffer.getLengthInBits() % 8 != 0) {
      buffer.putBit(false);
    }
    while (true) {
      if (buffer.getLengthInBits() >= totalDataCount * 8) {
        break;
      }
      buffer.put(PAD0, 8);
      if (buffer.getLengthInBits() >= totalDataCount * 8) {
        break;
      }
      buffer.put(PAD1, 8);
    }
    return createBytes(buffer, rsBlocks);
  };
  _this.addData = function(data, mode) {
    mode = mode || "Byte";
    let newData = null;
    switch (mode) {
      case "Numeric":
        newData = qrNumber(data);
        break;
      case "Alphanumeric":
        newData = qrAlphaNum(data);
        break;
      case "Byte":
        newData = qr8BitByte(data);
        break;
      case "Kanji":
        newData = qrKanji(data);
        break;
      default:
        throw "mode:" + mode;
    }
    _dataList.push(newData);
    _dataCache = null;
  };
  _this.isDark = function(row, col) {
    if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
      throw row + "," + col;
    }
    return _modules[row][col];
  };
  _this.getModuleCount = function() {
    return _moduleCount;
  };
  _this.make = function() {
    if (_typeNumber < 1) {
      let typeNumber2 = 1;
      for (; typeNumber2 < 40; typeNumber2++) {
        const rsBlocks = QRRSBlock.getRSBlocks(typeNumber2, _errorCorrectionLevel);
        const buffer = qrBitBuffer();
        for (let i = 0; i < _dataList.length; i++) {
          const data = _dataList[i];
          buffer.put(data.getMode(), 4);
          buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber2));
          data.write(buffer);
        }
        let totalDataCount = 0;
        for (let i = 0; i < rsBlocks.length; i++) {
          totalDataCount += rsBlocks[i].dataCount;
        }
        if (buffer.getLengthInBits() <= totalDataCount * 8) {
          break;
        }
      }
      _typeNumber = typeNumber2;
    }
    makeImpl(false, getBestMaskPattern());
  };
  _this.createTableTag = function(cellSize, margin) {
    cellSize = cellSize || 2;
    margin = typeof margin == "undefined" ? cellSize * 4 : margin;
    let qrHtml = "";
    qrHtml += '<table style="';
    qrHtml += " border-width: 0px; border-style: none;";
    qrHtml += " border-collapse: collapse;";
    qrHtml += " padding: 0px; margin: " + margin + "px;";
    qrHtml += '">';
    qrHtml += "<tbody>";
    for (let r = 0; r < _this.getModuleCount(); r += 1) {
      qrHtml += "<tr>";
      for (let c = 0; c < _this.getModuleCount(); c += 1) {
        qrHtml += '<td style="';
        qrHtml += " border-width: 0px; border-style: none;";
        qrHtml += " border-collapse: collapse;";
        qrHtml += " padding: 0px; margin: 0px;";
        qrHtml += " width: " + cellSize + "px;";
        qrHtml += " height: " + cellSize + "px;";
        qrHtml += " background-color: ";
        qrHtml += _this.isDark(r, c) ? "#000000" : "#ffffff";
        qrHtml += ";";
        qrHtml += '"/>';
      }
      qrHtml += "</tr>";
    }
    qrHtml += "</tbody>";
    qrHtml += "</table>";
    return qrHtml;
  };
  _this.createSvgTag = function(cellSize, margin, alt, title) {
    let opts = {};
    if (typeof arguments[0] == "object") {
      opts = arguments[0];
      cellSize = opts.cellSize;
      margin = opts.margin;
      alt = opts.alt;
      title = opts.title;
    }
    cellSize = cellSize || 2;
    margin = typeof margin == "undefined" ? cellSize * 4 : margin;
    alt = typeof alt === "string" ? { text: alt } : alt || {};
    alt.text = alt.text || null;
    alt.id = alt.text ? alt.id || "qrcode-description" : null;
    title = typeof title === "string" ? { text: title } : title || {};
    title.text = title.text || null;
    title.id = title.text ? title.id || "qrcode-title" : null;
    const size = _this.getModuleCount() * cellSize + margin * 2;
    let c, mc, r, mr, qrSvg = "", rect;
    rect = "l" + cellSize + ",0 0," + cellSize + " -" + cellSize + ",0 0,-" + cellSize + "z ";
    qrSvg += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
    qrSvg += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : "";
    qrSvg += ' viewBox="0 0 ' + size + " " + size + '" ';
    qrSvg += ' preserveAspectRatio="xMinYMin meet"';
    qrSvg += title.text || alt.text ? ' role="img" aria-labelledby="' + escapeXml([title.id, alt.id].join(" ").trim()) + '"' : "";
    qrSvg += ">";
    qrSvg += title.text ? '<title id="' + escapeXml(title.id) + '">' + escapeXml(title.text) + "</title>" : "";
    qrSvg += alt.text ? '<description id="' + escapeXml(alt.id) + '">' + escapeXml(alt.text) + "</description>" : "";
    qrSvg += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
    qrSvg += '<path d="';
    for (r = 0; r < _this.getModuleCount(); r += 1) {
      mr = r * cellSize + margin;
      for (c = 0; c < _this.getModuleCount(); c += 1) {
        if (_this.isDark(r, c)) {
          mc = c * cellSize + margin;
          qrSvg += "M" + mc + "," + mr + rect;
        }
      }
    }
    qrSvg += '" stroke="transparent" fill="black"/>';
    qrSvg += "</svg>";
    return qrSvg;
  };
  _this.createDataURL = function(cellSize, margin) {
    cellSize = cellSize || 2;
    margin = typeof margin == "undefined" ? cellSize * 4 : margin;
    const size = _this.getModuleCount() * cellSize + margin * 2;
    const min = margin;
    const max = size - margin;
    return createDataURL(size, size, function(x, y) {
      if (min <= x && x < max && min <= y && y < max) {
        const c = Math.floor((x - min) / cellSize);
        const r = Math.floor((y - min) / cellSize);
        return _this.isDark(r, c) ? 0 : 1;
      } else {
        return 1;
      }
    });
  };
  _this.createImgTag = function(cellSize, margin, alt) {
    cellSize = cellSize || 2;
    margin = typeof margin == "undefined" ? cellSize * 4 : margin;
    const size = _this.getModuleCount() * cellSize + margin * 2;
    let img = "";
    img += "<img";
    img += ' src="';
    img += _this.createDataURL(cellSize, margin);
    img += '"';
    img += ' width="';
    img += size;
    img += '"';
    img += ' height="';
    img += size;
    img += '"';
    if (alt) {
      img += ' alt="';
      img += escapeXml(alt);
      img += '"';
    }
    img += "/>";
    return img;
  };
  const escapeXml = function(s) {
    let escaped = "";
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charAt(i);
      switch (c) {
        case "<":
          escaped += "&lt;";
          break;
        case ">":
          escaped += "&gt;";
          break;
        case "&":
          escaped += "&amp;";
          break;
        case '"':
          escaped += "&quot;";
          break;
        default:
          escaped += c;
          break;
      }
    }
    return escaped;
  };
  const _createHalfASCII = function(margin) {
    const cellSize = 1;
    margin = typeof margin == "undefined" ? cellSize * 2 : margin;
    const size = _this.getModuleCount() * cellSize + margin * 2;
    const min = margin;
    const max = size - margin;
    let y, x, r1, r2, p;
    const blocks = {
      "\u2588\u2588": "\u2588",
      "\u2588 ": "\u2580",
      " \u2588": "\u2584",
      "  ": " "
    };
    const blocksLastLineNoMargin = {
      "\u2588\u2588": "\u2580",
      "\u2588 ": "\u2580",
      " \u2588": " ",
      "  ": " "
    };
    let ascii = "";
    for (y = 0; y < size; y += 2) {
      r1 = Math.floor((y - min) / cellSize);
      r2 = Math.floor((y + 1 - min) / cellSize);
      for (x = 0; x < size; x += 1) {
        p = "\u2588";
        if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
          p = " ";
        }
        if (min <= x && x < max && min <= y + 1 && y + 1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
          p += " ";
        } else {
          p += "\u2588";
        }
        ascii += margin < 1 && y + 1 >= max ? blocksLastLineNoMargin[p] : blocks[p];
      }
      ascii += "\n";
    }
    if (size % 2 && margin > 0) {
      return ascii.substring(0, ascii.length - size - 1) + Array(size + 1).join("\u2580");
    }
    return ascii.substring(0, ascii.length - 1);
  };
  _this.createASCII = function(cellSize, margin) {
    cellSize = cellSize || 1;
    if (cellSize < 2) {
      return _createHalfASCII(margin);
    }
    cellSize -= 1;
    margin = typeof margin == "undefined" ? cellSize * 2 : margin;
    const size = _this.getModuleCount() * cellSize + margin * 2;
    const min = margin;
    const max = size - margin;
    let y, x, r, p;
    const white = Array(cellSize + 1).join("\u2588\u2588");
    const black = Array(cellSize + 1).join("  ");
    let ascii = "";
    let line = "";
    for (y = 0; y < size; y += 1) {
      r = Math.floor((y - min) / cellSize);
      line = "";
      for (x = 0; x < size; x += 1) {
        p = 1;
        if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
          p = 0;
        }
        line += p ? white : black;
      }
      for (r = 0; r < cellSize; r += 1) {
        ascii += line + "\n";
      }
    }
    return ascii.substring(0, ascii.length - 1);
  };
  _this.renderTo2dContext = function(context, cellSize) {
    cellSize = cellSize || 2;
    const length = _this.getModuleCount();
    for (let row = 0; row < length; row++) {
      for (let col = 0; col < length; col++) {
        context.fillStyle = _this.isDark(row, col) ? "black" : "white";
        context.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
      }
    }
  };
  return _this;
};
qrcode.stringToBytes = function(s) {
  const bytes2 = [];
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    bytes2.push(c & 255);
  }
  return bytes2;
};
qrcode.createStringToBytes = function(unicodeData, numChars) {
  const unicodeMap = (function() {
    const bin = base64DecodeInputStream(unicodeData);
    const read = function() {
      const b = bin.read();
      if (b == -1) throw "eof";
      return b;
    };
    let count = 0;
    const unicodeMap2 = {};
    while (true) {
      const b0 = bin.read();
      if (b0 == -1) break;
      const b1 = read();
      const b2 = read();
      const b3 = read();
      const k = String.fromCharCode(b0 << 8 | b1);
      const v = b2 << 8 | b3;
      unicodeMap2[k] = v;
      count += 1;
    }
    if (count != numChars) {
      throw count + " != " + numChars;
    }
    return unicodeMap2;
  })();
  const unknownChar = "?".charCodeAt(0);
  return function(s) {
    const bytes2 = [];
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      if (c < 128) {
        bytes2.push(c);
      } else {
        const b = unicodeMap[s.charAt(i)];
        if (typeof b == "number") {
          if ((b & 255) == b) {
            bytes2.push(b);
          } else {
            bytes2.push(b >>> 8);
            bytes2.push(b & 255);
          }
        } else {
          bytes2.push(unknownChar);
        }
      }
    }
    return bytes2;
  };
};
var QRMode = {
  MODE_NUMBER: 1 << 0,
  MODE_ALPHA_NUM: 1 << 1,
  MODE_8BIT_BYTE: 1 << 2,
  MODE_KANJI: 1 << 3
};
var QRErrorCorrectionLevel = {
  L: 1,
  M: 0,
  Q: 3,
  H: 2
};
var QRMaskPattern = {
  PATTERN000: 0,
  PATTERN001: 1,
  PATTERN010: 2,
  PATTERN011: 3,
  PATTERN100: 4,
  PATTERN101: 5,
  PATTERN110: 6,
  PATTERN111: 7
};
var QRUtil = (function() {
  const PATTERN_POSITION_TABLE = [
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
    [6, 30, 54],
    [6, 32, 58],
    [6, 34, 62],
    [6, 26, 46, 66],
    [6, 26, 48, 70],
    [6, 26, 50, 74],
    [6, 30, 54, 78],
    [6, 30, 56, 82],
    [6, 30, 58, 86],
    [6, 34, 62, 90],
    [6, 28, 50, 72, 94],
    [6, 26, 50, 74, 98],
    [6, 30, 54, 78, 102],
    [6, 28, 54, 80, 106],
    [6, 32, 58, 84, 110],
    [6, 30, 58, 86, 114],
    [6, 34, 62, 90, 118],
    [6, 26, 50, 74, 98, 122],
    [6, 30, 54, 78, 102, 126],
    [6, 26, 52, 78, 104, 130],
    [6, 30, 56, 82, 108, 134],
    [6, 34, 60, 86, 112, 138],
    [6, 30, 58, 86, 114, 142],
    [6, 34, 62, 90, 118, 146],
    [6, 30, 54, 78, 102, 126, 150],
    [6, 24, 50, 76, 102, 128, 154],
    [6, 28, 54, 80, 106, 132, 158],
    [6, 32, 58, 84, 110, 136, 162],
    [6, 26, 54, 82, 110, 138, 166],
    [6, 30, 58, 86, 114, 142, 170]
  ];
  const G15 = 1 << 10 | 1 << 8 | 1 << 5 | 1 << 4 | 1 << 2 | 1 << 1 | 1 << 0;
  const G18 = 1 << 12 | 1 << 11 | 1 << 10 | 1 << 9 | 1 << 8 | 1 << 5 | 1 << 2 | 1 << 0;
  const G15_MASK = 1 << 14 | 1 << 12 | 1 << 10 | 1 << 4 | 1 << 1;
  const _this = {};
  const getBCHDigit = function(data) {
    let digit = 0;
    while (data != 0) {
      digit += 1;
      data >>>= 1;
    }
    return digit;
  };
  _this.getBCHTypeInfo = function(data) {
    let d = data << 10;
    while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
      d ^= G15 << getBCHDigit(d) - getBCHDigit(G15);
    }
    return (data << 10 | d) ^ G15_MASK;
  };
  _this.getBCHTypeNumber = function(data) {
    let d = data << 12;
    while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
      d ^= G18 << getBCHDigit(d) - getBCHDigit(G18);
    }
    return data << 12 | d;
  };
  _this.getPatternPosition = function(typeNumber) {
    return PATTERN_POSITION_TABLE[typeNumber - 1];
  };
  _this.getMaskFunction = function(maskPattern) {
    switch (maskPattern) {
      case QRMaskPattern.PATTERN000:
        return function(i, j) {
          return (i + j) % 2 == 0;
        };
      case QRMaskPattern.PATTERN001:
        return function(i, j) {
          return i % 2 == 0;
        };
      case QRMaskPattern.PATTERN010:
        return function(i, j) {
          return j % 3 == 0;
        };
      case QRMaskPattern.PATTERN011:
        return function(i, j) {
          return (i + j) % 3 == 0;
        };
      case QRMaskPattern.PATTERN100:
        return function(i, j) {
          return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 == 0;
        };
      case QRMaskPattern.PATTERN101:
        return function(i, j) {
          return i * j % 2 + i * j % 3 == 0;
        };
      case QRMaskPattern.PATTERN110:
        return function(i, j) {
          return (i * j % 2 + i * j % 3) % 2 == 0;
        };
      case QRMaskPattern.PATTERN111:
        return function(i, j) {
          return (i * j % 3 + (i + j) % 2) % 2 == 0;
        };
      default:
        throw "bad maskPattern:" + maskPattern;
    }
  };
  _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
    let a = qrPolynomial([1], 0);
    for (let i = 0; i < errorCorrectLength; i += 1) {
      a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0));
    }
    return a;
  };
  _this.getLengthInBits = function(mode, type) {
    if (1 <= type && type < 10) {
      switch (mode) {
        case QRMode.MODE_NUMBER:
          return 10;
        case QRMode.MODE_ALPHA_NUM:
          return 9;
        case QRMode.MODE_8BIT_BYTE:
          return 8;
        case QRMode.MODE_KANJI:
          return 8;
        default:
          throw "mode:" + mode;
      }
    } else if (type < 27) {
      switch (mode) {
        case QRMode.MODE_NUMBER:
          return 12;
        case QRMode.MODE_ALPHA_NUM:
          return 11;
        case QRMode.MODE_8BIT_BYTE:
          return 16;
        case QRMode.MODE_KANJI:
          return 10;
        default:
          throw "mode:" + mode;
      }
    } else if (type < 41) {
      switch (mode) {
        case QRMode.MODE_NUMBER:
          return 14;
        case QRMode.MODE_ALPHA_NUM:
          return 13;
        case QRMode.MODE_8BIT_BYTE:
          return 16;
        case QRMode.MODE_KANJI:
          return 12;
        default:
          throw "mode:" + mode;
      }
    } else {
      throw "type:" + type;
    }
  };
  _this.getLostPoint = function(qrcode22) {
    const moduleCount = qrcode22.getModuleCount();
    let lostPoint = 0;
    for (let row = 0; row < moduleCount; row += 1) {
      for (let col = 0; col < moduleCount; col += 1) {
        let sameCount = 0;
        const dark = qrcode22.isDark(row, col);
        for (let r = -1; r <= 1; r += 1) {
          if (row + r < 0 || moduleCount <= row + r) {
            continue;
          }
          for (let c = -1; c <= 1; c += 1) {
            if (col + c < 0 || moduleCount <= col + c) {
              continue;
            }
            if (r == 0 && c == 0) {
              continue;
            }
            if (dark == qrcode22.isDark(row + r, col + c)) {
              sameCount += 1;
            }
          }
        }
        if (sameCount > 5) {
          lostPoint += 3 + sameCount - 5;
        }
      }
    }
    ;
    for (let row = 0; row < moduleCount - 1; row += 1) {
      for (let col = 0; col < moduleCount - 1; col += 1) {
        let count = 0;
        if (qrcode22.isDark(row, col)) count += 1;
        if (qrcode22.isDark(row + 1, col)) count += 1;
        if (qrcode22.isDark(row, col + 1)) count += 1;
        if (qrcode22.isDark(row + 1, col + 1)) count += 1;
        if (count == 0 || count == 4) {
          lostPoint += 3;
        }
      }
    }
    for (let row = 0; row < moduleCount; row += 1) {
      for (let col = 0; col < moduleCount - 6; col += 1) {
        if (qrcode22.isDark(row, col) && !qrcode22.isDark(row, col + 1) && qrcode22.isDark(row, col + 2) && qrcode22.isDark(row, col + 3) && qrcode22.isDark(row, col + 4) && !qrcode22.isDark(row, col + 5) && qrcode22.isDark(row, col + 6)) {
          lostPoint += 40;
        }
      }
    }
    for (let col = 0; col < moduleCount; col += 1) {
      for (let row = 0; row < moduleCount - 6; row += 1) {
        if (qrcode22.isDark(row, col) && !qrcode22.isDark(row + 1, col) && qrcode22.isDark(row + 2, col) && qrcode22.isDark(row + 3, col) && qrcode22.isDark(row + 4, col) && !qrcode22.isDark(row + 5, col) && qrcode22.isDark(row + 6, col)) {
          lostPoint += 40;
        }
      }
    }
    let darkCount = 0;
    for (let col = 0; col < moduleCount; col += 1) {
      for (let row = 0; row < moduleCount; row += 1) {
        if (qrcode22.isDark(row, col)) {
          darkCount += 1;
        }
      }
    }
    const ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
    lostPoint += ratio * 10;
    return lostPoint;
  };
  return _this;
})();
var QRMath = (function() {
  const EXP_TABLE = new Array(256);
  const LOG_TABLE = new Array(256);
  for (let i = 0; i < 8; i += 1) {
    EXP_TABLE[i] = 1 << i;
  }
  for (let i = 8; i < 256; i += 1) {
    EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
  }
  for (let i = 0; i < 255; i += 1) {
    LOG_TABLE[EXP_TABLE[i]] = i;
  }
  const _this = {};
  _this.glog = function(n) {
    if (n < 1) {
      throw "glog(" + n + ")";
    }
    return LOG_TABLE[n];
  };
  _this.gexp = function(n) {
    while (n < 0) {
      n += 255;
    }
    while (n >= 256) {
      n -= 255;
    }
    return EXP_TABLE[n];
  };
  return _this;
})();
var qrPolynomial = function(num, shift) {
  if (typeof num.length == "undefined") {
    throw num.length + "/" + shift;
  }
  const _num = (function() {
    let offset = 0;
    while (offset < num.length && num[offset] == 0) {
      offset += 1;
    }
    const _num2 = new Array(num.length - offset + shift);
    for (let i = 0; i < num.length - offset; i += 1) {
      _num2[i] = num[i + offset];
    }
    return _num2;
  })();
  const _this = {};
  _this.getAt = function(index) {
    return _num[index];
  };
  _this.getLength = function() {
    return _num.length;
  };
  _this.multiply = function(e) {
    const num2 = new Array(_this.getLength() + e.getLength() - 1);
    for (let i = 0; i < _this.getLength(); i += 1) {
      for (let j = 0; j < e.getLength(); j += 1) {
        num2[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i)) + QRMath.glog(e.getAt(j)));
      }
    }
    return qrPolynomial(num2, 0);
  };
  _this.mod = function(e) {
    if (_this.getLength() - e.getLength() < 0) {
      return _this;
    }
    const ratio = QRMath.glog(_this.getAt(0)) - QRMath.glog(e.getAt(0));
    const num2 = new Array(_this.getLength());
    for (let i = 0; i < _this.getLength(); i += 1) {
      num2[i] = _this.getAt(i);
    }
    for (let i = 0; i < e.getLength(); i += 1) {
      num2[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i)) + ratio);
    }
    return qrPolynomial(num2, 0).mod(e);
  };
  return _this;
};
var QRRSBlock = (function() {
  const RS_BLOCK_TABLE = [
    // L
    // M
    // Q
    // H
    // 1
    [1, 26, 19],
    [1, 26, 16],
    [1, 26, 13],
    [1, 26, 9],
    // 2
    [1, 44, 34],
    [1, 44, 28],
    [1, 44, 22],
    [1, 44, 16],
    // 3
    [1, 70, 55],
    [1, 70, 44],
    [2, 35, 17],
    [2, 35, 13],
    // 4
    [1, 100, 80],
    [2, 50, 32],
    [2, 50, 24],
    [4, 25, 9],
    // 5
    [1, 134, 108],
    [2, 67, 43],
    [2, 33, 15, 2, 34, 16],
    [2, 33, 11, 2, 34, 12],
    // 6
    [2, 86, 68],
    [4, 43, 27],
    [4, 43, 19],
    [4, 43, 15],
    // 7
    [2, 98, 78],
    [4, 49, 31],
    [2, 32, 14, 4, 33, 15],
    [4, 39, 13, 1, 40, 14],
    // 8
    [2, 121, 97],
    [2, 60, 38, 2, 61, 39],
    [4, 40, 18, 2, 41, 19],
    [4, 40, 14, 2, 41, 15],
    // 9
    [2, 146, 116],
    [3, 58, 36, 2, 59, 37],
    [4, 36, 16, 4, 37, 17],
    [4, 36, 12, 4, 37, 13],
    // 10
    [2, 86, 68, 2, 87, 69],
    [4, 69, 43, 1, 70, 44],
    [6, 43, 19, 2, 44, 20],
    [6, 43, 15, 2, 44, 16],
    // 11
    [4, 101, 81],
    [1, 80, 50, 4, 81, 51],
    [4, 50, 22, 4, 51, 23],
    [3, 36, 12, 8, 37, 13],
    // 12
    [2, 116, 92, 2, 117, 93],
    [6, 58, 36, 2, 59, 37],
    [4, 46, 20, 6, 47, 21],
    [7, 42, 14, 4, 43, 15],
    // 13
    [4, 133, 107],
    [8, 59, 37, 1, 60, 38],
    [8, 44, 20, 4, 45, 21],
    [12, 33, 11, 4, 34, 12],
    // 14
    [3, 145, 115, 1, 146, 116],
    [4, 64, 40, 5, 65, 41],
    [11, 36, 16, 5, 37, 17],
    [11, 36, 12, 5, 37, 13],
    // 15
    [5, 109, 87, 1, 110, 88],
    [5, 65, 41, 5, 66, 42],
    [5, 54, 24, 7, 55, 25],
    [11, 36, 12, 7, 37, 13],
    // 16
    [5, 122, 98, 1, 123, 99],
    [7, 73, 45, 3, 74, 46],
    [15, 43, 19, 2, 44, 20],
    [3, 45, 15, 13, 46, 16],
    // 17
    [1, 135, 107, 5, 136, 108],
    [10, 74, 46, 1, 75, 47],
    [1, 50, 22, 15, 51, 23],
    [2, 42, 14, 17, 43, 15],
    // 18
    [5, 150, 120, 1, 151, 121],
    [9, 69, 43, 4, 70, 44],
    [17, 50, 22, 1, 51, 23],
    [2, 42, 14, 19, 43, 15],
    // 19
    [3, 141, 113, 4, 142, 114],
    [3, 70, 44, 11, 71, 45],
    [17, 47, 21, 4, 48, 22],
    [9, 39, 13, 16, 40, 14],
    // 20
    [3, 135, 107, 5, 136, 108],
    [3, 67, 41, 13, 68, 42],
    [15, 54, 24, 5, 55, 25],
    [15, 43, 15, 10, 44, 16],
    // 21
    [4, 144, 116, 4, 145, 117],
    [17, 68, 42],
    [17, 50, 22, 6, 51, 23],
    [19, 46, 16, 6, 47, 17],
    // 22
    [2, 139, 111, 7, 140, 112],
    [17, 74, 46],
    [7, 54, 24, 16, 55, 25],
    [34, 37, 13],
    // 23
    [4, 151, 121, 5, 152, 122],
    [4, 75, 47, 14, 76, 48],
    [11, 54, 24, 14, 55, 25],
    [16, 45, 15, 14, 46, 16],
    // 24
    [6, 147, 117, 4, 148, 118],
    [6, 73, 45, 14, 74, 46],
    [11, 54, 24, 16, 55, 25],
    [30, 46, 16, 2, 47, 17],
    // 25
    [8, 132, 106, 4, 133, 107],
    [8, 75, 47, 13, 76, 48],
    [7, 54, 24, 22, 55, 25],
    [22, 45, 15, 13, 46, 16],
    // 26
    [10, 142, 114, 2, 143, 115],
    [19, 74, 46, 4, 75, 47],
    [28, 50, 22, 6, 51, 23],
    [33, 46, 16, 4, 47, 17],
    // 27
    [8, 152, 122, 4, 153, 123],
    [22, 73, 45, 3, 74, 46],
    [8, 53, 23, 26, 54, 24],
    [12, 45, 15, 28, 46, 16],
    // 28
    [3, 147, 117, 10, 148, 118],
    [3, 73, 45, 23, 74, 46],
    [4, 54, 24, 31, 55, 25],
    [11, 45, 15, 31, 46, 16],
    // 29
    [7, 146, 116, 7, 147, 117],
    [21, 73, 45, 7, 74, 46],
    [1, 53, 23, 37, 54, 24],
    [19, 45, 15, 26, 46, 16],
    // 30
    [5, 145, 115, 10, 146, 116],
    [19, 75, 47, 10, 76, 48],
    [15, 54, 24, 25, 55, 25],
    [23, 45, 15, 25, 46, 16],
    // 31
    [13, 145, 115, 3, 146, 116],
    [2, 74, 46, 29, 75, 47],
    [42, 54, 24, 1, 55, 25],
    [23, 45, 15, 28, 46, 16],
    // 32
    [17, 145, 115],
    [10, 74, 46, 23, 75, 47],
    [10, 54, 24, 35, 55, 25],
    [19, 45, 15, 35, 46, 16],
    // 33
    [17, 145, 115, 1, 146, 116],
    [14, 74, 46, 21, 75, 47],
    [29, 54, 24, 19, 55, 25],
    [11, 45, 15, 46, 46, 16],
    // 34
    [13, 145, 115, 6, 146, 116],
    [14, 74, 46, 23, 75, 47],
    [44, 54, 24, 7, 55, 25],
    [59, 46, 16, 1, 47, 17],
    // 35
    [12, 151, 121, 7, 152, 122],
    [12, 75, 47, 26, 76, 48],
    [39, 54, 24, 14, 55, 25],
    [22, 45, 15, 41, 46, 16],
    // 36
    [6, 151, 121, 14, 152, 122],
    [6, 75, 47, 34, 76, 48],
    [46, 54, 24, 10, 55, 25],
    [2, 45, 15, 64, 46, 16],
    // 37
    [17, 152, 122, 4, 153, 123],
    [29, 74, 46, 14, 75, 47],
    [49, 54, 24, 10, 55, 25],
    [24, 45, 15, 46, 46, 16],
    // 38
    [4, 152, 122, 18, 153, 123],
    [13, 74, 46, 32, 75, 47],
    [48, 54, 24, 14, 55, 25],
    [42, 45, 15, 32, 46, 16],
    // 39
    [20, 147, 117, 4, 148, 118],
    [40, 75, 47, 7, 76, 48],
    [43, 54, 24, 22, 55, 25],
    [10, 45, 15, 67, 46, 16],
    // 40
    [19, 148, 118, 6, 149, 119],
    [18, 75, 47, 31, 76, 48],
    [34, 54, 24, 34, 55, 25],
    [20, 45, 15, 61, 46, 16]
  ];
  const qrRSBlock = function(totalCount, dataCount) {
    const _this2 = {};
    _this2.totalCount = totalCount;
    _this2.dataCount = dataCount;
    return _this2;
  };
  const _this = {};
  const getRsBlockTable = function(typeNumber, errorCorrectionLevel) {
    switch (errorCorrectionLevel) {
      case QRErrorCorrectionLevel.L:
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
      case QRErrorCorrectionLevel.M:
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
      case QRErrorCorrectionLevel.Q:
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
      case QRErrorCorrectionLevel.H:
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
      default:
        return void 0;
    }
  };
  _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {
    const rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);
    if (typeof rsBlock == "undefined") {
      throw "bad rs block @ typeNumber:" + typeNumber + "/errorCorrectionLevel:" + errorCorrectionLevel;
    }
    const length = rsBlock.length / 3;
    const list = [];
    for (let i = 0; i < length; i += 1) {
      const count = rsBlock[i * 3 + 0];
      const totalCount = rsBlock[i * 3 + 1];
      const dataCount = rsBlock[i * 3 + 2];
      for (let j = 0; j < count; j += 1) {
        list.push(qrRSBlock(totalCount, dataCount));
      }
    }
    return list;
  };
  return _this;
})();
var qrBitBuffer = function() {
  const _buffer = [];
  let _length = 0;
  const _this = {};
  _this.getBuffer = function() {
    return _buffer;
  };
  _this.getAt = function(index) {
    const bufIndex = Math.floor(index / 8);
    return (_buffer[bufIndex] >>> 7 - index % 8 & 1) == 1;
  };
  _this.put = function(num, length) {
    for (let i = 0; i < length; i += 1) {
      _this.putBit((num >>> length - i - 1 & 1) == 1);
    }
  };
  _this.getLengthInBits = function() {
    return _length;
  };
  _this.putBit = function(bit) {
    const bufIndex = Math.floor(_length / 8);
    if (_buffer.length <= bufIndex) {
      _buffer.push(0);
    }
    if (bit) {
      _buffer[bufIndex] |= 128 >>> _length % 8;
    }
    _length += 1;
  };
  return _this;
};
var qrNumber = function(data) {
  const _mode = QRMode.MODE_NUMBER;
  const _data = data;
  const _this = {};
  _this.getMode = function() {
    return _mode;
  };
  _this.getLength = function(buffer) {
    return _data.length;
  };
  _this.write = function(buffer) {
    const data2 = _data;
    let i = 0;
    while (i + 2 < data2.length) {
      buffer.put(strToNum(data2.substring(i, i + 3)), 10);
      i += 3;
    }
    if (i < data2.length) {
      if (data2.length - i == 1) {
        buffer.put(strToNum(data2.substring(i, i + 1)), 4);
      } else if (data2.length - i == 2) {
        buffer.put(strToNum(data2.substring(i, i + 2)), 7);
      }
    }
  };
  const strToNum = function(s) {
    let num = 0;
    for (let i = 0; i < s.length; i += 1) {
      num = num * 10 + chatToNum(s.charAt(i));
    }
    return num;
  };
  const chatToNum = function(c) {
    if ("0" <= c && c <= "9") {
      return c.charCodeAt(0) - "0".charCodeAt(0);
    }
    throw "illegal char :" + c;
  };
  return _this;
};
var qrAlphaNum = function(data) {
  const _mode = QRMode.MODE_ALPHA_NUM;
  const _data = data;
  const _this = {};
  _this.getMode = function() {
    return _mode;
  };
  _this.getLength = function(buffer) {
    return _data.length;
  };
  _this.write = function(buffer) {
    const s = _data;
    let i = 0;
    while (i + 1 < s.length) {
      buffer.put(
        getCode(s.charAt(i)) * 45 + getCode(s.charAt(i + 1)),
        11
      );
      i += 2;
    }
    if (i < s.length) {
      buffer.put(getCode(s.charAt(i)), 6);
    }
  };
  const getCode = function(c) {
    if ("0" <= c && c <= "9") {
      return c.charCodeAt(0) - "0".charCodeAt(0);
    } else if ("A" <= c && c <= "Z") {
      return c.charCodeAt(0) - "A".charCodeAt(0) + 10;
    } else {
      switch (c) {
        case " ":
          return 36;
        case "$":
          return 37;
        case "%":
          return 38;
        case "*":
          return 39;
        case "+":
          return 40;
        case "-":
          return 41;
        case ".":
          return 42;
        case "/":
          return 43;
        case ":":
          return 44;
        default:
          throw "illegal char :" + c;
      }
    }
  };
  return _this;
};
var qr8BitByte = function(data) {
  const _mode = QRMode.MODE_8BIT_BYTE;
  const _data = data;
  const _bytes = qrcode.stringToBytes(data);
  const _this = {};
  _this.getMode = function() {
    return _mode;
  };
  _this.getLength = function(buffer) {
    return _bytes.length;
  };
  _this.write = function(buffer) {
    for (let i = 0; i < _bytes.length; i += 1) {
      buffer.put(_bytes[i], 8);
    }
  };
  return _this;
};
var qrKanji = function(data) {
  const _mode = QRMode.MODE_KANJI;
  const _data = data;
  const stringToBytes2 = qrcode.stringToBytes;
  !(function(c, code) {
    const test = stringToBytes2(c);
    if (test.length != 2 || (test[0] << 8 | test[1]) != code) {
      throw "sjis not supported.";
    }
  })("\u53CB", 38726);
  const _bytes = stringToBytes2(data);
  const _this = {};
  _this.getMode = function() {
    return _mode;
  };
  _this.getLength = function(buffer) {
    return ~~(_bytes.length / 2);
  };
  _this.write = function(buffer) {
    const data2 = _bytes;
    let i = 0;
    while (i + 1 < data2.length) {
      let c = (255 & data2[i]) << 8 | 255 & data2[i + 1];
      if (33088 <= c && c <= 40956) {
        c -= 33088;
      } else if (57408 <= c && c <= 60351) {
        c -= 49472;
      } else {
        throw "illegal char at " + (i + 1) + "/" + c;
      }
      c = (c >>> 8 & 255) * 192 + (c & 255);
      buffer.put(c, 13);
      i += 2;
    }
    if (i < data2.length) {
      throw "illegal char at " + (i + 1);
    }
  };
  return _this;
};
var byteArrayOutputStream = function() {
  const _bytes = [];
  const _this = {};
  _this.writeByte = function(b) {
    _bytes.push(b & 255);
  };
  _this.writeShort = function(i) {
    _this.writeByte(i);
    _this.writeByte(i >>> 8);
  };
  _this.writeBytes = function(b, off, len) {
    off = off || 0;
    len = len || b.length;
    for (let i = 0; i < len; i += 1) {
      _this.writeByte(b[i + off]);
    }
  };
  _this.writeString = function(s) {
    for (let i = 0; i < s.length; i += 1) {
      _this.writeByte(s.charCodeAt(i));
    }
  };
  _this.toByteArray = function() {
    return _bytes;
  };
  _this.toString = function() {
    let s = "";
    s += "[";
    for (let i = 0; i < _bytes.length; i += 1) {
      if (i > 0) {
        s += ",";
      }
      s += _bytes[i];
    }
    s += "]";
    return s;
  };
  return _this;
};
var base64EncodeOutputStream = function() {
  let _buffer = 0;
  let _buflen = 0;
  let _length = 0;
  let _base64 = "";
  const _this = {};
  const writeEncoded = function(b) {
    _base64 += String.fromCharCode(encode2(b & 63));
  };
  const encode2 = function(n) {
    if (n < 0) {
      throw "n:" + n;
    } else if (n < 26) {
      return 65 + n;
    } else if (n < 52) {
      return 97 + (n - 26);
    } else if (n < 62) {
      return 48 + (n - 52);
    } else if (n == 62) {
      return 43;
    } else if (n == 63) {
      return 47;
    } else {
      throw "n:" + n;
    }
  };
  _this.writeByte = function(n) {
    _buffer = _buffer << 8 | n & 255;
    _buflen += 8;
    _length += 1;
    while (_buflen >= 6) {
      writeEncoded(_buffer >>> _buflen - 6);
      _buflen -= 6;
    }
  };
  _this.flush = function() {
    if (_buflen > 0) {
      writeEncoded(_buffer << 6 - _buflen);
      _buffer = 0;
      _buflen = 0;
    }
    if (_length % 3 != 0) {
      const padlen = 3 - _length % 3;
      for (let i = 0; i < padlen; i += 1) {
        _base64 += "=";
      }
    }
  };
  _this.toString = function() {
    return _base64;
  };
  return _this;
};
var base64DecodeInputStream = function(str4) {
  const _str = str4;
  let _pos = 0;
  let _buffer = 0;
  let _buflen = 0;
  const _this = {};
  _this.read = function() {
    while (_buflen < 8) {
      if (_pos >= _str.length) {
        if (_buflen == 0) {
          return -1;
        }
        throw "unexpected end of file./" + _buflen;
      }
      const c = _str.charAt(_pos);
      _pos += 1;
      if (c == "=") {
        _buflen = 0;
        return -1;
      } else if (c.match(/^\s$/)) {
        continue;
      }
      _buffer = _buffer << 6 | decode(c.charCodeAt(0));
      _buflen += 6;
    }
    const n = _buffer >>> _buflen - 8 & 255;
    _buflen -= 8;
    return n;
  };
  const decode = function(c) {
    if (65 <= c && c <= 90) {
      return c - 65;
    } else if (97 <= c && c <= 122) {
      return c - 97 + 26;
    } else if (48 <= c && c <= 57) {
      return c - 48 + 52;
    } else if (c == 43) {
      return 62;
    } else if (c == 47) {
      return 63;
    } else {
      throw "c:" + c;
    }
  };
  return _this;
};
var gifImage = function(width, height) {
  const _width = width;
  const _height = height;
  const _data = new Array(width * height);
  const _this = {};
  _this.setPixel = function(x, y, pixel) {
    _data[y * _width + x] = pixel;
  };
  _this.write = function(out) {
    out.writeString("GIF87a");
    out.writeShort(_width);
    out.writeShort(_height);
    out.writeByte(128);
    out.writeByte(0);
    out.writeByte(0);
    out.writeByte(0);
    out.writeByte(0);
    out.writeByte(0);
    out.writeByte(255);
    out.writeByte(255);
    out.writeByte(255);
    out.writeString(",");
    out.writeShort(0);
    out.writeShort(0);
    out.writeShort(_width);
    out.writeShort(_height);
    out.writeByte(0);
    const lzwMinCodeSize = 2;
    const raster = getLZWRaster(lzwMinCodeSize);
    out.writeByte(lzwMinCodeSize);
    let offset = 0;
    while (raster.length - offset > 255) {
      out.writeByte(255);
      out.writeBytes(raster, offset, 255);
      offset += 255;
    }
    out.writeByte(raster.length - offset);
    out.writeBytes(raster, offset, raster.length - offset);
    out.writeByte(0);
    out.writeString(";");
  };
  const bitOutputStream = function(out) {
    const _out = out;
    let _bitLength = 0;
    let _bitBuffer = 0;
    const _this2 = {};
    _this2.write = function(data, length) {
      if (data >>> length != 0) {
        throw "length over";
      }
      while (_bitLength + length >= 8) {
        _out.writeByte(255 & (data << _bitLength | _bitBuffer));
        length -= 8 - _bitLength;
        data >>>= 8 - _bitLength;
        _bitBuffer = 0;
        _bitLength = 0;
      }
      _bitBuffer = data << _bitLength | _bitBuffer;
      _bitLength = _bitLength + length;
    };
    _this2.flush = function() {
      if (_bitLength > 0) {
        _out.writeByte(_bitBuffer);
      }
    };
    return _this2;
  };
  const getLZWRaster = function(lzwMinCodeSize) {
    const clearCode = 1 << lzwMinCodeSize;
    const endCode = (1 << lzwMinCodeSize) + 1;
    let bitLength = lzwMinCodeSize + 1;
    const table = lzwTable();
    for (let i = 0; i < clearCode; i += 1) {
      table.add(String.fromCharCode(i));
    }
    table.add(String.fromCharCode(clearCode));
    table.add(String.fromCharCode(endCode));
    const byteOut = byteArrayOutputStream();
    const bitOut = bitOutputStream(byteOut);
    bitOut.write(clearCode, bitLength);
    let dataIndex = 0;
    let s = String.fromCharCode(_data[dataIndex]);
    dataIndex += 1;
    while (dataIndex < _data.length) {
      const c = String.fromCharCode(_data[dataIndex]);
      dataIndex += 1;
      if (table.contains(s + c)) {
        s = s + c;
      } else {
        bitOut.write(table.indexOf(s), bitLength);
        if (table.size() < 4095) {
          if (table.size() == 1 << bitLength) {
            bitLength += 1;
          }
          table.add(s + c);
        }
        s = c;
      }
    }
    bitOut.write(table.indexOf(s), bitLength);
    bitOut.write(endCode, bitLength);
    bitOut.flush();
    return byteOut.toByteArray();
  };
  const lzwTable = function() {
    const _map = {};
    let _size = 0;
    const _this2 = {};
    _this2.add = function(key) {
      if (_this2.contains(key)) {
        throw "dup key:" + key;
      }
      _map[key] = _size;
      _size += 1;
    };
    _this2.size = function() {
      return _size;
    };
    _this2.indexOf = function(key) {
      return _map[key];
    };
    _this2.contains = function(key) {
      return typeof _map[key] != "undefined";
    };
    return _this2;
  };
  return _this;
};
var createDataURL = function(width, height, getPixel) {
  const gif = gifImage(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      gif.setPixel(x, y, getPixel(x, y));
    }
  }
  const b = byteArrayOutputStream();
  gif.write(b);
  const base64 = base64EncodeOutputStream();
  const bytes2 = b.toByteArray();
  for (let i = 0; i < bytes2.length; i += 1) {
    base64.writeByte(bytes2[i]);
  }
  base64.flush();
  return "data:image/gif;base64," + base64;
};
var qrcode_default = qrcode;
var stringToBytes = qrcode.stringToBytes;

// src/core/setup.ts
var sha2564 = sha256;
var qrcode2 = qrcode_default;
var SETUP_K_LEN = 32;
var PAIR_TAG_LEN = 32;
var SETUP_TTL_MS = 15 * 6e4;
var SETUP_WAIT_MS = 12e4;
var MAX_SETUP_KEYS = 8;
var SETUP_STORE_KEY = (instanceId2) => `orbit.setup.keys.${instanceId2}`;
function hmacSha256(key, msg) {
  const B = 64;
  let k = key.length > B ? sha2564(key) : key;
  const pad = new Uint8Array(B);
  pad.set(k);
  k = pad;
  const ipad = new Uint8Array(B + msg.length);
  const opad = new Uint8Array(B + 32);
  for (let i = 0; i < B; i++) {
    ipad[i] = k[i] ^ 54;
    opad[i] = k[i] ^ 92;
  }
  ipad.set(msg, B);
  opad.set(sha2564(ipad), B);
  return sha2564(opad);
}
function pairTagInput(instanceId2, spki) {
  return encode(["orbit-pair", 1, instanceId2, spki]);
}
function pairTag(k, instanceId2, spki) {
  if (k.length !== SETUP_K_LEN) throw new Error(`K de ${k.length} bytes (se esperaban ${SETUP_K_LEN})`);
  return hmacSha256(k, pairTagInput(instanceId2, spki));
}
function verifyPairTag(k, instanceId2, spki, tag) {
  if (k.length !== SETUP_K_LEN || tag.length !== PAIR_TAG_LEN) return false;
  const want = pairTag(k, instanceId2, spki);
  let diff = 0;
  for (let i = 0; i < PAIR_TAG_LEN; i++) diff |= want[i] ^ tag[i];
  return diff === 0;
}
function readSetupKeys(raw) {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  const list = v !== null && typeof v === "object" && v.v === 1 ? v.keys : void 0;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    const o = e;
    if (typeof o.k !== "string" || typeof o.instance_id !== "string" || typeof o.expires_ms !== "number") continue;
    try {
      if (b64uDecode2(o.k).length !== SETUP_K_LEN) continue;
    } catch {
      continue;
    }
    out.push({ k: o.k, instance_id: o.instance_id, expires_ms: o.expires_ms });
  }
  return out;
}
function addSetupKey(keys, k, instanceId2, now) {
  const live = keys.filter((x) => x.expires_ms >= now);
  live.push({ k: b64uEncode2(k), instance_id: instanceId2, expires_ms: now + SETUP_TTL_MS });
  return { v: 1, keys: live.slice(-MAX_SETUP_KEYS) };
}
function liveSetupKeys(keys, instanceId2, now) {
  return keys.filter((x) => x.instance_id === instanceId2 && x.expires_ms >= now);
}
function setupLink(phoneUrl, instanceId2, token, k) {
  const e = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `orbit://setup?v=1&u=${e(phoneUrl)}&i=${e(instanceId2)}&t=${e(token)}&k=${b64uEncode2(k)}`;
}
function qrMatrix(text) {
  const q = qrcode2(0, "L");
  q.addData(text, "Byte");
  q.make();
  const n = q.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_2, c) => Boolean(q.isDark(r, c))));
}
function qrText(text) {
  const m = qrMatrix(text);
  const n = m.length;
  const Q = 2;
  const light = (x, y) => x < 0 || y < 0 || x >= n || y >= n || !m[y][x];
  const lines = [];
  for (let y = -Q; y < n + Q; y += 2) {
    let line = "";
    for (let x = -Q; x < n + Q; x++) {
      const top = light(x, y);
      const bottom = light(x, y + 1);
      line += top && bottom ? "\u2588" : top ? "\u2580" : bottom ? "\u2584" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
function parseClientConfig(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return void 0;
  }
  if (v === null || typeof v !== "object" || v.v !== 1) return void 0;
  const o = v;
  const s = (x) => typeof x === "string" ? x : void 0;
  return { raw: { url: s(o.url), token: s(o.token), instanceId: s(o.instance_id), ctx: s(o.ctx) }, phoneUrl: s(o.phone_url) };
}
function stateDirCandidates(env2) {
  const out = [];
  const clean2 = (s) => s === void 0 || s.trim() === "" ? void 0 : s.replace(/\/+$/, "");
  const explicit = clean2(env2.stateDir);
  if (explicit !== void 0) return [explicit];
  const home = clean2(env2.home);
  if (home !== void 0) out.push(`${home}/Library/Application Support/Orbit`);
  const xdg = clean2(env2.xdg);
  if (xdg !== void 0) out.push(`${xdg}/orbit`);
  if (home !== void 0) out.push(`${home}/.config/orbit`);
  return out;
}
function isLoopbackUrl(url) {
  const m = /^https?:\/\/(\[[^\]]*\]|[^/:]+)/i.exec(url.trim());
  if (m === null) return true;
  const h = m[1].toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\./.test(h) || h === "0.0.0.0";
}
function resolvePhoneUrl(envPhone, clientPhone, url) {
  for (const c of [envPhone, clientPhone]) {
    const v = (c ?? "").trim().replace(/\/+$/, "");
    if (/^https?:\/\/[^\s/]+$/.test(v) && !isLoopbackUrl(v)) return v;
  }
  return isLoopbackUrl(url) ? void 0 : url;
}
async function autoPair(cfg, io, ring) {
  const now = Number(await io.now());
  const keys = liveSetupKeys(await ring.list(), cfg.instanceId, now);
  if (keys.length === 0) return { armed: false, paired: [], rejected: 0 };
  const { offers } = await fetchOffers(cfg, io);
  const storeKey = PAIR_STORE_KEY(cfg.instanceId);
  const paired = [];
  let rejected = 0;
  const used = /* @__PURE__ */ new Set();
  for (const offer of offers) {
    if (offer.tag === void 0) continue;
    const match = keys.find((k) => !used.has(k.k) && verifyPairTag(b64uDecode2(k.k), cfg.instanceId, offer.spki, offer.tag));
    if (match === void 0) {
      rejected++;
      continue;
    }
    used.add(match.k);
    await ring.consume(match.k);
    const current = readStoredKeys(await io.load(storeKey));
    const hex2 = hexOf(offer.kid);
    const entry = { kid: hex2, spki: b64uEncode2(offer.spki), label: offer.label, paired_at: now };
    if (!current.stored.some((k) => k.kid === hex2)) {
      if (current.stored.length >= MAX_PAIRED_KEYS) {
        rejected++;
        continue;
      }
      await io.save(storeKey, { v: 1, keys: [...current.stored, entry] });
    }
    await deleteOffer(cfg, io, offer.kid);
    paired.push(entry);
  }
  return { armed: true, paired, rejected };
}
function describePaired(k) {
  const f = fingerprint(Uint8Array.from(k.kid.match(/../g).map((h) => parseInt(h, 16))));
  return `${k.label || "reloj"} (huella ${f.hex})`;
}

// src/core/engine.ts
var SERVER_INSTALL_HINT = "falta el servidor de Orbit en este Mac: inst\xE1lalo con tools/install/install-mac.sh del repo Orbit y abre una sesi\xF3n nueva";
var PRIVACY_KEY = "orbit.privacy";
var AWAY_KEY = "orbit.away";
var AWAY_FILE = "away.json";
var PAIR_KEYS_PREFIX = PAIR_STORE_KEY("");
var SETUP_HELP = "/orbit setup [--link]: QR para el tel\xE9fono (Orbit > Escanear QR). --link imprime tambi\xE9n el enlace orbit://setup.";
var COMMAND_DESCRIPTION = "Orbit: estado, /orbit setup (QR para el tel\xE9fono), /orbit away, /orbit back, /orbit respuestas, /orbit pause, /orbit resume, /orbit pair, /orbit unpair";
var OrbitEngine = class {
  runtime;
  timer;
  holder;
  watchKeys = [];
  /** Turno en curso de la sesión principal (para "Detente" desde el reloj, §6.6). */
  currentTurnId;
  sayLoopRunning = false;
  sessionEnded = false;
  /** "Detente y resume" (§6.6, `recap`): el prompt que sale cuando el turno cortado termine. */
  pendingRecap;
  saySeen = /* @__PURE__ */ new Set();
  /** Mensajes del reloj que llegaron a mitad de turno (van como contexto del siguiente resultado de tool). */
  notes = new WatchNotes();
  setupWatch;
  // ---------- ciclo de la sesión ----------
  async sessionStart(p, e, control2, extra = {}) {
    await this.safely(p, "session.start", async () => {
      const rt = await this.getRuntime(p);
      void this.checkAutoPair(p, "session.start");
      this.sessionEnded = false;
      void this.sayLoop(p, control2);
      const evs = rt.translator.sessionStart(await p.sessionId(), e);
      Object.assign(evs[0], extra, await this.repliesField(p));
      await this.emit(p, evs, false);
    });
  }
  async turnStart(p, e) {
    await this.safely(p, "turn.start", async () => {
      const rt = await this.getRuntime(p);
      if (e.agentId === void 0 && typeof e.turnId === "string") this.currentTurnId = e.turnId;
      await this.emit(p, rt.translator.turnStart(await p.sessionId(), e), false);
    });
  }
  async agentSpawn(p, e) {
    await this.safely(p, "agent.spawn", async () => {
      (await this.getRuntime(p)).translator.agentSpawn(e);
    });
  }
  /** Antes de ejecutar un tool. Si el tool se ejecuta, el terminal ya respondió su permiso (U1). */
  async toolCall(p, e, lookup) {
    await this.safely(p, "tool.call.terminal", () => this.terminalAnswered(e.tool_use_id));
    await this.safely(p, "tool.call", async () => {
      const rt = await this.getRuntime(p);
      const id = typeof e.agentId === "string" ? e.agentId : void 0;
      const hint = lookup !== void 0 && rt.translator.needsAgentLookup(id) ? await lookup(id) : void 0;
      await this.emit(p, rt.translator.toolCall(await p.sessionId(), e, hint), false);
    });
  }
  /**
   * Después de ejecutar un tool. Devuelve el resultado que debe ver el modelo: con un mensaje del reloj
   * llegado a mitad de turno como contexto (solo la sesión principal).
   */
  async toolResult(p, e, result, cwd) {
    await this.safely(p, "tool.call.result", async () => {
      const rt = await this.getRuntime(p);
      const evs = rt.translator.toolResult(await p.sessionId(), e, result);
      const post = evs[evs.length - 1];
      const links = linksOf(String(e.tool), toolInputOf(e), result?.text, post?.is_error === true, cwd);
      if (post !== void 0 && links.length > 0) post.orbit_links = links;
      await this.emit(p, evs, false);
    });
    const note = e.agentId === void 0 ? this.notes.takeContext() : void 0;
    return note === void 0 ? result : withContext(result, note);
  }
  /**
   * K2: un `ask` se retiene hasta que gane el reloj, el terminal, el plazo o un abort (SPEC §6.1).
   * `holds` = false (p. ej. auto mode) deja pasar el veredicto sin avisar al reloj.
   */
  async toolCheck(p, e, verdict, signal, holds = true) {
    if (verdict?.decision === "ask" && !holds) return verdict;
    await this.safely(p, "tool.check", async () => {
      const rt = await this.getRuntime(p);
      await this.emit(p, rt.translator.toolCheck(await p.sessionId(), e, verdict), true);
    });
    if (verdict?.decision !== "ask") return verdict;
    return this.holdPermission(p, e, verdict, signal);
  }
  async turnComplete(p, e, control2, extra) {
    if (e.agentId === void 0) {
      this.currentTurnId = void 0;
      await this.submitRecap(p, control2);
      const left = this.notes.takePrompt();
      if (left !== void 0) void control2.submitPrompt(left).catch(() => void 0);
    }
    await this.safely(p, "turn.complete", async () => {
      const rt = await this.getRuntime(p);
      const evs = rt.translator.turnComplete(await p.sessionId(), e);
      const stop = evs[evs.length - 1];
      if (e.agentId === void 0 && stop !== void 0) Object.assign(stop, await extra(), await this.repliesField(p));
      await this.emit(p, evs, e.agentId === void 0);
    });
  }
  async sessionEnd(p, e) {
    this.sessionEnded = true;
    await this.safely(p, "session.end", async () => {
      const rt = await this.getRuntime(p);
      const sid = typeof e.sessionId === "string" ? e.sessionId : await p.sessionId();
      await this.emit(p, rt.translator.sessionEnd(sid, e), true);
    });
  }
  /** `/orbit …`. Nunca lanza. */
  async command(p, args) {
    try {
      return await this.runOrbitCommand(p, args);
    } catch (err) {
      return `orbit: error (${String(err)})`;
    }
  }
  // ---------- configuración y envío ----------
  async safely(p, label2, work) {
    try {
      await work();
    } catch (err) {
      p.log(`orbit: ${label2} fall\xF3 (${String(err)})`);
    }
  }
  io(p) {
    return {
      now: () => p.now(),
      post: (url, init) => p.fetch(url, init),
      load: (key) => p.store.get(key),
      save: (key, value) => value === null ? p.store.delete(key) : p.store.set(key, value),
      log: (message) => p.log(message)
    };
  }
  /** Lee un fichero del directorio de estado del servidor (el primero que exista). */
  async readStateFile(p, name) {
    const env2 = await p.env();
    for (const d of stateDirCandidates({ stateDir: env2.ORBIT_STATE_DIR, home: env2.HOME, xdg: env2.XDG_CONFIG_HOME })) {
      const path = `${d}/${name}`;
      try {
        return { path, text: String(await p.read(path)) };
      } catch {
      }
    }
    return void 0;
  }
  /** Directorio de estado de Orbit que existe (el que tiene client.json); undefined si no hay ninguno. */
  async stateDir(p) {
    const f = await this.readStateFile(p, "client.json");
    return f === void 0 ? void 0 : f.path.slice(0, f.path.length - "/client.json".length);
  }
  async loadRuntime(p) {
    const all = await p.env();
    const env2 = { url: all.ORBIT_URL, token: all.ORBIT_TOKEN, instanceId: all.ORBIT_INSTANCE_ID, ctx: all.ORBIT_CTX };
    let raw = env2;
    let source = "variables ORBIT_*";
    let phoneUrl;
    const fromEnv = !Object.values(env2).every((v) => v === void 0 || v.trim() === "");
    if (!fromEnv) {
      const f = await this.readStateFile(p, "client.json");
      const c = f === void 0 ? void 0 : parseClientConfig(f.text);
      if (f !== void 0 && c !== void 0) {
        raw = c.raw;
        phoneUrl = c.phoneUrl;
        source = f.path;
      } else {
        const error = f === void 0 ? SERVER_INSTALL_HINT : `${f.path}: no es una configuraci\xF3n de Orbit v\xE1lida (reinicia orbit-server para que la reescriba)`;
        return { config: void 0, errors: [error], source, phoneUrl, collector: void 0, translator: new Translator() };
      }
    }
    const parsed = parseConfig(raw);
    const translator = new Translator();
    if (!parsed.ok) {
      const errors = fromEnv ? parsed.errors : parsed.errors.map((e) => `${source}: ${e}`);
      return { config: void 0, errors, source, phoneUrl, collector: void 0, translator };
    }
    if (await p.store.get(PRIVACY_KEY) === "metadatos") parsed.config.privacy = "metadatos";
    const collector = new Collector(parsed.config, this.io(p));
    await collector.init();
    return { config: parsed.config, errors: [], source, phoneUrl, collector, translator };
  }
  getRuntime(p) {
    if (this.runtime === void 0) {
      this.runtime = this.loadRuntime(p).catch((err) => {
        this.runtime = void 0;
        throw err;
      });
    }
    return this.runtime;
  }
  /** Programa (o reprograma) el próximo envío según lo que diga el colector. */
  async schedule(p, rt) {
    const collector = rt.collector;
    if (collector === void 0) return;
    const wait = collector.delay(await p.now());
    this.timer?.cancel();
    this.timer = void 0;
    if (wait === null) return;
    this.timer = p.after(wait, () => {
      this.timer = void 0;
      void this.flushAndReschedule(p, rt);
    });
  }
  async flushAndReschedule(p, rt) {
    const collector = rt.collector;
    if (collector === void 0) return;
    collector.io = this.io(p);
    try {
      await collector.flush();
      await this.schedule(p, rt);
    } catch (err) {
      p.log(`orbit: fallo al enviar (${String(err)})`);
    }
  }
  /** Traduce, encola y programa el envío. `urgent` envía ya (Stop, SessionEnd, PermissionRequest). */
  async emit(p, payloads, urgent) {
    if (payloads.length === 0) return;
    const rt = await this.getRuntime(p);
    const collector = rt.collector;
    if (collector === void 0) return;
    collector.io = this.io(p);
    collector.ingest(payloads, await p.now());
    if (urgent) await this.flushAndReschedule(p, rt);
    else await this.schedule(p, rt);
  }
  // ---------- llaves del reloj ----------
  /**
   * Llaves emparejadas: en `paired-keys.json` del directorio de estado, compartido por todos los perfiles.
   * Lo que un perfil tuviera aún en su almacén se migra al fichero la primera vez. Sin directorio de
   * estado (configuración por variables) siguen en el almacén.
   */
  async loadKeys(p, key) {
    const dir = await this.stateDir(p);
    if (dir === void 0) return p.store.get(key);
    const inst = key.slice(PAIR_KEYS_PREFIX.length);
    const f = await this.readStateFile(p, SHARED_KEYS_FILE);
    const shared = readSharedKeys(f?.text);
    const local = readStoredKeys(await p.store.get(key)).stored;
    let keys = shared.instances[inst] ?? [];
    if (local.length > 0) {
      keys = mergeStoredKeys(keys, local);
      await p.write(`${dir}/${SHARED_KEYS_FILE}`, writeSharedKeys(shared, inst, { v: 1, keys }));
      await p.store.delete(key);
    }
    return keys.length === 0 ? void 0 : { v: 1, keys };
  }
  async saveKeys(p, key, value) {
    const dir = await this.stateDir(p);
    if (dir === void 0) {
      await (value === null ? p.store.delete(key) : p.store.set(key, value));
      return;
    }
    const f = await this.readStateFile(p, SHARED_KEYS_FILE);
    await p.write(`${dir}/${SHARED_KEYS_FILE}`, writeSharedKeys(readSharedKeys(f?.text), key.slice(PAIR_KEYS_PREFIX.length), value));
    await p.store.delete(key);
  }
  pairingIo(p) {
    return {
      now: () => p.now(),
      fetch: (url, init) => p.fetch(url, init),
      load: (key) => key.startsWith(PAIR_KEYS_PREFIX) ? this.loadKeys(p, key) : p.store.get(key),
      save: (key, value) => key.startsWith(PAIR_KEYS_PREFIX) ? this.saveKeys(p, key, value) : value === null ? p.store.delete(key) : p.store.set(key, value)
    };
  }
  /**
   * Llaves del reloj emparejadas, leídas en cada permiso (un `unpair` cuenta desde la siguiente dec) y,
   * además, las de ORBIT_WATCH_KEYS (atajo para pruebas y despliegues sin interacción).
   */
  async loadWatchKeys(p, instanceId2) {
    const { keys, dropped } = dropTestKeys(await loadPairedKeys(instanceId2, { load: (key) => this.loadKeys(p, key) }));
    if (dropped > 0) p.log(`orbit: ${dropped} llave(s) de prueba ignoradas (su clave privada es p\xFAblica)`);
    const parsed = parseWatchKeys((await p.env()).ORBIT_WATCH_KEYS);
    if (!parsed.ok) {
      p.log(`orbit: ORBIT_WATCH_KEYS ignorada (${parsed.error})`);
      return keys;
    }
    for (const k of parsed.keys) if (!keys.some((o) => hexOf(o.kid) === hexOf(k.kid))) keys.push(k);
    return keys;
  }
  // ---------- emparejamiento automático por QR (SPEC §6.3.1) ----------
  /** K del almacén (los de /orbit setup) y de setup.json del directorio de estado (los de orbit-server setup). */
  keyring(p, instanceId2) {
    const storeKey = SETUP_STORE_KEY(instanceId2);
    return {
      list: async () => {
        const fromStore = readSetupKeys(await p.store.get(storeKey));
        const f = await this.readStateFile(p, "setup.json");
        return f === void 0 ? fromStore : [...fromStore, ...readSetupKeys(f.text)];
      },
      consume: async (k) => {
        const mine = readSetupKeys(await p.store.get(storeKey));
        if (mine.some((x) => x.k === k)) {
          const rest = mine.filter((x) => x.k !== k);
          if (rest.length === 0) await p.store.delete(storeKey);
          else await p.store.set(storeKey, { v: 1, keys: rest });
        }
        const f = await this.readStateFile(p, "setup.json");
        if (f !== void 0) {
          const all = readSetupKeys(f.text);
          if (all.some((x) => x.k === k)) await p.write(f.path, JSON.stringify({ v: 1, keys: all.filter((x) => x.k !== k) }, null, 2) + "\n");
        }
      }
    };
  }
  /** Busca ofertas del teléfono firmadas con un K vigente y las empareja. Nunca lanza. */
  async checkAutoPair(p, why) {
    try {
      const rt = await this.getRuntime(p);
      if (rt.config === void 0) return [];
      const cfg = { url: rt.config.url, token: rt.config.token, instanceId: rt.config.instanceId };
      const r = await autoPair(cfg, this.pairingIo(p), this.keyring(p, cfg.instanceId));
      if (r.rejected > 0) p.log(`orbit: ${r.rejected} oferta(s) con etiqueta que no verifica (${why}): se quedan para /orbit pair`);
      for (const k of r.paired) {
        p.log(`orbit: emparejada por QR (${why}): ${describePaired(k)}`);
        p.toast(`Orbit: reloj emparejado: ${describePaired(k)}`);
      }
      return r.paired;
    } catch (err) {
      p.log(`orbit: emparejamiento autom\xE1tico fall\xF3 (${String(err)})`);
      return [];
    }
  }
  /** Tras /orbit setup: mira cada 2 s durante 2 min si ya llegó la oferta del teléfono. */
  watchSetup(p, until) {
    this.setupWatch?.cancel();
    const tick = async () => {
      const now = Number(await p.now());
      const paired = await this.checkAutoPair(p, "/orbit setup");
      if (paired.length > 0 || now >= until) {
        this.setupWatch = void 0;
        p.status(void 0);
        if (paired.length === 0) p.toast("Orbit: no lleg\xF3 la oferta del tel\xE9fono en 2 min. El QR sigue valiendo 15 min: se emparejar\xE1 en la siguiente sesi\xF3n o con /orbit.");
        return;
      }
      p.status(`Orbit: escanea el QR con el tel\xE9fono\u2026 (${Math.ceil((until - now) / 1e3)} s)`);
      this.setupWatch = p.after(2e3, () => void tick());
    };
    void tick();
  }
  async runSetupCommand(p, args) {
    const rt = await this.getRuntime(p);
    if (rt.config === void 0) return ["orbit sin configurar: no puedo generar el QR", ...rt.errors.map((e) => `  - ${e}`)].join("\n");
    const cfg = rt.config;
    let clientPhone = rt.phoneUrl;
    if (clientPhone === void 0) {
      const f = await this.readStateFile(p, "client.json");
      const c = f === void 0 ? void 0 : parseClientConfig(f.text);
      if (c !== void 0 && c.raw.instanceId === cfg.instanceId) clientPhone = c.phoneUrl;
    }
    const phone = resolvePhoneUrl((await p.env()).ORBIT_PHONE_URL, clientPhone, cfg.url);
    if (phone === void 0) {
      return `no s\xE9 qu\xE9 direcci\xF3n usar\xE1 el tel\xE9fono (${cfg.url} es de este Mac). Define ORBIT_PHONE_URL=http://<IP de Tailscale o de la Wi-Fi>:7878 o arranca orbit-server sin ORBIT_CONFIG (calcula la IP solo).`;
    }
    const now = Number(await p.now());
    const k = await randomBytes3(p, 32);
    const storeKey = SETUP_STORE_KEY(cfg.instanceId);
    await p.store.set(storeKey, addSetupKey(readSetupKeys(await p.store.get(storeKey)), k, cfg.instanceId, now));
    const link = setupLink(phone, cfg.instanceId, cfg.token, k);
    this.watchSetup(p, now + SETUP_WAIT_MS);
    const lines = [
      "QR para configurar el tel\xE9fono:",
      qrText(link),
      "",
      "Escanea el QR con el tel\xE9fono\u2026 (Orbit > Escanear QR)",
      `  servidor ${phone}, instancia ${cfg.instanceId}. V\xE1lido 15 min y una sola vez.`,
      "  El tel\xE9fono se configura solo, pide la llave al reloj y el reloj queda emparejado sin comparar huellas.",
      "  Espero la oferta 2 min (barra de estado); despu\xE9s se empareja en la siguiente sesi\xF3n, en cada permiso o con /orbit.",
      "  El QR lleva el token de la instancia: no lo compartas."
    ];
    if (/(^|\s)--link(\s|$)/.test(args)) lines.push("", link);
    return lines.join("\n");
  }
  async pairingSummary(p, instanceId2) {
    const keys = await loadPairedKeys(instanceId2, { load: (key) => this.loadKeys(p, key) });
    const now = Number(await p.now());
    const live = liveSetupKeys(readSetupKeys(await p.store.get(SETUP_STORE_KEY(instanceId2))), instanceId2, now);
    const lines = [
      keys.length === 0 ? "  reloj: sin emparejar (/orbit setup y escanear el QR con el tel\xE9fono)" : `  reloj: ${keys.length} llave(s) emparejada(s): ${keys.map((k) => hexOf(k.kid).match(/.{4}/g).join(" ")).join(", ")} (/orbit pair keys)`
    ];
    if (live.length > 0) lines.push(`  QR de emparejamiento vigente (${live.length}): esperando la oferta del tel\xE9fono`);
    return lines.join("\n");
  }
  // ---------- /orbit ----------
  async runOrbitCommand(p, args) {
    const replies = parseRepliesCommand(args);
    if (replies !== void 0) {
      const r = applyRepliesCommand(await this.loadReplies(p), replies);
      if (r.changed) await this.saveReplies(p, r.list);
      return r.changed ? `${r.message}
  el reloj las ver\xE1 al acabar el siguiente turno de cada sesi\xF3n` : r.message;
    }
    if (/^\s*setup(\s|$)/i.test(args)) {
      if (/(^|\s)(-h|--help|help)(\s|$)/.test(args)) return SETUP_HELP;
      return this.runSetupCommand(p, args);
    }
    const pair = parsePairCommand(args);
    if (pair !== void 0) {
      const rt2 = await this.getRuntime(p);
      const instanceId2 = rt2.config?.instanceId ?? (await p.env()).ORBIT_INSTANCE_ID;
      const cfg = rt2.config === void 0 ? void 0 : { url: rt2.config.url, token: rt2.config.token, instanceId: rt2.config.instanceId };
      return runPairCommand(cfg, this.pairingIo(p), pair, typeof instanceId2 === "string" && instanceId2.trim() !== "" ? instanceId2.trim() : void 0);
    }
    const action = parseOrbitArgs(args);
    if (action === "invalid") return ORBIT_USAGE;
    const rt = await this.getRuntime(p);
    const collector = rt.collector;
    if (collector !== void 0) {
      collector.io = this.io(p);
      if (action === "pause") await collector.setPaused(true);
      if (action === "resume") {
        await collector.setPaused(false);
        await this.schedule(p, rt);
      }
    }
    if ((action === "privacy-full" || action === "privacy-metadata") && rt.config !== void 0) {
      const priv = action === "privacy-metadata" ? "metadatos" : "completa";
      await p.store.set(PRIVACY_KEY, priv);
      rt.config.privacy = priv;
    }
    if (action === "away") await this.setAway(p, true);
    if (action === "back") await this.setAway(p, false);
    let text = formatStatus(rt.config, rt.errors, collector?.status(), await p.now());
    text += await this.isAway(p) ? "\n  modo lejos: el reloj tiene 90 s para decidir antes de que salga el di\xE1logo del terminal (/orbit back para volver)" : "\n  modo cerca: el reloj tiene 20 s para decidir; luego decide el terminal (/orbit away si te vas del Mac)";
    if (rt.config !== void 0) {
      const paired = await this.checkAutoPair(p, "/orbit");
      text += `
  configuraci\xF3n: ${rt.source}`;
      text += `
${await this.pairingSummary(p, rt.config.instanceId)}`;
      if (paired.length > 0) text += `
  emparejado ahora por QR: ${paired.map(describePaired).join(", ")}`;
    }
    if (collector === void 0) return text;
    const prefix = {
      pause: "env\xEDo en pausa",
      resume: "env\xEDo reanudado",
      "privacy-full": "privacidad completa en este perfil: se env\xEDa todo (prompts, comandos y rutas)",
      "privacy-metadata": "privacidad de metadatos en este perfil: solo estructura, tiempos y verbos; el reloj solo podr\xE1 aprobar viendo el verbo",
      away: "lejos del Mac: el reloj espera hasta 90 s",
      back: "de vuelta: el reloj espera 20 s"
    };
    return prefix[action] === void 0 ? text : `${prefix[action]}
${text}`;
  }
  // ---------- permisos desde el reloj (K2, SPEC §6) ----------
  // Env: ORBIT_PERM (on|off), ORBIT_PERM_HOLD_MS (1000..90000), ORBIT_FORBIDDEN / ORBIT_FORBIDDEN_ADD
  // (arrays JSON de regex, §6.4), ORBIT_WATCH_KEYS. Toda la lógica está en perm/hold.ts.
  permIo(p) {
    return {
      now: () => p.now(),
      fetch: (url, init) => p.fetch(url, init),
      after: (ms, cb) => p.after(ms, cb),
      random: (n) => randomBytes3(p, n),
      log: (message) => p.log(message)
    };
  }
  async loadHolder(p, config) {
    const env2 = await p.env();
    const parsed = parsePermConfig({ enabled: env2.ORBIT_PERM, holdMs: env2.ORBIT_PERM_HOLD_MS, forbidden: env2.ORBIT_FORBIDDEN, forbiddenAdd: env2.ORBIT_FORBIDDEN_ADD });
    if (!parsed.ok) {
      p.log(`orbit: retenci\xF3n de permisos desactivada (${parsed.errors.join("; ")})`);
      return void 0;
    }
    return new PermHolder({ config, perm: parsed.perm, io: this.permIo(p), verify: k1Verifier(() => this.watchKeys) });
  }
  getHolder(p, config) {
    if (this.holder === void 0) {
      this.holder = this.loadHolder(p, config).catch(() => {
        this.holder = void 0;
        return void 0;
      });
    }
    return this.holder;
  }
  /** §6.1 a partir de `v`. Cualquier fallo devuelve `v`: Orbit nunca bloquea la sesión. */
  async holdPermission(p, e, v, signal) {
    try {
      const rt = await this.getRuntime(p);
      if (rt.config === void 0) return v;
      const h = await this.getHolder(p, rt.config);
      if (h === void 0) return v;
      await this.checkAutoPair(p, "tool.check");
      this.watchKeys = await this.loadWatchKeys(p, rt.config.instanceId);
      if (this.watchKeys.length === 0) return v;
      const holdMs = await this.isAway(p) ? PERM_HOLD_MS_AWAY : void 0;
      return await h.hold(e, v, { sessionId: await p.sessionId(), signal, io: this.permIo(p), holdMs });
    } catch (err) {
      p.log(`orbit: retenci\xF3n fall\xF3 (${String(err)})`);
      return v;
    }
  }
  /** U1: si el tool llega a ejecutarse mientras se retiene su permiso, el terminal ya respondió (allow). */
  async terminalAnswered(toolUseId2) {
    if (typeof toolUseId2 !== "string" || this.holder === void 0) return;
    (await this.holder)?.terminal(toolUseId2, "allow");
  }
  // ---------- modo lejos y respuestas rápidas (SPEC §6.6.1) ----------
  async isAway(p) {
    try {
      const f = await this.readStateFile(p, AWAY_FILE);
      if (f !== void 0) return JSON.parse(f.text).away === true;
      return await p.store.get(AWAY_KEY) === true;
    } catch {
      return false;
    }
  }
  async setAway(p, away) {
    const dir = await this.stateDir(p);
    if (dir === void 0) {
      await p.store.set(AWAY_KEY, away);
      return;
    }
    await p.write(`${dir}/${AWAY_FILE}`, JSON.stringify({ away }) + "\n");
    await p.store.delete(AWAY_KEY);
  }
  /** Lista configurada con `/orbit respuestas`; undefined = sin configurar (el reloj usa las suyas). */
  async loadReplies(p) {
    try {
      const f = await this.readStateFile(p, REPLIES_FILE);
      if (f !== void 0) return readReplies(f.text);
      return readReplies(await p.store.get(REPLIES_KEY));
    } catch {
      return void 0;
    }
  }
  async saveReplies(p, list) {
    const value = writeReplies(list);
    const dir = await this.stateDir(p);
    if (dir === void 0) {
      await p.store.set(REPLIES_KEY, value);
      return;
    }
    await p.write(`${dir}/${REPLIES_FILE}`, JSON.stringify(value, null, 2) + "\n");
    await p.store.delete(REPLIES_KEY);
  }
  /** Campo `orbit_replies` para SessionStart y el Stop principal (la lista blanca lo quita en work, §3.4). */
  async repliesField(p) {
    const list = await this.loadReplies(p);
    return list === void 0 ? {} : { orbit_replies: list };
  }
  // ---------- respuestas desde el reloj (SPEC §6.6) ----------
  /**
   * Long-poll de `GET /v0/say` mientras dure la sesión y haya un reloj emparejado. Cada `say` se verifica
   * (llave emparejada, instancia, sid de esta sesión, ventana de 120 s, nonce de un solo uso): `text` entra
   * como prompt propio en cuanto la sesión queda libre; `stop` corta el turno en curso. Nunca lanza.
   */
  async sayLoop(p, control2) {
    if (this.sayLoopRunning) return;
    this.sayLoopRunning = true;
    const sleep = (ms) => new Promise((resolve) => p.after(ms, () => resolve()));
    try {
      while (!this.sessionEnded) {
        const rt = await this.getRuntime(p);
        if (rt.config === void 0) return;
        const keys = await this.loadWatchKeys(p, rt.config.instanceId);
        if (keys.length === 0) {
          await sleep(3e4);
          continue;
        }
        const sess = await p.sessionId();
        let r;
        try {
          r = await p.fetch(`${rt.config.url}/v0/say?session_id=${encodeURIComponent(sess)}&wait=20000`, {
            headers: { authorization: `Bearer ${rt.config.token}` }
          });
        } catch {
          await sleep(5e3);
          continue;
        }
        if (r.status === 204) continue;
        if (r.status !== 200) {
          await sleep(5e3);
          continue;
        }
        let list = [];
        try {
          list = JSON.parse(String(r.text)).say ?? [];
        } catch {
          continue;
        }
        for (const b64 of list) await this.onSay(p, control2, b64, keys, rt.config.instanceId, sess);
      }
    } catch (err) {
      p.log(`orbit: respuestas del reloj desactivadas (${String(err)})`);
    } finally {
      this.sayLoopRunning = false;
    }
  }
  async onSay(p, control2, b64, keys, instanceId2, sess) {
    const v = verifySay(b64uDecode2(b64), keys, Number(await p.now()) / 1e3, instanceId2, sess, this.saySeen);
    if (!v.ok) {
      p.log(`orbit: respuesta del reloj descartada (${v.reason})`);
      return;
    }
    this.saySeen.add(v.nonceHex);
    const plan = sayPlan(v.kind, v.text, this.currentTurnId !== void 0);
    if (plan.submitAfterTurn !== void 0) this.pendingRecap = plan.submitAfterTurn;
    if (plan.abort && this.currentTurnId !== void 0) {
      await control2.abortTurn(this.currentTurnId).catch(() => void 0);
      p.log(`orbit: el reloj detuvo el turno${v.kind === "recap" ? " y pide un resumen" : ""}`);
      if (this.pendingRecap !== void 0) p.after(3e3, () => void this.submitRecap(p, control2));
    } else if (v.kind === "stop") {
      p.log("orbit: el reloj detuvo el turno");
    }
    if (plan.note !== void 0) {
      this.notes.push(plan.note);
      p.log("orbit: nota del reloj para el turno en curso");
    }
    if (plan.submitNow !== void 0) {
      void control2.submitPrompt(plan.submitNow).catch(() => void 0);
      p.log(`orbit: ${v.kind === "recap" ? "resumen pedido" : "prompt"} desde el reloj`);
    }
  }
  /** Envía el "Detente y resume" pendiente si la sesión principal ya está libre. Nunca lanza. */
  async submitRecap(p, control2) {
    if (this.pendingRecap === void 0 || this.currentTurnId !== void 0) return;
    const text = this.pendingRecap;
    this.pendingRecap = void 0;
    try {
      await control2.submitPrompt(text);
      p.log("orbit: resumen pedido desde el reloj");
    } catch (err) {
      p.log(`orbit: no se pudo pedir el resumen (${String(err)})`);
    }
  }
};
async function randomBytes3(p, n) {
  const c = globalThis.crypto;
  if (c !== void 0 && typeof c.getRandomValues === "function") return c.getRandomValues(new Uint8Array(n));
  const r = await p.run(["openssl", "rand", "-hex", String(n)]);
  const hex2 = String(r?.stdout ?? "").trim();
  if (!new RegExp(`^[0-9a-f]{${2 * n}}$`).test(hex2)) throw new Error("sin CSPRNG");
  return Uint8Array.from(hex2.match(/../g).map((h) => parseInt(h, 16)));
}

// src/core/perm/mode.ts
function projectSlug(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}
function transcriptPath(configDir, cwd, sessionId2) {
  return `${configDir.replace(/\/+$/, "")}/projects/${projectSlug(cwd)}/${sessionId2}.jsonl`;
}
function modeGrepArgs(path) {
  return ["/usr/bin/grep", "-o", '"permissionMode":"[A-Za-z]*"', path];
}
function lastMode(stdout) {
  if (typeof stdout !== "string") return void 0;
  const all = [...stdout.matchAll(/"permissionMode":"([A-Za-z]+)"/g)];
  return all.length === 0 ? void 0 : all[all.length - 1][1];
}
function holdsInMode(mode) {
  return mode !== "auto";
}

// src/hosts/claude/register.ts
var orbit = new OrbitEngine();
var env;
var sessionId;
var hostName;
async function readEnv($) {
  return {
    ORBIT_URL: await $.env.get("ORBIT_URL"),
    ORBIT_TOKEN: await $.env.get("ORBIT_TOKEN"),
    ORBIT_INSTANCE_ID: await $.env.get("ORBIT_INSTANCE_ID"),
    ORBIT_CTX: await $.env.get("ORBIT_CTX"),
    ORBIT_STATE_DIR: await $.env.get("ORBIT_STATE_DIR"),
    ORBIT_PHONE_URL: await $.env.get("ORBIT_PHONE_URL"),
    ORBIT_PERM: await $.env.get("ORBIT_PERM"),
    ORBIT_PERM_HOLD_MS: await $.env.get("ORBIT_PERM_HOLD_MS"),
    ORBIT_FORBIDDEN: await $.env.get("ORBIT_FORBIDDEN"),
    ORBIT_FORBIDDEN_ADD: await $.env.get("ORBIT_FORBIDDEN_ADD"),
    ORBIT_WATCH_KEYS: await $.env.get("ORBIT_WATCH_KEYS"),
    HOME: await $.env.get("HOME"),
    XDG_CONFIG_HOME: await $.env.get("XDG_CONFIG_HOME")
  };
}
function platform($) {
  const quiet = (f) => {
    try {
      f();
    } catch {
    }
  };
  return {
    host: "claude",
    env: () => env ??= readEnv($).catch((err) => {
      env = void 0;
      throw err;
    }),
    now: async () => Number(await $.clock.now()),
    after: (ms, cb) => $.clock.after(ms, cb),
    fetch: async (url, init) => {
      const r = await $.http.fetch(url, init);
      return { status: r.status, ok: r.ok, text: r.text };
    },
    store: {
      get: (key) => $.store.get(key),
      set: (key, value) => $.store.set(key, value),
      delete: (key) => $.store.delete(key)
    },
    read: async (path) => String(await $.fs.read(path)),
    write: (path, text) => $.fs.write(path, text),
    run: (argv) => $.process.run(argv),
    log: (message) => $.ui.log(message, { to: "debug" }),
    toast: (message) => quiet(() => $.ui.toast(message)),
    status: (text) => quiet(() => $.ui.status(text)),
    sessionId: async () => sessionId ??= String(await $.session.id())
  };
}
function control($) {
  return {
    abortTurn: async (turnId) => {
      await $.turn.abort({ turnId });
    },
    submitPrompt: async (text) => {
      await $.prompt.submit({ text, asUser: true });
    }
  };
}
function sessionFigures(u) {
  if (u === void 0 || u === null) return {};
  const out = {};
  const c = u.context;
  if (c && typeof c.window === "number") {
    out.context = {
      window: c.window,
      ...typeof c.tokens === "number" ? { tokens: c.tokens } : {},
      ...typeof c.percent === "number" ? { percent: c.percent } : {}
    };
  }
  if (typeof u.startedAt === "number") out.session_started_ms = u.startedAt;
  if (u.cost && typeof u.cost.usd === "number") out.cost_usd = u.cost.usd;
  return out;
}
async function sessionPlace($) {
  if (hostName === void 0) {
    const r = await $.process.run(["hostname", "-s"]).catch(() => void 0);
    hostName = typeof r?.stdout === "string" ? r.stdout.trim() : "";
  }
  const out = {
    orbit_where: { profile: profileOf(await $.env.get("CLAUDE_CONFIG_DIR")), ...hostName ? { host: hostName } : {} }
  };
  const bridge = await $.env.get("CLAUDE_CODE_BRIDGE_SESSION_ID");
  if (typeof bridge === "string" && /^[A-Za-z0-9_-]{4,128}$/.test(bridge)) out.orbit_remote = bridge;
  return out;
}
async function stopExtra($) {
  const usage = await Promise.resolve().then(() => $.session.usage()).catch(() => void 0);
  return { ...sessionFigures(usage), ...await sessionPlace($) };
}
var transcript;
var transcriptFound = false;
var modeCache;
async function sessionMode($) {
  try {
    const now = Number(await $.clock.now());
    if (modeCache !== void 0 && now - modeCache.at < 2e3) return modeCache.mode;
    const sid = await platform($).sessionId();
    if (transcript === void 0) {
      const home = await $.env.get("HOME");
      const configDir = await $.env.get("CLAUDE_CONFIG_DIR") || (home ? `${home}/.claude` : void 0);
      const cwd = await $.session.cwd();
      if (configDir === void 0 || typeof cwd !== "string") return void 0;
      transcript = transcriptPath(configDir, cwd, sid);
    }
    let r = await $.process.run(modeGrepArgs(transcript));
    if (lastMode(r?.stdout) === void 0 && !transcriptFound) {
      const projects = transcript.slice(0, transcript.lastIndexOf("/projects/") + "/projects".length);
      const f = await $.process.run(["/usr/bin/find", projects, "-maxdepth", "2", "-name", `${sid}.jsonl`]);
      const found = typeof f?.stdout === "string" ? f.stdout.split("\n").find((l) => l.endsWith(".jsonl")) : void 0;
      if (found !== void 0) {
        transcript = found;
        r = await $.process.run(modeGrepArgs(found));
      }
    }
    const mode = lastMode(r?.stdout);
    if (mode !== void 0) transcriptFound = true;
    modeCache = { at: now, mode };
    return mode;
  } catch {
    return void 0;
  }
}
async function agentOf($, agentId) {
  const found = (await $.agent.list()).find((a) => a.id === agentId);
  return found === void 0 ? void 0 : { id: found.id, type: found.type, description: found.description };
}
async function bashCwd($, e) {
  if (e.tool !== "Bash") return void 0;
  const cwd = await Promise.resolve().then(() => $.session.cwd()).catch(() => void 0);
  return typeof cwd === "string" ? cwd : void 0;
}
function register(on, _options) {
  on("session.start", async ($, e, next) => {
    try {
      await $.command.register({ name: "orbit", description: COMMAND_DESCRIPTION });
      sessionId = String(await $.session.id());
      await orbit.sessionStart(platform($), e, control($), await sessionPlace($));
    } catch (err) {
      $.ui.log(`orbit: session.start fall\xF3 (${String(err)})`, { to: "debug" });
    }
    return next(e);
  }).catch((_$, e, next) => next(e));
  on("command.run", { command: "orbit" }, async ($, e) => ({ text: await orbit.command(platform($), String(e.args ?? "")) }));
  on("turn.start", async ($, e, next) => {
    await orbit.turnStart(platform($), e);
    return next(e);
  }).catch((_$, e, next) => next(e));
  on("agent.spawn", async ($, e, next) => {
    await orbit.agentSpawn(platform($), e);
    return next(e);
  }).catch((_$, e, next) => next(e));
  on("tool.call", async ($, e, next) => {
    await orbit.toolCall(platform($), e, (id) => agentOf($, id));
    const result = await next(e);
    return orbit.toolResult(platform($), e, result, await bashCwd($, e));
  }).catch((_$, e, next) => next(e));
  on("tool.check", async ($, e, next) => {
    const verdict = await next(e);
    const holds = verdict?.decision !== "ask" || holdsInMode(await sessionMode($));
    return orbit.toolCheck(platform($), e, verdict, next.signal, holds);
  }).catch((_$, e, next) => next(e));
  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    await orbit.turnComplete(platform($), e, control($), () => stopExtra($));
    return result;
  }).catch((_$, e, next) => next(e));
  on("session.end", async ($, e, next) => {
    await orbit.sessionEnd(platform($), e);
    return next(e);
  }).catch((_$, e, next) => next(e));
}
export {
  register,
  sessionFigures
};
