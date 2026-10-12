// Nod para Claude Code. Generado por scripts/bundle.mjs desde src/: no editar a mano.

// src/core/events.ts
var NOD_VERSION = 1;
var PRIVACY_LEVELS = ["completo", "redactado", "trabajo"];
function usageOf(u) {
  if (u === null || typeof u !== "object") return void 0;
  const o = u;
  const n = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
  const out = {
    input: n(o.input_tokens ?? o.input),
    output: n(o.output_tokens ?? o.output),
    cache_read: n(o.cache_read_input_tokens ?? o.cache_read),
    cache_write: n(o.cache_creation_input_tokens ?? o.cache_write)
  };
  if (typeof o.model === "string") out.model = o.model;
  return out;
}
function addUsage(a, b) {
  if (b === void 0) return a;
  const out = {
    input: a.input + b.input,
    output: a.output + b.output,
    cache_read: a.cache_read + b.cache_read,
    cache_write: a.cache_write + b.cache_write
  };
  const model = b.model ?? a.model;
  if (model !== void 0) out.model = model;
  return out;
}
var ZERO_USAGE = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

// src/core/privacy.ts
var TEXT_FIELDS = ["text", "answer", "input", "description", "cwd", "title"];
var FREE_REASON = /* @__PURE__ */ new Set(["permission.request"]);
var BUILTIN_COMMANDS = /* @__PURE__ */ new Set([
  "exit",
  "quit",
  "clear",
  "compact",
  "model",
  "resume",
  "help",
  "init",
  "review",
  "cost",
  "config",
  "login",
  "logout",
  "plan",
  "agents",
  "mcp",
  "memory",
  "permissions",
  "status",
  "doctor",
  "rewind",
  "context",
  "effort",
  "usage",
  "plugin",
  "plugins",
  "hooks",
  "ide",
  "vim",
  "theme",
  "export",
  "add-dir",
  "bug",
  "feedback",
  "release-notes",
  "nod"
]);
var BUILTIN_AGENTS = /* @__PURE__ */ new Set(["agent", "general-purpose", "Explore", "Plan", "statusline-setup", "claude-code-guide", "output-style-setup"]);
var RANK = { completo: 0, redactado: 1, trabajo: 2 };
function redacts(p) {
  return p !== "completo";
}
function stricter(a, b) {
  return RANK[a] >= RANK[b] ? a : b;
}
function isStricter(a, than) {
  return RANK[a] > RANK[than];
}
function shortHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
var hidden = (s) => `h-${shortHash(s)}`;
function hideMcpServer(tool) {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  return m === null ? tool : `mcp__${hidden(m[1])}__${m[2]}`;
}
function applyPrivacy(d, p) {
  if (!redacts(p)) return d;
  const data = { ...d.data };
  for (const k of TEXT_FIELDS) delete data[k];
  if (FREE_REASON.has(d.type)) delete data.reason;
  const repo = data.repo;
  if (repo !== void 0) {
    const { root: _r, remote: _m, ...rest } = repo;
    if (Object.keys(rest).length > 0) data.repo = rest;
    else delete data.repo;
  }
  const out = { ...d, data };
  if (p === "redactado") {
    if (typeof out.task === "string") out.task = hidden(out.task);
    if (typeof data.task === "string") data.task = hidden(data.task);
    if (d.type === "command" && typeof data.name === "string" && !BUILTIN_COMMANDS.has(data.name)) data.name = hidden(data.name);
    if (d.type === "agent.spawn" && typeof data.type === "string" && !BUILTIN_AGENTS.has(data.type)) data.type = hidden(data.type);
    if (typeof data.tool === "string") data.tool = hideMcpServer(data.tool);
    if (Array.isArray(data.tools)) data.tools = data.tools.map((t) => typeof t === "string" ? hideMcpServer(t) : t);
  }
  return out;
}
function sinkAllowed(p, sink) {
  if (p !== "trabajo" || sink.kind === "file") return true;
  return isLocalUrl(sink.target);
}
function isLocalUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

// src/core/config.ts
var INSTANCE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
function configPath(env2) {
  if (env2.NOD_CONFIG) return expandHome(env2.NOD_CONFIG, env2.HOME);
  if (env2.XDG_CONFIG_HOME) return `${env2.XDG_CONFIG_HOME}/nod/config.json`;
  return env2.HOME ? `${env2.HOME}/.config/nod/config.json` : void 0;
}
function defaultLogPath(env2) {
  if (env2.XDG_STATE_HOME) return `${env2.XDG_STATE_HOME}/nod/events.jsonl`;
  return env2.HOME ? `${env2.HOME}/.local/state/nod/events.jsonl` : void 0;
}
function expandHome(p, home) {
  return home !== void 0 && (p === "~" || p.startsWith("~/")) ? home + p.slice(1) : p;
}
function parseSink(raw, home, token) {
  const s = raw.trim();
  if (/^https?:\/\//i.test(s)) {
    let u;
    try {
      u = new URL(s);
    } catch {
      return "destino http inv\xE1lido (URL mal formada)";
    }
    if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") {
      return `destino ${u.protocol}//${u.host} ignorado: la URL no puede llevar usuario, contrase\xF1a, ?par\xE1metros ni #fragmento (usa "token")`;
    }
    return { kind: "http", target: `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, ""), token };
  }
  const path = expandHome(s.startsWith("file:") ? s.slice(5).replace(/^\/\/(?=\/)/, "") : s, home);
  if (path.startsWith("/")) return { kind: "file", target: path };
  return `destino inv\xE1lido (usa http://\u2026, https://\u2026 o una ruta absoluta): ${s}`;
}
function sinksFrom(v, home, warnings, where) {
  if (v === void 0) return void 0;
  if (!Array.isArray(v)) {
    warnings.push(`${where}: "sinks" debe ser una lista`);
    return void 0;
  }
  const out = [];
  for (const item of v) {
    const o = typeof item === "string" ? { url: item } : item;
    const raw = typeof o?.url === "string" ? o.url : typeof o?.file === "string" ? o.file : void 0;
    if (raw === void 0) {
      warnings.push(`${where}: destino sin "url" ni "file"`);
      continue;
    }
    const parsed = parseSink(raw, home, typeof o?.token === "string" ? o.token : void 0);
    if (typeof parsed === "string") warnings.push(`${where}: ${parsed}`);
    else out.push(parsed);
  }
  return out;
}
function privacyFrom(v, warnings, where) {
  if (v === void 0 || v === "") return void 0;
  if (typeof v === "string" && PRIVACY_LEVELS.includes(v)) return v;
  warnings.push(`${where}: privacidad "${String(v)}" no existe (completo, redactado, trabajo)`);
  return void 0;
}
function resolveConfig(env2, fileText, profile, anonId) {
  const warnings = [];
  let file = {};
  const path = configPath(env2);
  if (fileText !== void 0) {
    try {
      const parsed = JSON.parse(fileText);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) file = parsed;
      else warnings.push(`${path}: no es un objeto JSON`);
    } catch (err) {
      warnings.push(`${path}: JSON inv\xE1lido (${String(err)})`);
    }
  }
  const section = (file.profiles && typeof file.profiles === "object" ? file.profiles[profile] : void 0) ?? {};
  let sinks;
  if (env2.NOD_SINKS !== void 0 && env2.NOD_SINKS.trim() !== "") {
    sinks = [];
    for (const raw of env2.NOD_SINKS.split(/[\s,]+/).filter(Boolean)) {
      const parsed = parseSink(raw, env2.HOME);
      if (typeof parsed === "string") {
        warnings.push(`NOD_SINKS: ${parsed}`);
        continue;
      }
      if (parsed.kind === "http" && env2.NOD_TOKEN) {
        if (parsed.target.startsWith("https://") || isLocalUrl(parsed.target)) parsed.token = env2.NOD_TOKEN;
        else warnings.push(`NOD_TOKEN no se manda a ${parsed.target}: es http sin cifrar y no es local (usa https)`);
      }
      sinks.push(parsed);
    }
  }
  sinks ??= sinksFrom(section.sinks, env2.HOME, warnings, `${path} (perfil ${profile})`);
  sinks ??= sinksFrom(file.sinks, env2.HOME, warnings, String(path));
  if (sinks === void 0) {
    const log = defaultLogPath(env2);
    sinks = log === void 0 ? [] : [{ kind: "file", target: log }];
  }
  const privacy = privacyFrom(env2.NOD_PRIVACY, warnings, "NOD_PRIVACY") ?? privacyFrom(section.privacy, warnings, `${path} (perfil ${profile})`) ?? privacyFrom(file.privacy, warnings, String(path)) ?? "completo";
  const wanted = env2.NOD_INSTANCE || (typeof section.instance === "string" ? section.instance : void 0) || (typeof file.instance === "string" ? file.instance : void 0);
  let instance = defaultInstance(profile, anonId);
  if (wanted !== void 0) {
    if (INSTANCE_RE.test(wanted)) instance = wanted;
    else warnings.push(`instancia "${wanted}" inv\xE1lida (min\xFAsculas, cifras, . _ -; hasta 64): uso ${instance}`);
  }
  const source = env2.NOD_SINKS ? "variables NOD_*" : fileText !== void 0 ? String(path) : "valores por defecto";
  const task = env2.NOD_TASK?.trim() || void 0;
  return { config: { enabled: env2.NOD_OFF !== "1", instance, privacy, sinks, task, source }, warnings };
}
function defaultInstance(profile, anonId) {
  const clean = (x) => x.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  const id = clean(anonId).slice(0, 16) || "0";
  const p = (clean(profile) || "claude").slice(0, 63 - id.length);
  return `${p}-${id}`;
}

// src/core/normalize.ts
var RECALL_MEMORY = 50;
var MAX_AGENTS = 256;
function verbOf(command) {
  if (typeof command !== "string") return void 0;
  for (const w of command.trim().split(/\s+/)) {
    if (w === "") continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      if (/['"`$(]/.test(w)) return void 0;
      continue;
    }
    if (w === "sudo" || w === "env" || w === "exec" || w === "time" || w === "nohup") continue;
    const base = w.includes("/") ? w.slice(w.lastIndexOf("/") + 1) : w;
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(base) || /\.(sh|py|rb|js|ts|pl|bash|zsh)$/i.test(base)) return void 0;
    return base;
  }
  return void 0;
}
var Normalizer = class {
  /** Tarea en curso (§5): va en todos los eventos. */
  task;
  sessionStartTs;
  tools = /* @__PURE__ */ new Map();
  agents = /* @__PURE__ */ new Map();
  turnSteps = /* @__PURE__ */ new Map();
  /** Turno en curso de la sesión principal (clave "") y de cada subagente. */
  current = /* @__PURE__ */ new Map();
  edit;
  recent = [];
  draft(ts, type, session, data, at = {}) {
    const d = { ts, type, session, data };
    if (at.turn !== void 0) d.turn = at.turn;
    if (at.agent !== void 0) d.agent = at.agent;
    if (this.task !== void 0) d.task = this.task;
    return d;
  }
  /** Olvida lo propio de la sesión anterior (tools, turnos, subagentes, lo tecleado). La tarea sigue. */
  resetSession() {
    this.tools.clear();
    this.agents.clear();
    this.turnSteps.clear();
    this.current.clear();
    this.edit = void 0;
    this.sessionStartTs = void 0;
  }
  sessionStart(ts, session, info2) {
    this.resetSession();
    this.sessionStartTs = ts;
    const data = { interactive: info2.interactive === true };
    if (info2.cwd !== void 0) data.cwd = info2.cwd;
    if (info2.repo !== void 0) {
      const repo = {};
      if (info2.repo.root) repo.root = info2.repo.root;
      if (info2.repo.remote) repo.remote = info2.repo.remote;
      if (info2.repo.name) repo.name = info2.repo.name;
      if (Object.keys(repo).length > 0) data.repo = repo;
    }
    if (info2.model !== void 0) data.model = info2.model;
    if (info2.surface !== void 0) data.surface = info2.surface;
    return [this.draft(ts, "session.start", session, data)];
  }
  /** Cada cambio en el editor de prompts. No emite: se resume en el siguiente `prompt.submit`. */
  promptEdit(ts, e) {
    if (this.edit === void 0) {
      const recalled = e.before.trim() !== "" && this.recent.includes(e.before.trim());
      this.edit = { first: ts, events: 0, recalled, revised: false };
    }
    this.edit.events++;
    if (e.end > e.start) this.edit.revised = true;
  }
  promptSubmit(ts, session, p) {
    const data = { origin: p.origin, chars: p.text.length, text: p.text };
    if (p.origin === "composer") {
      if (this.edit !== void 0) {
        data.edit = { events: this.edit.events, typing_ms: Math.max(0, ts - this.edit.first), recalled: this.edit.recalled, revised: this.edit.revised };
      }
      this.edit = void 0;
    }
    const t = p.text.trim();
    if (t !== "") {
      const i = this.recent.indexOf(t);
      if (i >= 0) this.recent.splice(i, 1);
      this.recent.push(t);
      if (this.recent.length > RECALL_MEMORY) this.recent.shift();
    }
    return [this.draft(ts, "prompt.submit", session, data)];
  }
  turnStart(ts, session, turn, agent) {
    this.turnSteps.set(turn, 0);
    this.current.set(agent ?? "", turn);
    return [this.draft(ts, "turn.start", session, {}, { turn, agent })];
  }
  /**
   * Empieza una llamada al modelo. Los subagentes no tienen turn.start: su turno se conoce aquí, antes de las
   * tools que pida esta llamada.
   */
  stepBegin(turn, agent) {
    this.current.set(agent ?? "", turn);
  }
  step(ts, session, s) {
    this.turnSteps.set(s.turn, (this.turnSteps.get(s.turn) ?? 0) + 1);
    this.current.set(s.agent ?? "", s.turn);
    if (s.agent !== void 0) {
      const run = this.agents.get(s.agent);
      if (run !== void 0) run.usage = addUsage(run.usage, s.usage);
    }
    const data = { index: s.index, tools: s.tools, usage: s.usage ?? ZERO_USAGE };
    if (s.model !== void 0) data.model = s.model;
    if (s.effort !== void 0) data.effort = s.effort;
    if (s.stopReason !== void 0) data.stop_reason = s.stopReason;
    else data.partial = true;
    return [this.draft(ts, "turn.step", session, data, { turn: s.turn, agent: s.agent })];
  }
  turnEnd(ts, session, t) {
    const out = [];
    for (const [id, p] of this.tools) {
      if (p.turn === t.turn && p.askTs !== void 0 && p.decidedTs === void 0) {
        out.push(this.decision(ts, session, id, p, "deny", "user"));
        this.tools.delete(id);
      }
    }
    const data = {
      outcome: t.outcome,
      usage: t.usage ?? ZERO_USAGE,
      steps: this.turnSteps.get(t.turn) ?? 0,
      answer_chars: t.answer?.length ?? 0
    };
    if (t.durationMs !== void 0) data.duration_ms = t.durationMs;
    if (t.answer !== void 0 && t.answer !== "") data.answer = t.answer;
    this.turnSteps.delete(t.turn);
    for (const [id, p] of this.tools) if (p.turn === t.turn) this.tools.delete(id);
    if (this.current.get(t.agent ?? "") === t.turn) this.current.delete(t.agent ?? "");
    out.push(this.draft(ts, "turn.end", session, data, { turn: t.turn, agent: t.agent }));
    if (t.agent !== void 0) {
      const run = this.agents.get(t.agent);
      if (run !== void 0) {
        out.push(this.draft(ts, "agent.end", session, { agent: t.agent, duration_ms: Math.max(0, ts - run.spawnTs), usage: run.usage }, { agent: t.agent }));
      }
    }
    return out;
  }
  toolCall(ts, session, c) {
    const turn = this.current.get(c.agent ?? "");
    this.tools.set(c.toolUseId, { tool: c.tool, agent: c.agent, turn, callTs: ts });
    const data = { tool_use_id: c.toolUseId, tool: c.tool };
    const input = c.input;
    const verb = verbOf(input?.command);
    if (verb !== void 0) data.verb = verb;
    if (input !== void 0) data.input = input;
    return [this.draft(ts, "tool.call", session, data, { turn, agent: c.agent })];
  }
  /**
   * Lo que decidió el agente sobre el permiso de una tool (antes de preguntar a nadie). `checkMs`: cuánto tardó
   * en decidir (normalmente nada; mucho si otro mod retuvo el permiso).
   */
  toolCheck(ts, session, id, tool, decision, reason, checkMs) {
    let p = this.tools.get(id);
    if (p === void 0) {
      p = { tool, agent: void 0, turn: void 0, callTs: ts };
      this.tools.set(id, p);
    }
    if (decision === "ask") {
      p.askTs = ts;
      const data = { tool_use_id: id, tool };
      if (reason !== void 0 && reason !== "") data.reason = reason;
      if (checkMs !== void 0) data.check_ms = checkMs;
      return [this.draft(ts, "permission.request", session, data, { turn: p.turn, agent: p.agent })];
    }
    const d = this.decision(ts, session, id, p, decision, "policy");
    if (checkMs !== void 0) d.data.check_ms = checkMs;
    return [d];
  }
  /** El agente dice cuánto tardó la ejecución de la tool (llega antes que su resultado). */
  toolExec(id, ms) {
    const p = this.tools.get(id);
    if (p !== void 0 && Number.isFinite(ms) && ms >= 0) p.execMs = ms;
  }
  /** Un aprobador remoto (canal de control) decidió un permiso preguntado. */
  remoteDecision(ts, session, id, decision) {
    const p = this.tools.get(id);
    if (p === void 0 || p.askTs === void 0 || p.decidedTs !== void 0) return [];
    return [this.decision(ts, session, id, p, decision, "remote")];
  }
  /** `exact` = false: el instante de la respuesta no se vio y `wait_ms` es una cota superior. */
  decision(ts, session, id, p, decision, by, exact = true) {
    p.decidedTs = ts;
    const wait = p.askTs === void 0 ? 0 : Math.max(0, ts - p.askTs);
    return this.draft(ts, "permission.decision", session, { tool_use_id: id, tool: p.tool, decision, by, wait_ms: wait, exact }, { turn: p.turn, agent: p.agent });
  }
  toolResult(ts, session, r) {
    const out = [];
    const p = this.tools.get(r.toolUseId) ?? { tool: r.tool, agent: void 0, turn: void 0, callTs: ts };
    if (p.askTs !== void 0 && p.decidedTs === void 0) {
      const exact = r.rejected || p.execMs !== void 0;
      const at = r.rejected || p.execMs === void 0 ? ts : Math.max(p.askTs, ts - p.execMs);
      out.push(this.decision(at, session, r.toolUseId, p, r.rejected ? "deny" : "allow", "user", exact));
    }
    const began = Math.max(p.callTs, p.decidedTs ?? p.callTs);
    out.push(this.draft(ts, "tool.result", session, {
      tool_use_id: r.toolUseId,
      tool: r.tool,
      duration_ms: r.rejected ? 0 : p.execMs ?? Math.max(0, ts - began),
      ok: r.ok && !r.rejected,
      rejected: r.rejected,
      output_chars: r.outputChars
    }, { turn: p.turn, agent: p.agent }));
    this.tools.delete(r.toolUseId);
    return out;
  }
  agentSpawn(ts, session, a) {
    this.agents.set(a.agent, { spawnTs: ts, usage: ZERO_USAGE });
    if (this.agents.size > MAX_AGENTS) this.agents.delete(this.agents.keys().next().value);
    const data = { agent: a.agent, type: a.type ?? "agent", background: a.background === true };
    if (a.fork !== void 0) data.fork = a.fork;
    if (a.permissionMode !== void 0) data.permission_mode = a.permissionMode;
    if (a.description !== void 0) data.description = a.description;
    if (a.model !== void 0) data.model = a.model;
    if (a.toolUseId !== void 0) data.tool_use_id = a.toolUseId;
    return [this.draft(ts, "agent.spawn", session, data, { agent: a.agent, turn: this.current.get("") })];
  }
  usage(ts, session, u) {
    const data = {};
    if (u.context !== void 0) data.context = u.context;
    if (u.limits !== void 0) data.limits = u.limits;
    if (u.cost_usd !== void 0) data.cost_usd = u.cost_usd;
    return Object.keys(data).length === 0 ? [] : [this.draft(ts, "usage", session, data)];
  }
  command(ts, session, name) {
    this.edit = void 0;
    return [this.draft(ts, "command", session, { name })];
  }
  setTask(ts, session, task, title, source) {
    this.task = task;
    const data = { task: task ?? null, source };
    if (title !== void 0) data.title = title;
    return [this.draft(ts, "task.set", session, data)];
  }
  sessionEnd(ts, session, reason) {
    const duration = this.sessionStartTs === void 0 ? 0 : Math.max(0, ts - this.sessionStartTs);
    return [this.draft(ts, "session.end", session, { reason, duration_ms: duration })];
  }
};

// src/core/queue.ts
var DEFAULT_QUEUE = { maxEvents: 5e3, maxBytes: 1e6 };
var OfflineQueue = class {
  constructor(opts = DEFAULT_QUEUE) {
    this.opts = opts;
  }
  opts;
  entries = [];
  bytes = 0;
  droppedTotal = 0;
  /** Se incrementa en cada cambio: dice si hay algo que persistir. */
  version = 0;
  get length() {
    return this.entries.length;
  }
  get byteSize() {
    return this.bytes;
  }
  /** Añade uno. Devuelve cuántos viejos tuvo que descartar para caber. */
  push(item) {
    const size = JSON.stringify(item).length;
    this.entries.push({ item, size });
    this.bytes += size;
    this.version++;
    let dropped = 0;
    while (this.entries.length > 1 && (this.entries.length > this.opts.maxEvents || this.bytes > this.opts.maxBytes)) {
      this.bytes -= this.entries.shift().size;
      dropped++;
    }
    this.droppedTotal += dropped;
    return dropped;
  }
  peek(max) {
    return this.entries.slice(0, max).map((e) => e.item);
  }
  /**
   * Quita estos elementos (los entregados), por identidad: si mientras se enviaban la cola descartó cabeza o se
   * reescribió, no se lleva otros por posición.
   */
  ackItems(items) {
    if (items.length === 0) return;
    const gone = new Set(items);
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => {
      if (!gone.has(e.item)) return true;
      this.bytes -= e.size;
      return false;
    });
    if (this.entries.length !== before) this.version++;
  }
  /** Quita estos elementos por rechazo definitivo, contándolos como perdidos. */
  rejectItems(items) {
    const before = this.entries.length;
    this.ackItems(items);
    const lost = before - this.entries.length;
    this.droppedTotal += lost;
    return lost;
  }
  /** Reescribe o quita (undefined) cada elemento; devuelve cuántos quitó. Sirve para endurecer la privacidad. */
  rewrite(fn) {
    const kept = [];
    let removed = 0;
    let changed = false;
    for (const e of this.entries) {
      const next = fn(e.item);
      if (next === void 0) {
        removed++;
        continue;
      }
      if (next !== e.item) changed = true;
      kept.push(next === e.item ? e : { item: next, size: JSON.stringify(next).length });
    }
    if (removed > 0 || changed) {
      this.entries = kept;
      this.bytes = kept.reduce((n, e) => n + e.size, 0);
      this.version++;
    }
    return removed;
  }
  toJSON() {
    return { items: this.entries.map((e) => e.item), dropped: this.droppedTotal };
  }
  /** Recarga lo persistido. Lo que no cabe se descarta y se cuenta. */
  load(snapshot) {
    this.droppedTotal = Math.max(this.droppedTotal, Number(snapshot.dropped) || 0);
    let dropped = 0;
    for (const it of snapshot.items) dropped += this.push(it);
    return dropped;
  }
};

// src/core/outbox.ts
var BATCH_WINDOW_MS = 250;
var MAX_BATCH = 500;
var MAX_BACKOFF_MS = 3e4;
var PERSIST_EVERY_MS = 2e3;
var ORPHAN_AFTER_MS = 10 * 6e4;
var REJECTED = /* @__PURE__ */ new Set([400, 413, 422]);
function sinkId(s) {
  return shortHash(`${s.kind}:${s.target}`);
}
var Outbox = class {
  constructor(sink, source, transport, io, instance, run, queue) {
    this.sink = sink;
    this.source = source;
    this.transport = transport;
    this.io = io;
    this.run = run;
    this.queue = new OfflineQueue({ maxEvents: 5e3, maxBytes: 1e6, ...queue });
    this.base = `nod.outbox.${instance}.${sinkId(sink)}`;
    this.key = `${this.base}.${run}`;
  }
  sink;
  source;
  transport;
  io;
  run;
  queue;
  dirtyAt = null;
  fails = 0;
  nextRetryAt = 0;
  sent = 0;
  duplicates = 0;
  adopted = 0;
  lastOkAt;
  lastError;
  lastErrorAt;
  reportedDrops = 0;
  savedVersion = -1;
  savedAt = 0;
  chain = Promise.resolve();
  /** Prefijo común a todas las ejecuciones; `key` es la de esta. */
  base;
  key;
  /** Se apunta en el índice y adopta las colas de ejecuciones muertas. Nunca lanza. */
  async init() {
    try {
      const now = await this.io.now();
      const index = await this.loadIndex();
      const keep = [];
      for (const run of index) {
        if (run === this.run) continue;
        const saved = await this.io.load(`${this.base}.${run}`);
        if (saved === void 0 || saved === null || !Array.isArray(saved.items)) continue;
        if (now - (Number(saved.at) || 0) < ORPHAN_AFTER_MS) {
          keep.push(run);
          continue;
        }
        this.queue.load({ items: saved.items, dropped: 0 });
        this.adopted += saved.items.length;
        await this.io.save(`${this.base}.${run}`, null);
      }
      await this.io.save(`${this.base}.runs`, [...keep, this.run]);
      const legacy = await this.io.load(this.base);
      if (legacy && Array.isArray(legacy.items)) {
        this.queue.load({ items: legacy.items.filter((q) => typeof q?.r === "string"), dropped: 0 });
        await this.io.save(this.base, null);
      }
      if (this.adopted > 0) this.io.log(`nod: ${this.adopted} eventos pendientes de sesiones anteriores hacia ${this.sink.target}`);
      if (this.queue.length > 0) this.dirtyAt = now;
      await this.persist(true);
    } catch (err) {
      this.io.log(`nod: no se pudo recuperar la cola de ${this.sink.target} (${String(err)})`);
    }
  }
  async loadIndex() {
    const v = await this.io.load(`${this.base}.runs`);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(-50) : [];
  }
  push(item, now) {
    this.queue.push(item);
    if (this.dirtyAt === null) this.dirtyAt = now;
  }
  /**
   * Deja la cola como si todo se hubiera encolado con `privacy`: lo que entró con un perfil más laxo se vuelve
   * a filtrar; si el destino ya no puede recibir nada (`allowed` = false), se vacía. Devuelve cuántos quitó.
   */
  async restrict(privacy, allowed) {
    const removed = allowed ? this.queue.rewrite((q) => isStricter(privacy, q.p) ? { e: applyPrivacy(q.e, privacy), p: privacy, r: q.r } : q) : this.queue.rewrite(() => void 0);
    await this.persist(true);
    return removed;
  }
  /** Milisegundos hasta el próximo envío, o null si no hay nada pendiente. */
  delay(now, paused) {
    if (paused || this.queue.length === 0) return null;
    const due = this.dirtyAt !== null ? this.dirtyAt + BATCH_WINDOW_MS : now;
    return Math.max(0, Math.max(due, this.nextRetryAt) - now);
  }
  /** Envía ya, sin esperar a la ventana del lote (fin de turno, permiso pendiente…). */
  urgent() {
    this.dirtyAt = 0;
  }
  /** Guarda la cola si cambió y hace un rato que no se guarda (un cierre brusco no pierde lo encolado). */
  async persistSoon(now) {
    if (now - this.savedAt >= PERSIST_EVERY_MS) await this.persist();
  }
  /** Entrega lo que haya, en orden y en lotes. Las llamadas se encadenan; nunca lanza ni rompe la cadena. */
  flush() {
    this.chain = this.chain.catch(() => void 0).then(() => this.doFlush()).catch((err) => this.fail(err).catch(() => void 0));
    return this.chain;
  }
  async doFlush() {
    this.dirtyAt = null;
    let size = MAX_BATCH;
    while (this.queue.length > 0) {
      const head = this.queue.peek(size);
      const { p, r } = head[0];
      let n = head.findIndex((q) => q.p !== p || q.r !== r);
      if (n < 0) n = head.length;
      const batch = head.slice(0, n);
      let res;
      try {
        res = await this.transport({ nod: NOD_VERSION, source: this.source(p, r), events: batch.map((q) => q.e) });
      } catch (err) {
        await this.fail(err);
        break;
      }
      if (res.status >= 200 && res.status < 300) {
        this.queue.ackItems(batch);
        this.sent += batch.length;
        this.noteDuplicates(res.text);
        this.fails = 0;
        this.nextRetryAt = 0;
        this.lastOkAt = await this.io.now();
        size = MAX_BATCH;
        continue;
      }
      if (REJECTED.has(res.status)) {
        if (batch.length > 1) {
          size = Math.max(1, Math.floor(batch.length / 2));
          continue;
        }
        this.queue.rejectItems(batch);
        this.io.log(`nod: ${this.sink.target} rechaz\xF3 un evento (HTTP ${res.status}); descartado`);
        this.lastError = `HTTP ${res.status} (evento descartado)`;
        this.lastErrorAt = await this.io.now();
        continue;
      }
      await this.fail(new Error(`HTTP ${res.status}`));
      break;
    }
    await this.persist();
    this.reportDrops();
  }
  noteDuplicates(text) {
    if (!text) return;
    try {
      const d = JSON.parse(text).duplicates;
      if (typeof d === "number" && d > 0) this.duplicates += d;
    } catch {
    }
  }
  async fail(err) {
    this.fails++;
    const wait = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(this.fails - 1, 6));
    const now = await this.io.now();
    this.nextRetryAt = now + wait;
    this.lastError = err instanceof Error ? err.message : String(err);
    this.lastErrorAt = now;
    await this.persist();
  }
  async persist(force = false) {
    if (!force && this.queue.version === this.savedVersion) return;
    try {
      const now = await this.io.now();
      const value = this.queue.length === 0 ? null : { ...this.queue.toJSON(), at: now };
      await this.io.save(this.key, value);
      if (value !== null) {
        const index = await this.loadIndex();
        if (!index.includes(this.run)) await this.io.save(`${this.base}.runs`, [...index, this.run]);
      }
      this.savedVersion = this.queue.version;
      this.savedAt = now;
    } catch (err) {
      this.io.log(`nod: no se pudo guardar la cola de ${this.sink.target} (${String(err)})`);
    }
  }
  reportDrops() {
    const lost = this.queue.droppedTotal - this.reportedDrops;
    if (lost <= 0) return;
    this.reportedDrops = this.queue.droppedTotal;
    this.io.log(`nod: se perdieron ${lost} eventos hacia ${this.sink.target} (cola llena o rechazados)`);
  }
  status() {
    return {
      kind: this.sink.kind,
      target: this.sink.target,
      queued: this.queue.length,
      sent: this.sent,
      dropped: this.queue.droppedTotal,
      duplicates: this.duplicates,
      adopted: this.adopted,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt
    };
  }
};

// src/core/engine.ts
var COMMAND_DESCRIPTION = "Nod: estado de la sesi\xF3n y de los destinos; /nod tarea <id>, /nod privacidad, /nod pausa, /nod reanuda";
var KEYS = {
  /** Id aleatorio y estable de este perfil en esta máquina: la instancia por defecto sin el nombre del equipo. */
  anonId: "nod.id",
  paused: "nod.paused",
  privacy: "nod.privacy"
};
var URGENT = /* @__PURE__ */ new Set(["turn.end", "session.end", "permission.request", "agent.end"]);
var USAGE = [
  "uso: /nod [estado | tarea [<id> [t\xEDtulo] | fin] | privacidad [completo|redactado|trabajo] | pausa | reanuda | ayuda]"
].join("\n");
var freshStats = () => ({
  turns: 0,
  aborted: 0,
  steps: 0,
  usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  agents: 0,
  asks: 0,
  userWaitMs: 0,
  denied: 0,
  prompts: 0,
  revised: 0,
  lastUsage: void 0
});
var NodEngine = class {
  runtime;
  norm = new Normalizer();
  timer;
  stats = freshStats();
  session;
  /** Todo el trabajo va en fila: el adaptador no espera (no retrasa al agente) y el orden se conserva. */
  chain = Promise.resolve();
  /** Esta ejecución del agente (un proceso): `seq` empieza en 1 y es único dentro de ella (Nod v1 §1.3). */
  run = randomHex(4);
  seq = 0;
  /** Desde cuándo esta sesión (para emitir un session.start cuando el agente cambia de sesión sin avisar). */
  started = /* @__PURE__ */ new Set();
  // ---------- lo que llama el adaptador ----------
  async sessionStart(p, session, info2) {
    await this.guard(p, "session.start", async (now, rt) => {
      this.session = session;
      this.started.add(session);
      this.stats = freshStats();
      const out = this.norm.sessionStart(now, session, info2);
      if (rt.config.task !== void 0 && this.norm.task === void 0) out.push(...this.norm.setTask(now, session, rt.config.task, void 0, "env"));
      return out;
    });
  }
  async promptEdit(p, e) {
    await this.guard(p, "prompt.edit", async (now) => {
      this.norm.promptEdit(now, e);
      return [];
    });
  }
  async promptSubmit(p, session, text, origin) {
    await this.guard(p, "prompt.submit", async (now) => this.norm.promptSubmit(now, session, { text, origin }));
  }
  async turnStart(p, session, turn, agent) {
    await this.guard(p, "turn.start", async (now) => this.norm.turnStart(now, session, turn, agent));
  }
  async step(p, session, s) {
    await this.guard(p, "turn.step", async (now) => this.norm.step(now, session, s));
  }
  /** Fin de turno. En la sesión principal, `usage` (contexto, límites, costo) sale justo después. */
  async turnEnd(p, session, t, usage) {
    await this.guard(p, "turn.end", async (now) => {
      const out = this.norm.turnEnd(now, session, t);
      if (t.agent === void 0 && usage !== void 0) {
        const u = await usage().catch(() => void 0);
        if (u !== void 0) out.push(...this.norm.usage(now, session, u));
      }
      return out;
    });
  }
  async toolCall(p, session, c) {
    await this.guard(p, "tool.call", async (now) => this.norm.toolCall(now, session, c));
  }
  async toolCheck(p, session, id, tool, decision, reason, checkMs) {
    await this.guard(p, "tool.check", async (now) => this.norm.toolCheck(now, session, id, tool, decision, reason, checkMs));
  }
  /** Duración de la ejecución de una tool, si el agente la da (antes de su resultado). */
  async toolExec(p, id, ms) {
    await this.guard(p, "tool.exec", async () => {
      this.norm.toolExec(id, ms);
      return [];
    });
  }
  /** Empieza una llamada al modelo (fija el turno en curso del subagente antes de sus tools). */
  async stepBegin(p, turn, agent) {
    await this.guard(p, "turn.step", async () => {
      this.norm.stepBegin(turn, agent);
      return [];
    });
  }
  async toolResult(p, session, r) {
    await this.guard(p, "tool.result", async (now) => this.norm.toolResult(now, session, r));
  }
  async agentSpawn(p, session, a) {
    await this.guard(p, "agent.spawn", async (now) => this.norm.agentSpawn(now, session, a));
  }
  async command(p, session, name) {
    await this.guard(p, "command", async (now) => this.norm.command(now, session, name));
  }
  async sessionEnd(p, session, reason) {
    await this.guard(p, "session.end", async (now) => this.norm.sessionEnd(now, session, reason));
    this.started.delete(session);
    const rt = await this.runtime?.catch(() => void 0);
    if (rt === void 0) return;
    const boxes = rt.outboxes.filter((o) => sinkAllowed(rt.privacy, o.sink));
    if (!rt.paused) await within(p, CLOSE_TIMEOUT_MS, Promise.all(boxes.map((o) => o.flush())));
    await Promise.all(boxes.map((o) => o.persistSoon(Number.MAX_SAFE_INTEGER)));
  }
  /** `/nod …`. Espera a que la fila esté al día (las cifras incluyen todo lo anterior). Nunca lanza. */
  async runCommand(p, session, args) {
    try {
      await this.chain;
      return await this.doCommand(p, session, args.trim());
    } catch (err) {
      return `nod: error (${String(err)})`;
    }
  }
  // ---------- configuración ----------
  getRuntime(p) {
    this.runtime ??= this.loadRuntime(p).catch((err) => {
      this.runtime = void 0;
      throw err;
    });
    return this.runtime;
  }
  async loadRuntime(p) {
    const [info2, env2] = await Promise.all([p.info(), p.env()]);
    const path = configPath(env2);
    let text;
    if (path !== void 0) {
      try {
        text = await p.read(path);
      } catch {
        text = void 0;
      }
    }
    let anonId = await p.store.get(KEYS.anonId);
    if (typeof anonId !== "string" || !/^[0-9a-f]{8}$/.test(anonId)) {
      anonId = randomHex(4);
      await p.store.set(KEYS.anonId, anonId);
    }
    const { config, warnings } = resolveConfig(env2, text, info2.profile, anonId);
    const stored = await p.store.get(KEYS.privacy);
    let privacy = config.privacy;
    if (!env2.NOD_PRIVACY && PRIVACY_LEVELS.includes(stored)) {
      privacy = stricter(config.privacy, stored);
      if (isStricter(config.privacy, stored)) warnings.push(`la privacidad guardada (${String(stored)}) es m\xE1s laxa que la de la configuraci\xF3n: uso ${config.privacy}`);
    }
    for (const w of warnings) p.log(`nod: ${w}`);
    const rt = { info: info2, config, warnings, privacy, outboxes: [], paused: await p.store.get(KEYS.paused) === true };
    for (const sink of config.sinks) {
      const transport = sink.kind === "file" ? async (envelope) => {
        await p.append(sink.target, JSON.stringify(envelope) + "\n");
        return { status: 200 };
      } : async (envelope) => {
        const headers = { "content-type": "application/json" };
        if (sink.token) headers.authorization = `Bearer ${sink.token}`;
        const r = await within(p, HTTP_TIMEOUT_MS, p.fetch(`${sink.target}/v1/events`, { method: "POST", headers, body: JSON.stringify(envelope) }));
        if (r === void 0) throw new Error(`sin respuesta en ${HTTP_TIMEOUT_MS / 1e3} s`);
        return { status: r.status, text: r.text };
      };
      const box = new Outbox(sink, (pv, run) => this.source(rt, pv, run), transport, this.outboxIo(p), config.instance, this.run);
      await box.init();
      rt.outboxes.push(box);
    }
    await this.restrictQueues(p, rt);
    return rt;
  }
  /** Vuelve a filtrar las colas con la privacidad actual; vacía las de destinos que ya no la admiten. */
  async restrictQueues(p, rt) {
    for (const box of rt.outboxes) {
      const removed = await box.restrict(rt.privacy, sinkAllowed(rt.privacy, box.sink));
      if (removed > 0) p.log(`nod: ${removed} eventos en cola hacia ${box.sink.target} descartados (privacidad ${rt.privacy})`);
    }
  }
  source(rt, privacy, run) {
    const s = { instance: rt.config.instance, run, host: rt.info.host, profile: rt.info.profile, privacy };
    if (rt.info.hostVersion !== void 0) s.host_version = rt.info.hostVersion;
    if (rt.info.machine !== void 0 && privacy === "completo") s.machine = rt.info.machine;
    return s;
  }
  outboxIo(p) {
    return {
      now: () => p.now(),
      load: (key) => p.store.get(key),
      save: (key, value) => p.store.set(key, value),
      log: (m) => p.log(m)
    };
  }
  // ---------- emisión ----------
  /**
   * Normaliza (`work`), numera, filtra y encola, en fila detrás de lo anterior. La hora se toma al llamar (es la
   * del evento, no la de su turno en la fila). Nunca lanza.
   */
  guard(p, label, work) {
    const at = p.now();
    at.catch(() => void 0);
    const run = this.chain.then(async () => {
      try {
        const rt = await this.getRuntime(p);
        if (!rt.config.enabled) return;
        const now = await at;
        const drafts = await work(now, rt);
        const first = drafts[0];
        if (first !== void 0 && first.type !== "session.start" && !this.started.has(first.session)) {
          this.started.add(first.session);
          this.session = first.session;
          this.stats = freshStats();
          this.norm.resetSession();
          const opening = this.norm.sessionStart(now, first.session, {});
          opening[0].data.continued = true;
          drafts.unshift(...opening);
        }
        if (drafts.length > 0) await this.emit(p, rt, drafts, now);
      } catch (err) {
        p.log(`nod: ${label} fall\xF3 (${String(err)})`);
      }
    });
    this.chain = run;
    return run;
  }
  async emit(p, rt, drafts, now) {
    let urgent = false;
    for (const d of drafts) {
      this.count(d);
      const e = { ...applyPrivacy(d, rt.privacy), seq: ++this.seq };
      for (const box of rt.outboxes) if (sinkAllowed(rt.privacy, box.sink)) box.push({ e, p: rt.privacy, r: this.run }, now);
      if (URGENT.has(d.type)) urgent = true;
    }
    if (urgent) for (const box of rt.outboxes) box.urgent();
    for (const box of rt.outboxes) await box.persistSoon(now);
    await this.schedule(p, rt);
  }
  async schedule(p, rt) {
    const now = await p.now();
    const waits = rt.outboxes.filter((o) => sinkAllowed(rt.privacy, o.sink)).map((o) => o.delay(now, rt.paused)).filter((w) => w !== null);
    this.timer?.cancel();
    this.timer = void 0;
    if (waits.length === 0) return;
    this.timer = p.after(Math.min(...waits), () => {
      this.timer = void 0;
      void this.flushDue(p, rt);
    });
  }
  async flushDue(p, rt) {
    try {
      const now = await p.now();
      for (const box of rt.outboxes) {
        if (!sinkAllowed(rt.privacy, box.sink)) continue;
        box.io = this.outboxIo(p);
        if (box.delay(now, rt.paused) === 0) await box.flush();
      }
      await this.schedule(p, rt);
    } catch (err) {
      p.log(`nod: fallo al entregar (${String(err)})`);
    }
  }
  count(d) {
    const s = this.stats;
    const data = d.data;
    switch (d.type) {
      case "turn.end":
        if (d.agent === void 0) {
          s.turns++;
          if (data.outcome === "aborted") s.aborted++;
        }
        break;
      case "turn.step": {
        s.steps++;
        const u = data.usage;
        if (u !== void 0) s.usage = { input: s.usage.input + u.input, output: s.usage.output + u.output, cache_read: s.usage.cache_read + u.cache_read, cache_write: s.usage.cache_write + u.cache_write };
        break;
      }
      case "agent.spawn":
        s.agents++;
        break;
      case "permission.request":
        s.asks++;
        break;
      case "permission.decision":
        if (data.by === "user" || data.by === "remote") {
          s.userWaitMs += Number(data.wait_ms) || 0;
          if (data.decision === "deny") s.denied++;
        }
        break;
      case "prompt.submit":
        s.prompts++;
        if (data.edit?.revised) s.revised++;
        break;
      case "usage":
        s.lastUsage = data;
        break;
      default:
        break;
    }
  }
  // ---------- /nod ----------
  async doCommand(p, session, args) {
    const rt = await this.getRuntime(p);
    const [verb = "", ...rest] = args.split(/\s+/).filter(Boolean);
    const v = verb.toLowerCase();
    if (v === "" || v === "estado" || v === "status") return this.statusText(rt, await p.now());
    if (v === "ayuda" || v === "help" || v === "-h" || v === "--help") return HELP;
    if (v === "pausa" || v === "pause" || v === "reanuda" || v === "resume") {
      rt.paused = v === "pausa" || v === "pause";
      await p.store.set(KEYS.paused, rt.paused);
      if (!rt.paused) await this.schedule(p, rt);
      return rt.paused ? "Nod en pausa: los eventos se guardan en la cola y no se entregan (/nod reanuda)." : "Nod entrega de nuevo lo que tenga en cola.";
    }
    if (v === "privacidad" || v === "privacy") {
      const want = rest[0]?.toLowerCase();
      if (want === void 0) return `privacidad en este perfil: ${rt.privacy}
  ${PRIVACY_HELP}`;
      if (!PRIVACY_LEVELS.includes(want)) return `privacidad "${want}" no existe.
  ${PRIVACY_HELP}`;
      if ((await p.env()).NOD_PRIVACY) return `NOD_PRIVACY=${rt.privacy} manda en este entorno: qu\xEDtala para elegir con /nod privacidad.`;
      if (isStricter(rt.config.privacy, want)) return `la configuraci\xF3n (${rt.config.source}) fija ${rt.config.privacy} en este perfil: /nod privacidad solo puede endurecerla.`;
      rt.privacy = want;
      await p.store.set(KEYS.privacy, rt.privacy);
      await this.restrictQueues(p, rt);
      const blocked = rt.outboxes.filter((o) => !sinkAllowed(rt.privacy, o.sink)).map((o) => o.sink.target);
      return `privacidad en este perfil: ${rt.privacy}` + (blocked.length > 0 ? `
  no se entregar\xE1 a (no son locales): ${blocked.join(", ")}` : "");
    }
    if (v === "tarea" || v === "task") {
      if (rest.length === 0) return this.norm.task === void 0 ? "sin tarea: /nod tarea <id> [t\xEDtulo]" : `tarea: ${this.norm.task}`;
      const clear = rest.length === 1 && /^(fin|ninguna|none|clear|-)$/i.test(rest[0]);
      const id = clear ? void 0 : rest[0];
      const title = clear || rest.length < 2 ? void 0 : rest.slice(1).join(" ");
      if (rt.config.enabled) await this.guard(p, "task.set", async (at) => this.norm.setTask(at, this.session ?? session, id, title, "command"));
      else this.norm.task = id;
      return id === void 0 ? "tarea cerrada: lo que sigue no se asocia a ninguna" : `tarea: ${id}${title ? ` (${title})` : ""}. Todo lo que siga en esta sesi\xF3n cuenta para ella.`;
    }
    return USAGE;
  }
  statusText(rt, now) {
    const s = this.stats;
    const ago = (at) => at === void 0 ? "nunca" : `hace ${Math.max(0, Math.round((now - at) / 1e3))} s`;
    const tok = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n);
    const lines = [
      rt.config.enabled ? rt.paused ? "en pausa (los eventos esperan en la cola: /nod reanuda)" : "observando" : "desactivado (NOD_OFF=1)",
      `  instancia ${rt.config.instance} \xB7 perfil ${rt.info.profile} \xB7 privacidad ${rt.privacy}${this.norm.task ? ` \xB7 tarea ${this.norm.task}` : ""}`,
      `  configuraci\xF3n: ${rt.config.source}`,
      "  destinos:"
    ];
    if (rt.outboxes.length === 0) lines.push("    ninguno (define NOD_SINKS o el fichero de configuraci\xF3n)");
    for (const o of rt.outboxes) {
      const st = o.status();
      const blocked = !sinkAllowed(rt.privacy, o.sink);
      lines.push(`    ${st.kind === "file" ? "fichero" : "http"} ${st.target}${blocked ? " (bloqueado por privacidad trabajo)" : ""}`);
      lines.push(`      entregados ${st.sent}, en cola ${st.queued}, perdidos ${st.dropped}; \xFAltimo \xE9xito ${ago(st.lastOkAt)}${st.lastError ? `; \xFAltimo error ${st.lastError} (${ago(st.lastErrorAt)})` : ""}`);
    }
    lines.push(
      "  esta sesi\xF3n:",
      `    ${s.turns} turnos (${s.aborted} interrumpidos), ${s.steps} llamadas al modelo, ${s.agents} subagentes, ${s.prompts} prompts (${s.revised} reescritos)`,
      `    tokens: ${tok(s.usage.input)} entrada, ${tok(s.usage.output)} salida, ${tok(s.usage.cache_read)} de cach\xE9`,
      `    permisos: ${s.asks} preguntados, ${s.denied} negados, ${Math.round(s.userWaitMs / 1e3)} s esper\xE1ndote`
    );
    const u = s.lastUsage;
    if (u?.context?.percent !== void 0) lines.push(`    contexto: ${u.context.percent}% de ${tok(u.context.window ?? 0)}`);
    for (const l of u?.limits ?? []) lines.push(`    l\xEDmite ${l.kind === "five_hour" ? "5 h" : l.kind === "seven_day" ? "7 d\xEDas" : l.kind}: ${l.percent_used}%${renews(l.resets_at, now)}`);
    if (u?.cost_usd !== void 0) lines.push(`    costo: ${u.cost_usd.toFixed(2)} USD`);
    for (const w of rt.warnings) lines.push(`  aviso: ${w}`);
    return lines.join("\n");
  }
};
function renews(at, now) {
  const t = at === void 0 ? NaN : Date.parse(at);
  if (!Number.isFinite(t)) return "";
  const min = Math.max(0, Math.round((t - now) / 6e4));
  const d = Math.floor(min / 1440);
  const h = Math.floor(min % 1440 / 60);
  const m = min % 60;
  const parts = d > 0 ? [`${d} d`, `${h} h`] : h > 0 ? [`${h} h`, `${m} min`] : [`${m} min`];
  return ` (se renueva en ${parts.join(" ")})`;
}
var HTTP_TIMEOUT_MS = 1e4;
var CLOSE_TIMEOUT_MS = 3e3;
function within(p, ms, work) {
  return new Promise((resolve, reject) => {
    const timer = p.after(ms, () => resolve(void 0));
    work.then(
      (v) => {
        timer.cancel();
        resolve(v);
      },
      (err) => {
        timer.cancel();
        reject(err);
      }
    );
  });
}
function randomHex(n) {
  const c = globalThis.crypto;
  const bytes = c?.getRandomValues ? c.getRandomValues(new Uint8Array(n)) : Uint8Array.from({ length: n }, () => Math.floor(Math.random() * 256));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
var PRIVACY_HELP = "completo: todo (texto, comandos, rutas) \xB7 redactado: sin texto ni rutas \xB7 trabajo: redactado y solo destinos locales";
var HELP = [
  "Nod observa tus sesiones y entrega eventos Nod v1 a tus destinos (fichero, collector, Orbit\u2026).",
  "  /nod                      estado: destinos, cola y cifras de esta sesi\xF3n",
  "  /nod tarea <id> [t\xEDtulo]  asocia lo que sigue a una tarea (historia, ticket); /nod tarea fin la cierra",
  "  /nod privacidad <nivel>   completo, redactado o trabajo (solo destinos locales), en este perfil",
  "  /nod pausa \xB7 reanuda      deja de entregar (guarda en cola) y vuelve a entregar",
  "Configuraci\xF3n: NOD_SINKS, NOD_PRIVACY, NOD_TASK\u2026 o ~/.config/nod/config.json (README)."
].join("\n");

// src/hosts/claude/register.ts
var nod = new NodEngine();
var env;
var info;
var sessionId;
var madeDirs = /* @__PURE__ */ new Set();
var REJECTED_RE = /^(Error: )?The user doesn't want to proceed with this tool use/;
async function readEnv($) {
  return {
    NOD_SINKS: await $.env.get("NOD_SINKS"),
    NOD_TOKEN: await $.env.get("NOD_TOKEN"),
    NOD_PRIVACY: await $.env.get("NOD_PRIVACY"),
    NOD_INSTANCE: await $.env.get("NOD_INSTANCE"),
    NOD_TASK: await $.env.get("NOD_TASK"),
    NOD_CONFIG: await $.env.get("NOD_CONFIG"),
    NOD_OFF: await $.env.get("NOD_OFF"),
    HOME: await $.env.get("HOME"),
    XDG_CONFIG_HOME: await $.env.get("XDG_CONFIG_HOME"),
    XDG_STATE_HOME: await $.env.get("XDG_STATE_HOME")
  };
}
function profileOf(configDir) {
  const d = (configDir ?? "").replace(/\/+$/, "");
  if (d === "") return "claude";
  const b = d.slice(d.lastIndexOf("/") + 1);
  return b === ".claude" || b === "" ? "claude" : b;
}
async function readInfo($) {
  const version = await Promise.resolve().then(() => $.session.version()).catch(() => void 0);
  const host = await $.process.run(["hostname", "-s"]).catch(() => void 0);
  const machine = typeof host?.stdout === "string" ? host.stdout.trim() : "";
  const out = { host: "claude", profile: profileOf(await $.env.get("CLAUDE_CONFIG_DIR")) };
  const v = typeof version === "string" ? version : version?.version;
  if (typeof v === "string") out.hostVersion = v;
  if (machine !== "") out.machine = machine;
  return out;
}
function platform($) {
  return {
    info: () => info ??= readInfo($).catch((err) => {
      info = void 0;
      throw err;
    }),
    env: () => env ??= readEnv($).catch((err) => {
      env = void 0;
      throw err;
    }),
    now: async () => Number(await $.clock.now()),
    after: (ms, cb) => $.clock.after(ms, cb),
    fetch: async (url, init) => {
      const r = await $.http.fetch(url, init);
      return { status: r.status, ok: r.ok, text: String(r.text ?? "") };
    },
    store: {
      get: (key) => $.store.get(key),
      set: (key, value) => value === null ? $.store.delete(key) : $.store.set(key, value)
    },
    read: async (path) => String(await $.fs.read(path)),
    append: async (path, text) => {
      const dir = path.slice(0, path.lastIndexOf("/"));
      if (dir !== "" && !madeDirs.has(dir)) {
        await $.process.run(["mkdir", "-p", dir]);
        madeDirs.add(dir);
      }
      const r = await $.process.run(["tee", "-a", path], { stdin: text });
      const code = r?.exitCode ?? r?.code ?? 0;
      if (code !== 0) throw new Error(`tee sali\xF3 con ${code}: ${String(r?.stderr ?? "").trim()}`);
    },
    log: (message) => $.ui.log(message, { to: "debug" })
  };
}
async function currentSession($) {
  sessionId ??= String(await $.session.id());
  return sessionId;
}
var opt = (v) => typeof v === "string" && v !== "" ? v : void 0;
async function sessionInfo($, e) {
  const repo = await Promise.resolve().then(() => $.session.repo()).catch(() => void 0);
  const model = await Promise.resolve().then(() => $.session.model()).catch(() => void 0);
  return {
    cwd: opt(e?.cwd),
    repo: repo && typeof repo === "object" ? { root: repo.root ?? null, remote: repo.remote ?? null, name: repo.name ?? null } : void 0,
    model: opt(model),
    interactive: e?.isInteractive === true,
    surface: opt(e?.surface)
  };
}
async function usageSnapshot($) {
  const u = await Promise.resolve().then(() => $.session.usage()).catch(() => void 0);
  if (u === void 0 || u === null) return void 0;
  const out = {};
  if (u.context && typeof u.context.window === "number") out.context = { tokens: u.context.tokens, window: u.context.window, percent: u.context.percent };
  if (Array.isArray(u.rateLimits)) {
    out.limits = u.rateLimits.filter((l) => typeof l?.kind === "string" && typeof l?.percentUsed === "number").map((l) => ({ kind: l.kind, percent_used: l.percentUsed, ...typeof l.resetsAt === "string" ? { resets_at: l.resetsAt } : {} }));
  }
  if (u.cost && typeof u.cost.usd === "number") out.cost_usd = u.cost.usd;
  return out;
}
function toolInput(e) {
  const { tool: _t, tool_use_id: _i, agentId: _a, ...input } = e ?? {};
  return input;
}
function register(on, _options) {
  on("session.start", async ($, e, next) => {
    try {
      await $.command.register({ name: "nod", description: COMMAND_DESCRIPTION });
      sessionId = String(await $.session.id());
      await nod.sessionStart(platform($), sessionId, await sessionInfo($, e));
    } catch (err) {
      $.ui.log(`nod: session.start fall\xF3 (${String(err)})`, { to: "debug" });
    }
    return next(e);
  }).catch((_$, e, next) => next(e));
  on("command.run", { command: "nod" }, async ($, e) => ({ text: await nod.runCommand(platform($), await currentSession($), String(e.args ?? "")) }));
  on("command.run", async ($, e, next) => {
    if (typeof e?.command === "string" && e.command !== "nod") void nod.command(platform($), await currentSession($), e.command);
    return next(e);
  }).catch((_$, e, next) => next(e));
  on("prompt.edit", async ($, e, next) => {
    await nod.promptEdit(platform($), {
      before: String(e?.text ?? ""),
      start: Number(e?.start) || 0,
      end: Number(e?.end) || 0,
      inserted: String(e?.inputText ?? "")
    });
    return next(e);
  }).catch((_$, e, next) => next(e));
  on("prompt.submit", async ($, e, next) => {
    void nod.promptSubmit(platform($), await currentSession($), String(e?.text ?? ""), opt(e?.origin?.kind) ?? "unknown");
    return next(e);
  }).catch((_$, e, next) => next(e));
  on("turn.start", async ($, e, next) => {
    if (typeof e?.turnId === "string") await nod.turnStart(platform($), await currentSession($), e.turnId, opt(e.agentId));
    return next(e);
  }).catch((_$, e, next) => next(e));
  on("turn.step", async function* ($, e, next) {
    if (typeof e?.turnId === "string") void nod.stepBegin(platform($), e.turnId, opt(e.agentId));
    const out = yield* next(e);
    if (typeof e?.turnId === "string") {
      await nod.step(platform($), await currentSession($), {
        turn: e.turnId,
        agent: opt(e.agentId),
        index: Number(e.index) || 0,
        model: opt(e.model),
        effort: opt(e.effort),
        stopReason: opt(out?.stopReason),
        tools: Array.isArray(out?.toolUses) ? out.toolUses.map((t) => String(t?.name ?? "?")) : [],
        usage: usageOf(out?.usage)
      });
    }
    return out;
  }).catch(async function* (_$, e, next) {
    return yield* next(e);
  });
  on("turn.complete", async ($, e, next) => {
    const out = await next(e);
    if (typeof e?.turnId === "string") {
      await nod.turnEnd(platform($), await currentSession($), {
        turn: e.turnId,
        agent: opt(e.agentId),
        durationMs: typeof e.durationMs === "number" ? e.durationMs : void 0,
        outcome: e.isAborted === true ? "aborted" : opt(e.reason) ?? "answer",
        usage: usageOf(e.usage),
        answer: typeof e.answer === "string" ? e.answer : void 0
      }, () => usageSnapshot($));
    }
    return out;
  }).catch((_$, e, next) => next(e));
  on("tool.call", async ($, e, next) => {
    const session = await currentSession($);
    const id = opt(e?.tool_use_id);
    const tool = String(e?.tool ?? "?");
    if (id !== void 0) void nod.toolCall(platform($), session, { toolUseId: id, tool, input: toolInput(e), agent: opt(e.agentId) });
    const out = await next(e);
    if (id !== void 0) {
      const text = typeof out?.text === "string" ? out.text : typeof out?.result === "string" ? out.result : "";
      const rejected = out?.isError === true && REJECTED_RE.test(typeof out?.result === "string" ? out.result : text);
      void nod.toolResult(platform($), session, { toolUseId: id, tool, ok: out?.isError !== true, rejected, outputChars: text.length });
    }
    return out;
  }).catch((_$, e, next) => next(e));
  on("tool.check", async ($, e, next) => {
    const started = $.clock.now();
    const verdict = await next(e);
    const id = opt(e?.tool_use_id);
    const d = verdict?.decision;
    if (id !== void 0 && (d === "allow" || d === "deny" || d === "ask")) {
      const checkMs = Math.max(0, Number(await $.clock.now()) - Number(await started));
      void nod.toolCheck(platform($), await currentSession($), id, String(e?.tool ?? "?"), d, opt(verdict?.reason), checkMs);
    }
    return verdict;
  }).catch((_$, e, next) => next(e));
  on("classic.PostToolUse", async ($, e, next) => {
    if (typeof e?.tool_use_id === "string" && typeof e?.duration_ms === "number") void nod.toolExec(platform($), e.tool_use_id, e.duration_ms);
    return next(e);
  }).catch((_$, e, next) => next(e));
  on("agent.spawn", async ($, e, next) => {
    const out = await next(e);
    const agent = opt(out?.agentId);
    if (agent !== void 0) {
      void nod.agentSpawn(platform($), await currentSession($), {
        agent,
        type: opt(e?.subagentType) ?? "agent",
        description: opt(e?.description),
        background: e?.background === true,
        fork: typeof e?.fork === "boolean" ? e.fork : void 0,
        permissionMode: opt(e?.permissionMode),
        model: opt(out?.model),
        toolUseId: opt(e?.tool_use_id)
      });
    }
    return out;
  }).catch((_$, e, next) => next(e));
  on("session.end", async ($, e, next) => {
    await nod.sessionEnd(platform($), opt(e?.sessionId) ?? await currentSession($), opt(e?.reason) ?? "exit");
    sessionId = void 0;
    return next(e);
  }).catch((_$, e, next) => next(e));
}
export {
  profileOf,
  register
};
