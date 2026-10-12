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
var HOLD_MS_DEFAULT = 2e4;
var HOLD_MS_MIN = 1e3;
var HOLD_MS_MAX = 9e4;
var INSTANCE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
function configPath(env2) {
  if (env2.NOD_CONFIG) return expandHome(env2.NOD_CONFIG, env2.HOME);
  if (env2.XDG_CONFIG_HOME) return `${env2.XDG_CONFIG_HOME}/nod/config.json`;
  return env2.HOME ? `${env2.HOME}/.config/nod/config.json` : void 0;
}
function defaultLogPath(env2) {
  const dir = stateDir(env2);
  return dir === void 0 ? void 0 : `${dir}/events.jsonl`;
}
function stateDir(env2) {
  if (env2.XDG_STATE_HOME) return `${env2.XDG_STATE_HOME}/nod`;
  return env2.HOME ? `${env2.HOME}/.local/state/nod` : void 0;
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
    if (typeof parsed === "string") {
      warnings.push(`${where}: ${parsed}`);
      continue;
    }
    if (typeof o?.token_file === "string" && parsed.kind === "http") {
      if (parsed.token !== void 0) warnings.push(`${where}: ${parsed.target} tiene "token" y "token_file": uso "token"`);
      else parsed.tokenFile = expandHome(o.token_file, home);
    }
    out.push(parsed);
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
  const control = controlFrom(env2, section.control ?? file.control, warnings, String(path));
  return { config: { enabled: env2.NOD_OFF !== "1", instance, privacy, sinks, task, control, source }, warnings };
}
var OFF_RE = /^(off|0|no|false)$/i;
function controlFrom(env2, raw, warnings, where) {
  const fromEnv = env2.NOD_CONTROL?.trim();
  if (fromEnv !== void 0 && OFF_RE.test(fromEnv)) return void 0;
  const o = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : void 0;
  if (raw !== void 0 && o === void 0) warnings.push(`${where}: "control" debe ser un objeto`);
  const url = fromEnv || (typeof o?.url === "string" ? o.url : void 0);
  if (url === void 0) return void 0;
  const label = fromEnv ? "NOD_CONTROL" : `${where} (control)`;
  const parsed = parseSink(url, env2.HOME);
  if (typeof parsed === "string" || parsed.kind !== "http") {
    warnings.push(`${label}: el controlador debe ser una URL http(s) sin usuario, contrase\xF1a ni par\xE1metros`);
    return void 0;
  }
  const c = { url: parsed.target, holdMs: HOLD_MS_DEFAULT };
  if (env2.NOD_CONTROL_TOKEN) c.token = env2.NOD_CONTROL_TOKEN;
  else if (typeof o?.token === "string" && o.token !== "") c.token = o.token;
  else if (typeof o?.token_file === "string" && o.token_file !== "") c.tokenFile = expandHome(o.token_file, env2.HOME);
  if (o?.hold_ms !== void 0) {
    const n = Number(o.hold_ms);
    if (!Number.isFinite(n)) warnings.push(`${label}: hold_ms "${String(o.hold_ms)}" no es un n\xFAmero: uso ${HOLD_MS_DEFAULT}`);
    else {
      c.holdMs = Math.min(HOLD_MS_MAX, Math.max(HOLD_MS_MIN, Math.round(n)));
      if (c.holdMs !== n) warnings.push(`${label}: hold_ms debe estar entre ${HOLD_MS_MIN} y ${HOLD_MS_MAX}: uso ${c.holdMs}`);
    }
  }
  if ((c.token !== void 0 || c.tokenFile !== void 0) && !c.url.startsWith("https://") && !isLocalUrl(c.url)) {
    c.off = `el token no se manda en claro a ${c.url} (usa https)`;
    warnings.push(`control: ${c.off}`);
  }
  return c;
}
function controlBlocked(c, privacy) {
  if (c === void 0) return "sin configurar";
  if (c.off !== void 0) return c.off;
  if (privacy === "trabajo" && !isLocalUrl(c.url)) return "privacidad trabajo y el controlador no es local";
  return void 0;
}
async function loadTokenFiles(config, read, warnings) {
  const load = async (path) => {
    try {
      const t = (await read(path)).trim();
      if (t !== "") return t;
      warnings.push(`token_file ${path} est\xE1 vac\xEDo`);
    } catch {
      warnings.push(`token_file ${path} no se puede leer`);
    }
    return void 0;
  };
  for (const s of config.sinks) if (s.tokenFile !== void 0 && s.token === void 0) s.token = await load(s.tokenFile);
  const c = config.control;
  if (c?.tokenFile !== void 0 && c.token === void 0) {
    c.token = await load(c.tokenFile);
    if (c.token === void 0) c.off ??= `no se pudo leer el token (${c.tokenFile})`;
  }
}
function defaultInstance(profile, anonId) {
  const clean2 = (x) => x.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  const id = clean2(anonId).slice(0, 16) || "0";
  const p = (clean2(profile) || "claude").slice(0, 63 - id.length);
  return `${p}-${id}`;
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
  const bytes = isBytes(value);
  const ofLen = length !== void 0 ? ` of length ${length}` : "";
  const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
  const message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes)
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
var aobject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError((label === "object" ? "" : `"${label}" `) + "expected object, got type=" + typeof value);
};
var aopts = (value, label) => {
  aobject(value, label);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError(`"${label}" expected plain object`);
  if (Object.hasOwn(value, "__proto__"))
    throw new TypeError(`"${label}.__proto__" is not allowed`);
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
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
var hasHexBuiltin = /* @__PURE__ */ (() => (
  // @ts-ignore
  typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
))();
var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex(bytes) {
  abytes(bytes);
  if (hasHexBuiltin)
    return bytes.toHex();
  let hex2 = "";
  for (let i = 0; i < bytes.length; i++) {
    hex2 += hexes[bytes[i]];
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
function createHasher(hashCons, info2 = {}) {
  if (typeof hashCons !== "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof hashCons);
  info2 = checkOpts({}, info2, "info");
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(void 0);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.canXOF = tmp.canXOF;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info2);
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
function bytesToNumberBE(bytes) {
  return hexToNumber(bytesToHex(bytes));
}
function bytesToNumberLE(bytes) {
  return hexToNumber(bytesToHex(copyBytes(abytes(bytes)).reverse()));
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
function copyBytes(bytes) {
  return Uint8Array.from(abytes2(bytes));
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
    const label = title === "object" ? `param "${String(fieldName)}"` : `"${title}.${String(fieldName)}"`;
    const val = object[fieldName];
    if (!Object.hasOwn(object, fieldName) && (isOpt ? val !== void 0 : expectedType !== "function")) {
      throw new TypeError(`${label} is invalid: expected own property`);
    }
    if (isOpt && val === void 0)
      return;
    const current = typeof val;
    if (current !== expectedType || val === null)
      throw new TypeError(`${label} is invalid: expected ${expectedType}, got ${current}`);
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
function validateField(field2) {
  aobject2(field2, "field");
  if (typeof field2.ORDER !== "bigint")
    throw new TypeError('param "ORDER" is invalid: expected bigint, got ' + typeof field2.ORDER);
  asafenumber(field2.BYTES, "BYTES");
  asafenumber(field2.BITS, "BITS");
  for (const name of FIELD_FIELDS)
    afunction(field2[name], "field." + name);
  if (field2.BYTES < 1 || field2.BITS < 1)
    throw new Error("invalid field: expected BYTES/BITS > 0");
  if (field2.ORDER <= _1n2)
    throw new Error("invalid field: expected ORDER > 1, got " + field2.ORDER);
  return field2;
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
  fromBytes(bytes, skipValidation = false) {
    abytes2(bytes);
    const { _lengths: allowedLengths, BYTES, isLE, ORDER, _mod: modFromBytes } = this;
    if (allowedLengths) {
      if (bytes.length < 1 || !allowedLengths.includes(bytes.length) || bytes.length > BYTES) {
        throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);
      }
      const padded = new Uint8Array(BYTES);
      padded.set(bytes, isLE ? 0 : padded.length - bytes.length);
      bytes = padded;
    }
    if (bytes.length !== BYTES)
      throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
    let scalar = isLE ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
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
  const bytes = numPoints * (4 * fpBytes + 128);
  if (bytes > TABLE_BYTES_MAX)
    throw new Error("invalid window size: table would need ~" + Math.ceil(bytes / 2 ** 20) + " MiB, max " + TABLE_BYTES_MAX / 2 ** 20 + " MiB");
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
function validateMSMScalars(scalars, field2, maxScalar) {
  if (!Array.isArray(scalars))
    throw new Error("array of scalars expected");
  scalars.forEach((s, i) => {
    const ok = maxScalar === void 0 ? field2.isValid(s) : isPosBig(s) && s < maxScalar;
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
function createField(order, field2, isLE) {
  if (field2) {
    if (field2.ORDER !== order)
      throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
    validateField(field2);
    return field2;
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
  toSig(bytes, maxScalarBytes) {
    const { Err: E, _int: int, _tlv: tlv } = _DER;
    if (maxScalarBytes !== void 0) {
      asafenumber(maxScalarBytes, "maxScalarBytes");
      if (maxScalarBytes < 1)
        throw new E("invalid signature: maxScalarBytes must be positive");
    }
    const data = abytes2(bytes, void 0, "signature");
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
  function pointFromBytes(bytes) {
    abytes2(bytes, void 0, "Point");
    const { publicKey: comp, publicKeyUncompressed: uncomp } = lengths;
    const length = bytes.length;
    const head = bytes[0];
    const tail = bytes.subarray(1);
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
    static fromBytes(bytes) {
      const P = Point.fromAffine(decodePoint(abytes2(bytes, void 0, "point")));
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
  function validateSigLength(bytes, format) {
    validateSigFormat(format);
    const size = lengths.signature;
    const sizer = format === "compact" ? size : format === "recovered" ? size + 1 : void 0;
    return abytes2(bytes, sizer);
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
    static fromBytes(bytes, format = defaultSigOpts.format) {
      validateSigLength(bytes, format);
      let recid;
      if (format === "der") {
        if (bytes.length > 2 * Fn.BYTES + 16)
          throw new DER.Err("invalid signature: DER signature too long");
        const { r: r2, s: s2 } = DER.toSig(abytes2(bytes), Fn.BYTES + 1);
        return new Signature(r2, s2);
      }
      if (format === "recovered") {
        recid = bytes[0];
        format = "compact";
        bytes = bytes.subarray(1);
      }
      const L = lengths.signature / 2;
      const r = bytes.subarray(0, L);
      const s = bytes.subarray(L, L * 2);
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
  const bits2int = opts.bits2int === void 0 ? function bits2int_def(bytes) {
    if (bytes.length > 8192)
      throw new Error("input is too large");
    const num = bytesToNumberBE(bytes);
    const delta = bytes.length * 8 - fnBits;
    return delta > 0 ? num >> BigInt(delta) : num;
  } : opts.bits2int;
  const bits2int_modN = opts.bits2int_modN === void 0 ? function bits2int_modN_def(bytes) {
    return Fn.create(bits2int(bytes));
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

// src/core/control/cbor.ts
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

// src/core/control/crypto.ts
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
var KID_LEN = 8;
var SIG_LEN = 64;
var ID_LEN = 16;
var SID_LEN = 16;
var PAIR_K_LEN = 32;
var TAG_LEN = 32;
var utf82 = new TextEncoder();
function utf8Len(s) {
  return utf82.encode(s).length;
}
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function b64u(bytes) {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
    out += B64[n >> 18 & 63] + B64[n >> 12 & 63] + B64[n >> 6 & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64[n >> 18 & 63] + B64[n >> 12 & 63];
  } else if (rest === 2) {
    const n = bytes[i] << 16 | bytes[i + 1] << 8;
    out += B64[n >> 18 & 63] + B64[n >> 12 & 63] + B64[n >> 6 & 63];
  }
  return out;
}
function fromB64u(s) {
  if (s.length % 4 === 1) throw new Error("base64url: longitud inv\xE1lida");
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error("base64url: car\xE1cter inv\xE1lido");
    acc = (acc << 6 | v) & 65535;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push(acc >> bits & 255);
    }
  }
  if (bits > 0 && (acc & (1 << bits) - 1) !== 0) throw new Error("base64url: bits sobrantes");
  return Uint8Array.from(out);
}
function hex(b) {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function fromHex(s) {
  if (!/^(?:[0-9a-f]{2})*$/i.test(s)) throw new Error("hex inv\xE1lido");
  return Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
}
function sameBytes(a, b) {
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
  return sha2562(spki).slice(0, KID_LEN);
}
function spkiPoint(spki) {
  if (spki.length !== SPKI_LEN) throw new Error(`SPKI de ${spki.length} bytes (se esperaban ${SPKI_LEN})`);
  if (!sameBytes(spki.subarray(0, SPKI_PREFIX.length), SPKI_PREFIX)) throw new Error("SPKI que no es P-256 sin comprimir");
  const point = spki.slice(SPKI_PREFIX.length);
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
    if (sig.length !== SIG_LEN) return false;
    const r = bigOf(sig.subarray(0, 32));
    const s = bigOf(sig.subarray(32));
    if (r === 0n || s === 0n || r >= P256_N || s > P256_N >> 1n) return false;
    return curve.verify(sig, msg, spkiPoint(spki), { lowS: true, prehash: true, format: "compact" }) === true;
  } catch {
    return false;
  }
}
function hmacSha256(key, msg) {
  const B = 64;
  const k = new Uint8Array(B);
  k.set(key.length > B ? sha2562(key) : key);
  const inner = new Uint8Array(B + msg.length);
  const outer = new Uint8Array(B + 32);
  for (let i = 0; i < B; i++) {
    inner[i] = k[i] ^ 54;
    outer[i] = k[i] ^ 92;
  }
  inner.set(msg, B);
  outer.set(sha2562(inner), B);
  return sha2562(outer);
}
function approvalInput(a) {
  return encode(["nod-approval", 1, a.instance, a.id, a.toolUseId, a.tool, a.summary, a.wok, a.exp]);
}
function approvalHash(a) {
  return sha2562(approvalInput(a));
}
function decisionInput(id, toolUseId, decision, ts, ah) {
  return encode(["nod-decision", 1, id, toolUseId, decision, ts, ah]);
}
function sessionSid(instance, session) {
  return sha2562(encode(["nod-session", 1, instance, session])).slice(0, SID_LEN);
}
function messageInput(id, ts, instance, sid, kind, text) {
  return encode(["nod-message", 1, id, ts, instance, sid, kind, text]);
}
function pairInput(instance, spki) {
  return encode(["nod-pair", 1, instance, spki]);
}
function pairTag(k, instance, spki) {
  return hmacSha256(k, pairInput(instance, spki));
}
function verifyPairTag(k, instance, spki, tag) {
  if (k.length !== PAIR_K_LEN || tag.length !== TAG_LEN) return false;
  return sameBytes(pairTag(k, instance, spki), tag);
}

// src/core/control/approvers.ts
var TEST_KIDS = ["b4aa8c3df3915b83", "aa4a84512345fdd0"];
var MAX_APPROVERS = 16;
var NAME_MAX = 64;
function isTestKid(kid) {
  return TEST_KIDS.includes(hex(kid));
}
function parseApprovers(text) {
  const out = { entries: [], keys: [], ignored: [] };
  if (text === void 0 || text.trim() === "") return out;
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    out.ignored.push("approvers.json no es JSON");
    return out;
  }
  const list = v !== null && typeof v === "object" && v.v === 1 ? v.keys : void 0;
  if (!Array.isArray(list)) {
    out.ignored.push('approvers.json no tiene el formato {"v":1,"keys":[\u2026]}');
    return out;
  }
  for (const item of list) {
    const e = item;
    if (typeof e?.kid !== "string" || typeof e.spki !== "string") {
      out.ignored.push("entrada sin kid o spki");
      continue;
    }
    let spki;
    let kid;
    try {
      spki = fromB64u(e.spki);
      spkiPoint(spki);
      kid = fromB64u(e.kid);
    } catch (err) {
      out.ignored.push(`${e.kid}: ${String(err)}`);
      continue;
    }
    if (kid.length !== KID_LEN || !sameBytes(kid, kidOf(spki))) {
      out.ignored.push(`${e.kid}: el kid no es el de su llave`);
      continue;
    }
    if (isTestKid(kid)) {
      out.ignored.push(`${e.kid}: llave de prueba (su clave privada es p\xFAblica)`);
      continue;
    }
    if (out.keys.some((k) => sameBytes(k.kid, kid)) || out.keys.length >= MAX_APPROVERS) continue;
    const entry = { kid: e.kid, spki: e.spki, added_ms: typeof e.added_ms === "number" ? e.added_ms : 0 };
    if (typeof e.name === "string" && e.name !== "") entry.name = e.name.slice(0, NAME_MAX);
    out.entries.push(entry);
    out.keys.push({ kid, spki, name: entry.name });
  }
  return out;
}
function addApprover(entries, spki, name, now) {
  try {
    spkiPoint(spki);
  } catch (err) {
    return { error: String(err) };
  }
  const kid = kidOf(spki);
  if (isTestKid(kid)) return { error: "llave de prueba: su clave privada es p\xFAblica" };
  const entry = { kid: b64u(kid), spki: b64u(spki), added_ms: now };
  const clean2 = cleanName(name);
  if (clean2 !== void 0) entry.name = clean2;
  const rest = entries.filter((e) => e.kid !== entry.kid);
  if (rest.length >= MAX_APPROVERS) return { error: `ya hay ${MAX_APPROVERS} llaves emparejadas: quita alguna con /nod aprobadores quitar <kid>` };
  return { file: { v: 1, keys: [...rest, entry] }, entry };
}
function removeApprover(entries, kid) {
  const want = normalizeKid(kid);
  if (want === void 0) return void 0;
  const removed = entries.find((e) => e.kid === want);
  if (removed === void 0) return void 0;
  return { file: { v: 1, keys: entries.filter((e) => e !== removed) }, removed };
}
function normalizeKid(kid) {
  const s = kid.trim();
  try {
    if (/^[0-9a-f]{16}$/i.test(s)) return b64u(fromHex(s.toLowerCase()));
    const b = fromB64u(s);
    return b.length === KID_LEN ? s : void 0;
  } catch {
    return void 0;
  }
}
function cleanName(name) {
  if (typeof name !== "string") return void 0;
  const s = name.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  return s === "" ? void 0 : s;
}

// src/core/control/forbidden.ts
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
function approvable(tool, input, rules) {
  return matchForbidden(forbiddenSubject(tool, input), rules) === void 0;
}
function forbiddenRules(add) {
  const text = (add ?? "").trim();
  if (text === "") return { ok: true, rules: [...DEFAULT_FORBIDDEN] };
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    return { ok: false, error: "NOD_FORBIDDEN_ADD debe ser un array JSON de expresiones regulares" };
  }
  if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) return { ok: false, error: "NOD_FORBIDDEN_ADD debe ser un array JSON de expresiones regulares" };
  const rules = [...DEFAULT_FORBIDDEN];
  for (const [i, p] of list.entries()) {
    try {
      rules.push({ name: `propia-${i}`, re: new RegExp(p) });
    } catch (err) {
      return { ok: false, error: `NOD_FORBIDDEN_ADD: regex inv\xE1lida ${JSON.stringify(p)} (${String(err)})` };
    }
  }
  return { ok: true, rules };
}

// src/core/control/io.ts
var CALL_TIMEOUT_MS = 3e3;
function headers(c, json) {
  const h = {};
  if (c.token) h.authorization = `Bearer ${c.token}`;
  if (json) h["content-type"] = "application/json";
  return h;
}
function call(io, ms, url, init) {
  return within(io, ms, io.fetch(url, init).catch(() => void 0));
}
function within(io, ms, work) {
  return new Promise((resolve) => {
    const timer = io.after(ms, () => resolve(void 0));
    work.then(
      (v) => {
        timer.cancel();
        resolve(v);
      },
      () => {
        timer.cancel();
        resolve(void 0);
      }
    );
  });
}
function sleep(io, ms) {
  return new Promise((resolve) => void io.after(ms, () => resolve()));
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}

// src/core/control/verify.ts
var DECISION_SKEW_SEC = 30;
var MESSAGE_WINDOW_SEC = 120;
var MESSAGE_MAX_TEXT_BYTES = 1e3;
var isUint = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
function bytesOf(v, len) {
  if (typeof v !== "string") return void 0;
  try {
    const b = fromB64u(v);
    return b.length === len ? b : void 0;
  } catch {
    return void 0;
  }
}
function keyFor(kid, keys) {
  return keys.find((k) => sameBytes(k.kid, kid) && sameBytes(kidOf(k.spki), kid));
}
function verifyDecision(pending, raw, keys, now, resolved = false) {
  const d = raw !== null && typeof raw === "object" ? raw : void 0;
  const decision = d?.decision;
  const ts = d?.ts;
  const kid = bytesOf(d?.kid, KID_LEN);
  const sig = bytesOf(d?.sig, SIG_LEN);
  if (decision !== "allow" && decision !== "deny" || !isUint(ts) || kid === void 0 || sig === void 0) return { ok: false, reason: "malformed" };
  if (resolved) return { ok: false, reason: "replay" };
  const key = keyFor(kid, keys);
  if (key === void 0) return { ok: false, reason: "kid" };
  const input = decisionInput(pending.id, pending.toolUseId, decision, ts, approvalHash(pending));
  if (!verifySignature(key.spki, input, sig)) return { ok: false, reason: "sig" };
  if (ts > pending.exp + DECISION_SKEW_SEC || now > pending.exp) return { ok: false, reason: "expired" };
  if (decision === "allow" && !pending.wok) return { ok: false, reason: "forbidden" };
  return { ok: true, decision, ts, kid: hex(kid) };
}
var MESSAGE_KINDS = ["text", "stop", "recap"];
function verifyMessage(raw, ctx, keys, now, seen) {
  const m = raw !== null && typeof raw === "object" ? raw : void 0;
  const id = bytesOf(m?.id, ID_LEN);
  const ts = m?.ts;
  const sid = bytesOf(m?.sid, SID_LEN);
  const kind = m?.kind;
  const text = m?.text;
  const kid = bytesOf(m?.kid, KID_LEN);
  const sig = bytesOf(m?.sig, SIG_LEN);
  if (id === void 0 || !isUint(ts) || sid === void 0 || kid === void 0 || sig === void 0) return { ok: false, reason: "malformed" };
  if (!MESSAGE_KINDS.includes(kind) || typeof text !== "string" || utf8Len(text) > MESSAGE_MAX_TEXT_BYTES) return { ok: false, reason: "malformed" };
  if (!sameBytes(sid, ctx.sid)) return { ok: false, reason: "sid" };
  const key = keyFor(kid, keys);
  if (key === void 0) return { ok: false, reason: "kid" };
  if (!verifySignature(key.spki, messageInput(id, ts, ctx.instance, ctx.sid, kind, text), sig)) return { ok: false, reason: "sig" };
  if (Math.abs(now - ts) > MESSAGE_WINDOW_SEC) return { ok: false, reason: "expired" };
  const idText = b64u(id);
  if (seen.has(idText)) return { ok: false, reason: "replay" };
  return { ok: true, id: idText, kind, text, kid: hex(kid) };
}

// src/core/control/hold.ts
var RETRY_MS = 500;
var POLL_WAIT_MS = 1e4;
var RESOLVED_GRACE_MS = 3e4;
var RESOLVED_MAX_DELAY_MS = 8e3;
var TOOL_USE_ID_MAX = 128;
var RESOLVED_MEMORY = 256;
function newRace() {
  let resolve;
  const race = {
    done: new Promise((r) => resolve = r),
    settled: false,
    wakers: /* @__PURE__ */ new Set(),
    settle(by, decision) {
      if (race.settled) return;
      race.settled = true;
      resolve({ by, decision: decision ?? "none" });
      for (const w of [...race.wakers]) w();
      race.wakers.clear();
    }
  };
  return race;
}
var Holder = class {
  /** Permisos retenidos ahora, por tool_use_id. */
  active = /* @__PURE__ */ new Set();
  resolved = [];
  /** Última resolución (para /nod). */
  last;
  get holding() {
    return this.active.size;
  }
  isResolved(idHex) {
    return this.resolved.includes(idHex);
  }
  remember(idHex) {
    this.resolved.push(idHex);
    if (this.resolved.length > RESOLVED_MEMORY) this.resolved.shift();
  }
  /** Retiene un permiso preguntado. Nunca lanza. */
  async hold(req, controller, io) {
    if (req.toolUseId === "" || req.toolUseId.length > TOOL_USE_ID_MAX) return { held: false, why: "tool_use_id inv\xE1lido" };
    if (req.signal?.aborted === true) return { held: false, why: "cancelado" };
    if (this.active.has(req.toolUseId)) return { held: false, why: "ya retenido" };
    this.active.add(req.toolUseId);
    const run = new Retention(controller, io, this);
    try {
      const out = await run.run(req);
      this.last = { ...out, toolUseId: req.toolUseId };
      return out;
    } catch (err) {
      run.log(`retenci\xF3n fall\xF3 (${String(err)}): veredicto original`);
      return { held: false, why: String(err) };
    } finally {
      this.active.delete(req.toolUseId);
    }
  }
};
var Retention = class {
  constructor(controller, io, holder) {
    this.controller = controller;
    this.io = io;
    this.holder = holder;
  }
  controller;
  io;
  holder;
  log(m) {
    try {
      this.io.log(`nod control: ${m}`);
    } catch {
    }
  }
  async run(req) {
    const { io, controller } = this;
    const id = await io.random(ID_LEN);
    if (!(id instanceof Uint8Array) || id.length !== ID_LEN) throw new Error("sin 16 bytes aleatorios");
    const start = await io.now();
    const deadline = start + req.holdMs;
    const pending = { instance: req.instance, id, toolUseId: req.toolUseId, tool: req.tool, summary: req.summary, wok: req.wok, exp: Math.floor(deadline / 1e3) };
    const idText = b64u(id);
    const base = `${controller.url}/v1/control/approvals/${idText}`;
    const body = {
      id: idText,
      instance: req.instance,
      session: req.session,
      sid: b64u(sessionSid(req.instance, req.session)),
      tool_use_id: req.toolUseId,
      tool: req.tool,
      summary: req.summary,
      wok: req.wok,
      exp: pending.exp
    };
    if (req.agent !== void 0) body.agent = req.agent;
    const post = io.fetch(`${controller.url}/v1/control/approvals`, { method: "POST", headers: headers(controller, true), body: JSON.stringify(body) }).catch(() => void 0);
    const first = await this.firstOf(post, CALL_TIMEOUT_MS, req.signal);
    if (first === "late" || first === "abort") {
      void post.then((late) => {
        if (late !== void 0 && late.status >= 200 && late.status < 300) this.resolveLater(base, { by: first === "abort" ? "abort" : "error", decision: "none" }, deadline);
      });
      return { held: false, why: first === "abort" ? "cancelado" : `el controlador no contest\xF3 en ${CALL_TIMEOUT_MS / 1e3} s` };
    }
    const r = first.value;
    if (r === void 0) return { held: false, why: "controlador inalcanzable" };
    if (r.status < 200 || r.status >= 300) return { held: false, why: `el controlador respondi\xF3 ${r.status}` };
    const race = newRace();
    const timer = io.after(Math.max(0, deadline - await io.now()), () => race.settle("timeout"));
    const onAbort = () => race.settle("abort");
    const unlisten = listen(req.signal, onAbort);
    if (req.signal?.aborted === true) onAbort();
    const state = { reject: void 0, rejected: 0, gone: false };
    void this.poll(race, req, pending, base, deadline, state).catch((err) => {
      this.log(`long-poll fall\xF3 (${String(err)})`);
      race.settle("error");
    });
    const outcome = await race.done;
    timer.cancel();
    unlisten();
    this.holder.remember(hex(id));
    if (!state.gone) {
      const resolved = { by: outcome.by, decision: outcome.decision };
      if (state.reject !== void 0) resolved.reject = state.reject;
      this.resolveLater(base, resolved, deadline);
    }
    return { held: true, by: outcome.by, decision: outcome.decision, reject: state.reject, rejected: state.rejected };
  }
  /** La respuesta del POST si llega antes del plazo y de la cancelación. */
  firstOf(work, ms, signal) {
    if (signal?.aborted === true) return Promise.resolve("abort");
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        timer.cancel();
        unlisten();
        resolve(v);
      };
      const timer = this.io.after(ms, () => finish("late"));
      const unlisten = listen(signal, () => finish("abort"));
      void work.then((value) => finish({ value }));
    });
  }
  async poll(race, req, pending, base, deadline, state) {
    const { io, controller } = this;
    const seen = /* @__PURE__ */ new Set();
    while (!race.settled) {
      const t0 = await io.now();
      if (t0 >= deadline) return race.settle("timeout");
      const wait = Math.max(1, Math.min(POLL_WAIT_MS, deadline - t0));
      const r = await call(io, wait + CALL_TIMEOUT_MS, `${base}?wait=${wait}`, { method: "GET", headers: headers(controller, false) });
      if (race.settled) return;
      if (r?.status === 404 || r?.status === 410) {
        state.gone = true;
        return race.settle("error");
      }
      let fresh = false;
      if (r?.status === 200) {
        const raw = parseJson(r.text)?.decision;
        const key = JSON.stringify(raw ?? null);
        if (!seen.has(key)) {
          seen.add(key);
          fresh = true;
          const v = verifyDecision(pending, raw, await req.keys(), await io.now() / 1e3, this.holder.isResolved(hex(pending.id)));
          if (race.settled) return;
          if (v.ok) return race.settle("remote", v.decision);
          state.reject = v.reason;
          state.rejected++;
          this.log(`decisi\xF3n descartada para ${req.toolUseId}: ${v.reason}`);
        }
      }
      const t1 = await io.now();
      if (r === void 0 || r.status !== 204 || fresh || t1 - t0 < Math.min(RETRY_MS, wait)) await this.pause(race, Math.max(1, Math.min(RETRY_MS, deadline - t1)));
    }
  }
  pause(race, ms) {
    if (race.settled) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => {
        t.cancel();
        race.wakers.delete(wake);
        resolve();
      };
      race.wakers.add(wake);
      const t = this.io.after(ms, wake);
    });
  }
  /** POST …/resolved en segundo plano; reintenta red caída, 429 y 5xx con espera creciente hasta exp + margen. */
  resolveLater(base, body, deadline, attempt = 0) {
    const { io, controller } = this;
    void call(io, CALL_TIMEOUT_MS, `${base}/resolved`, { method: "POST", headers: headers(controller, true), body: JSON.stringify(body) }).then(async (r) => {
      if (r !== void 0 && (r.status < 500 && r.status !== 429)) return;
      const delay = Math.min(RESOLVED_MAX_DELAY_MS, 1e3 * 2 ** attempt);
      if (await io.now() + delay > deadline + RESOLVED_GRACE_MS) {
        this.log(`/resolved sin entregar: el controlador lo cerrar\xE1 por plazo`);
        return;
      }
      io.after(delay, () => this.resolveLater(base, body, deadline, attempt + 1));
    }).catch(() => void 0);
  }
};
function listen(signal, cb) {
  if (signal === void 0 || typeof signal.addEventListener !== "function") return () => void 0;
  try {
    signal.addEventListener("abort", cb);
  } catch {
    return () => void 0;
  }
  return () => {
    try {
      signal.removeEventListener?.("abort", cb);
    } catch {
    }
  };
}

// src/core/control/messages.ts
var RECAP_PROMPT = "Detente aqu\xED. Resume en pocas l\xEDneas en qu\xE9 estabas, qu\xE9 has hecho hasta ahora y qu\xE9 te bloquea o qu\xE9 necesitas de m\xED. No sigas trabajando hasta que te responda.";
var CONTEXT_PREFIX = "Mensaje del usuario desde fuera del terminal (Nod Control), mientras trabajas: ";
function messagePlan(kind, text, turnActive) {
  switch (kind) {
    case "text":
      if (text.trim() === "") return { abort: false };
      return turnActive ? { abort: false, note: text } : { abort: false, submitNow: text };
    case "stop":
      return { abort: turnActive };
    case "recap": {
      const prompt = text.trim() === "" ? RECAP_PROMPT : text;
      return turnActive ? { abort: true, submitAfterTurn: prompt } : { abort: false, submitNow: prompt };
    }
  }
}
var Notes = class {
  notes = [];
  push(text) {
    this.notes.push(text);
  }
  get size() {
    return this.notes.length;
  }
  takeContext() {
    if (this.notes.length === 0) return void 0;
    const t = this.notes.map((n) => CONTEXT_PREFIX + n).join("\n");
    this.notes = [];
    return t;
  }
  takePrompt() {
    if (this.notes.length === 0) return void 0;
    const t = this.notes.join("\n");
    this.notes = [];
    return t;
  }
  clear() {
    this.notes = [];
  }
};
function withContext(result, extra) {
  if (result === null || typeof result !== "object") return result;
  const r = result;
  const prev = r.context;
  const list = typeof prev === "string" ? [prev] : Array.isArray(prev) ? prev.filter((x) => typeof x === "string") : [];
  return { ...r, context: [...list, extra] };
}
var MESSAGE_WAIT_MS = 2e4;
var NO_KEYS_MS = 3e4;
var ERROR_MS = 5e3;
var QUICK_MS = 1e3;
var SEEN_MEMORY = 1e3;
var MessageLoop = class {
  constructor(deps) {
    this.deps = deps;
  }
  deps;
  seen = /* @__PURE__ */ new Set();
  running = false;
  /** Motivos de los últimos descartes (para /nod). */
  rejected = 0;
  async run() {
    if (this.running) return;
    this.running = true;
    const { io, controller } = this.deps;
    try {
      for (; ; ) {
        const session = this.deps.session();
        if (session === void 0) return;
        const keys = await this.deps.keys();
        if (keys.length === 0) {
          await sleep(io, NO_KEYS_MS);
          continue;
        }
        const url = `${controller.url}/v1/control/messages?session=${encodeURIComponent(session)}&wait=${MESSAGE_WAIT_MS}`;
        const t0 = await io.now();
        const r = await call(io, MESSAGE_WAIT_MS + CALL_TIMEOUT_MS, url, { method: "GET", headers: headers(controller, false) });
        if (r?.status === 204) {
          if (await io.now() - t0 < QUICK_MS) await sleep(io, QUICK_MS);
          continue;
        }
        if (r?.status !== 200) {
          await sleep(io, ERROR_MS);
          continue;
        }
        if (this.deps.session() !== session) continue;
        const list = parseJson(r.text)?.messages;
        if (!Array.isArray(list)) {
          await sleep(io, ERROR_MS);
          continue;
        }
        await this.consider(list, session, await this.deps.keys());
      }
    } catch (err) {
      io.log(`nod control: bucle de mensajes parado (${String(err)})`);
    } finally {
      this.running = false;
    }
  }
  /** Verifica y aplica una tanda de mensajes de `session`, en orden. */
  async consider(list, session, keys) {
    const ctx = { instance: this.deps.instance, sid: sessionSid(this.deps.instance, session) };
    for (const raw of list) {
      const v = verifyMessage(raw, ctx, keys, await this.deps.io.now() / 1e3, this.seen);
      if (!v.ok) {
        if (v.reason !== "replay") {
          this.rejected++;
          this.deps.io.log(`nod control: mensaje descartado (${v.reason})`);
        }
        continue;
      }
      this.seen.add(v.id);
      if (this.seen.size > SEEN_MEMORY) this.seen.delete(this.seen.values().next().value);
      await this.deps.onMessage({ id: v.id, kind: v.kind, text: v.text });
    }
  }
};

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
  const bytes = [];
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    bytes.push(c & 255);
  }
  return bytes;
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
    const bytes = [];
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      if (c < 128) {
        bytes.push(c);
      } else {
        const b = unicodeMap[s.charAt(i)];
        if (typeof b == "number") {
          if ((b & 255) == b) {
            bytes.push(b);
          } else {
            bytes.push(b >>> 8);
            bytes.push(b & 255);
          }
        } else {
          bytes.push(unknownChar);
        }
      }
    }
    return bytes;
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
var base64DecodeInputStream = function(str) {
  const _str = str;
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
  const bytes = b.toByteArray();
  for (let i = 0; i < bytes.length; i += 1) {
    base64.writeByte(bytes[i]);
  }
  base64.flush();
  return "data:image/gif;base64," + base64;
};
var qrcode_default = qrcode;
var stringToBytes = qrcode.stringToBytes;

// src/core/control/pairing.ts
var PAIR_TTL_MS = 15 * 6e4;
var PAIR_WAIT_MS = 2 * 6e4;
var PAIR_POLL_MS = 2e3;
var MAX_PAIR_KEYS = 8;
function parsePairing(text) {
  if (text === void 0 || text.trim() === "") return [];
  const v = parseJson(text);
  const list = v !== null && typeof v === "object" && v.v === 1 ? v.keys : void 0;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (typeof e?.k !== "string" || typeof e.instance !== "string" || typeof e.expires_ms !== "number") continue;
    try {
      if (fromB64u(e.k).length !== PAIR_K_LEN) continue;
    } catch {
      continue;
    }
    out.push({ k: e.k, instance: e.instance, expires_ms: e.expires_ms });
  }
  return out;
}
function addPairKey(entries, k, instance, now) {
  const live = entries.filter((e) => e.expires_ms > now);
  live.push({ k: b64u(k), instance, expires_ms: now + PAIR_TTL_MS });
  return { v: 1, keys: live.slice(-MAX_PAIR_KEYS) };
}
function livePairKeys(entries, instance, now) {
  return entries.filter((e) => e.instance === instance && e.expires_ms > now);
}
function fillPairUrl(template, instance, token, k) {
  if (!template.includes("{k}")) return void 0;
  const enc = (s) => encodeURIComponent(s);
  return template.replaceAll("{instance}", enc(instance)).replaceAll("{token}", enc(token ?? "")).replaceAll("{k}", b64u(k));
}
function parseOffer(raw) {
  const o = raw !== null && typeof raw === "object" ? raw : void 0;
  if (typeof o?.id !== "string" || o.id === "" || o.id.length > 128) return void 0;
  try {
    if (typeof o.spki !== "string" || typeof o.tag !== "string") return { id: o.id };
    const spki = fromB64u(o.spki);
    const tag = fromB64u(o.tag);
    if (spki.length !== SPKI_LEN || tag.length !== TAG_LEN) return { id: o.id };
    return { id: o.id, offer: { id: o.id, spki, tag, name: cleanName(o.name) } };
  } catch {
    return { id: o.id };
  }
}
function checkOffer(offer, instance, live) {
  try {
    spkiPoint(offer.spki);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (isTestKid(kidOf(offer.spki))) return { ok: false, reason: "test-key" };
  const match = live.find((e) => e.instance === instance && verifyPairTag(fromB64u(e.k), instance, offer.spki, offer.tag));
  return match === void 0 ? { ok: false, reason: "tag" } : { ok: true, k: match.k, spki: offer.spki, name: offer.name };
}
async function pairOffers(controller, io, instance, store) {
  const result = { armed: false, paired: [], rejected: 0 };
  try {
    const live = livePairKeys(await store.pairKeys(), instance, await io.now());
    if (live.length === 0) return result;
    result.armed = true;
    const r = await call(io, CALL_TIMEOUT_MS, `${controller.url}/v1/control/pair-offers?instance=${encodeURIComponent(instance)}`, { method: "GET", headers: headers(controller, false) });
    if (r?.status !== 200) return result;
    const offers = parseJson(r.text)?.offers;
    if (!Array.isArray(offers)) return result;
    const used = /* @__PURE__ */ new Set();
    for (const raw of offers) {
      const parsed = parseOffer(raw);
      if (parsed === void 0) continue;
      const check = parsed.offer === void 0 ? { ok: false, reason: "malformed" } : checkOffer(parsed.offer, instance, live.filter((e) => !used.has(e.k)));
      if (check.ok) {
        used.add(check.k);
        await store.consume(check.k);
        const err = await store.addApprover(check.spki, check.name);
        if (err === void 0) result.paired.push({ kid: b64u(kidOf(check.spki)), name: check.name });
        else {
          result.rejected++;
          io.log(`nod control: no se pudo guardar la llave (${err})`);
        }
      } else {
        result.rejected++;
        io.log(`nod control: oferta de emparejamiento descartada (${check.reason})`);
      }
      void call(io, CALL_TIMEOUT_MS, `${controller.url}/v1/control/pair-offers/${encodeURIComponent(parsed.id)}`, { method: "DELETE", headers: headers(controller, false) });
    }
  } catch (err) {
    io.log(`nod control: emparejamiento fall\xF3 (${String(err)})`);
  }
  return result;
}
var qrcode2 = qrcode_default;
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

// src/core/control/summary.ts
var SUMMARY_MAX_BYTES = 1e3;
var utf83 = new TextEncoder();
function truncateUtf8(s, max) {
  if (utf83.encode(s).length <= max) return s;
  let bytes = 0;
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const n = cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
    if (bytes + n > max) break;
    bytes += n;
    out += ch;
  }
  return out;
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
var HIDDEN_RE = /[\p{Cf}\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u;
function field(input, key) {
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
function summarize(privacy, tool, input, label = tool) {
  if (privacy !== "completo") {
    const verb = tool === "Bash" ? verbOf(field(input, "command")) : void 0;
    return { summary: truncateUtf8(verb ?? label, SUMMARY_MAX_BYTES), exact: true };
  }
  let text;
  if (tool === "Bash") text = field(input, "command") ?? compactJson(input);
  else if (tool === "Edit" || tool === "Write" || tool === "Read") text = field(input, "file_path") ?? compactJson(input);
  else text = compactJson(input);
  const summary = truncateUtf8(redactSecrets(text), SUMMARY_MAX_BYTES);
  return { summary, exact: summary === text && !HIDDEN_RE.test(text) };
}

// src/core/control/channel.ts
var AWAY_HOLD_MS = HOLD_MS_MAX;
var RECAP_FALLBACK_MS = 3e3;
var ControlChannel = class {
  constructor(remoteDecision) {
    this.remoteDecision = remoteDecision;
  }
  remoteDecision;
  holder = new Holder();
  loop;
  /** La Platform de session.start: el bucle de mensajes vive más que cualquier hook. */
  loopPlatform;
  listening;
  mainTurn;
  notes = new Notes();
  pendingRecap;
  pairWatch;
  pairUntil = 0;
  blocked(ctx) {
    if (!ctx.enabled) return "Nod desactivado (NOD_OFF=1)";
    return controlBlocked(ctx.config, ctx.privacy);
  }
  // ---------- sesión y turnos ----------
  sessionStarted(p, ctx, session) {
    this.mainTurn = void 0;
    this.notes.clear();
    this.pendingRecap = void 0;
    if (this.blocked(ctx) !== void 0) return;
    const controller = this.controller(ctx);
    void pairOffers(controller, ioOf(p), ctx.instance, this.pairingStore(p, ctx));
    this.listen(p, ctx, session);
  }
  /** El agente cambió de sesión sin session.start (p. ej. /clear): el bucle sigue con la nueva. */
  sessionContinued(p, ctx, session) {
    this.mainTurn = void 0;
    this.notes.clear();
    if (this.blocked(ctx) === void 0) this.listen(this.loopPlatform ?? p, ctx, session);
  }
  sessionEnded() {
    this.listening = void 0;
    this.mainTurn = void 0;
    this.notes.clear();
    this.pendingRecap = void 0;
  }
  turnStarted(turn, agent) {
    if (agent === void 0) this.mainTurn = turn;
  }
  /** Fin de un turno principal: primero el resumen pedido, luego lo que no salió como contexto. */
  turnEnded(p, turn, agent) {
    if (agent !== void 0 || this.mainTurn !== void 0 && this.mainTurn !== turn) return;
    this.mainTurn = void 0;
    this.submitRecap(p);
    const left = this.notes.takePrompt();
    if (left !== void 0) this.submit(p, left);
  }
  /** Mensajes llegados a mitad de turno, como contexto del resultado de una tool de la sesión principal. */
  takeNote(agent) {
    return agent === void 0 ? this.notes.takeContext() : void 0;
  }
  // ---------- permisos ----------
  /**
   * Retiene un permiso preguntado si toca. Devuelve la decisión remota verificada, o undefined: el veredicto
   * original sigue (el terminal pregunta). `mode` se pide solo si el canal está activo. Nunca lanza.
   */
  async check(p, ctx, session, c, signal, mode) {
    try {
      if (this.blocked(ctx) !== void 0) return void 0;
      if (await mode().catch(() => void 0) === "auto") return void 0;
      const controller = this.controller(ctx);
      const io = ioOf(p);
      await pairOffers(controller, io, ctx.instance, this.pairingStore(p, ctx));
      const keys = await this.approvers(p, ctx);
      if (keys.keys.length === 0) return void 0;
      const tool = ctx.privacy === "redactado" ? hideMcpServer(c.tool) : c.tool;
      const s = summarize(ctx.privacy, c.tool, c.input, tool);
      const rules = forbiddenRules(ctx.env.NOD_FORBIDDEN_ADD);
      if (!rules.ok) io.log(`nod control: ${rules.error}: ninguna tool se puede aprobar desde fuera`);
      const wok = s.exact && rules.ok && approvable(c.tool, c.input, rules.rules);
      const out = await this.holder.hold({
        instance: ctx.instance,
        session,
        toolUseId: c.toolUseId,
        tool,
        summary: s.summary,
        wok,
        agent: c.agent,
        holdMs: await this.holdMs(p, ctx),
        signal,
        keys: async () => (await this.approvers(p, ctx)).keys
      }, controller, io);
      if (!out.held) {
        io.log(`nod control: no se retiene ${c.toolUseId} (${out.why})`);
        return void 0;
      }
      if (out.by !== "remote" || out.decision === "none") return void 0;
      this.remoteDecision(p, session, c.toolUseId, out.decision);
      return out.decision;
    } catch (err) {
      p.log(`nod control: retenci\xF3n fall\xF3 (${String(err)})`);
      return void 0;
    }
  }
  // ---------- mensajes ----------
  listen(p, ctx, session) {
    this.listening = session;
    if (p.session === void 0) return;
    this.loopPlatform = p;
    const controller = this.controller(ctx);
    this.loop ??= new MessageLoop({
      controller,
      io: ioOf(p),
      instance: ctx.instance,
      session: () => this.listening,
      keys: async () => (await this.approvers(this.loopPlatform ?? p, ctx)).keys,
      onMessage: (m) => this.onMessage(m)
    });
    void this.loop.run();
  }
  /** Aplica un mensaje ya verificado (tests: también se llama directamente). */
  async onMessage(m) {
    const p = this.loopPlatform;
    if (p?.session === void 0) return;
    const plan = messagePlan(m.kind, m.text, this.mainTurn !== void 0);
    if (plan.submitAfterTurn !== void 0) this.pendingRecap = plan.submitAfterTurn;
    if (plan.abort && this.mainTurn !== void 0) {
      const turn = this.mainTurn;
      await p.session.abortTurn(turn).catch((err) => p.log(`nod control: no se pudo cortar el turno (${String(err)})`));
      p.log(`nod control: turno cortado desde fuera${m.kind === "recap" ? "; se pedir\xE1 un resumen" : ""}`);
      if (this.pendingRecap !== void 0) {
        p.after(RECAP_FALLBACK_MS, () => {
          if (this.mainTurn === turn) this.mainTurn = void 0;
          this.submitRecap(p);
        });
      }
    }
    if (plan.note !== void 0) this.notes.push(plan.note);
    if (plan.submitNow !== void 0) this.submit(p, plan.submitNow);
  }
  submitRecap(p) {
    if (this.pendingRecap === void 0 || this.mainTurn !== void 0) return;
    const text = this.pendingRecap;
    this.pendingRecap = void 0;
    this.submit(p, text);
  }
  submit(p, text) {
    const s = (this.loopPlatform ?? p).session;
    if (s === void 0) return;
    void s.submitPrompt(text).catch((err) => p.log(`nod control: no se pudo enviar el prompt (${String(err)})`));
  }
  // ---------- /nod ----------
  /** `/nod emparejar | aprobadores [quitar <kid>] | lejos | cerca`; undefined si el verbo no es del canal. */
  async command(p, ctx, verb, rest) {
    switch (verb) {
      case "emparejar":
      case "pair":
        return this.pairCommand(p, ctx);
      case "aprobadores":
      case "approvers":
        return this.approversCommand(p, ctx, rest);
      case "lejos":
      case "away":
      case "cerca":
      case "back": {
        const away = verb === "lejos" || verb === "away";
        const err = await this.setAway(p, ctx, away);
        if (err !== void 0) return `no pude guardar el modo lejos (${err})`;
        const hold = Math.round(await this.holdMs(p, ctx) / 1e3);
        return away ? `lejos: en toda la m\xE1quina, un permiso espera ${hold} s una decisi\xF3n desde fuera antes de preguntar en el terminal (/nod cerca para volver).` : `cerca: un permiso espera ${hold} s una decisi\xF3n desde fuera; luego pregunta el terminal (/nod lejos si te vas).`;
      }
      default:
        return void 0;
    }
  }
  async statusLines(p, ctx) {
    const blocked = this.blocked(ctx);
    if (ctx.config === void 0) return ["  control: sin configurar (Nod no retiene ni cambia ninguna decisi\xF3n)"];
    const lines = [`  control: ${ctx.config.url}${blocked === void 0 ? "" : ` (desactivado: ${blocked})`}`];
    const a = await this.approvers(p, ctx);
    lines.push(a.keys.length === 0 ? "    aprobadores: ninguno (/nod emparejar)" : `    aprobadores: ${a.entries.map((e) => e.name ?? e.kid).join(", ")} (/nod aprobadores)`);
    for (const w of a.ignored) lines.push(`    aviso: approvers.json: ${w}`);
    const away = await this.isAway(p, ctx);
    lines.push(`    retenci\xF3n: ${Math.round(await this.holdMs(p, ctx) / 1e3)} s (${away ? "lejos: /nod cerca" : "cerca: /nod lejos"})${this.holder.holding > 0 ? ` \xB7 ${this.holder.holding} retenido(s) ahora` : ""}`);
    const last = this.holder.last;
    if (last !== void 0) {
      lines.push(last.held ? `    \xFAltimo permiso: ${last.by === "remote" ? `decidido desde fuera (${last.decision})` : last.by === "timeout" ? "venci\xF3 el plazo" : last.by === "abort" ? "cancelado" : "el controlador lo olvid\xF3"}${last.rejected > 0 ? `; ${last.rejected} decisi\xF3n(es) descartada(s), la \xFAltima por ${last.reject}` : ""}` : `    \xFAltimo permiso: no retenido (${last.why})`);
    }
    if (this.loop !== void 0) lines.push(`    mensajes: ${this.loop.running && this.listening !== void 0 ? "escuchando" : "parado"}${this.loop.rejected > 0 ? `, ${this.loop.rejected} descartado(s)` : ""}`);
    return lines;
  }
  async pairCommand(p, ctx) {
    const blocked = this.blocked(ctx);
    if (blocked !== void 0) return `Nod Control no est\xE1 activo (${blocked}): configura "control" en ~/.config/nod/config.json o NOD_CONTROL (README).`;
    const controller = this.controller(ctx);
    const io = ioOf(p);
    const r = await call(io, CALL_TIMEOUT_MS, `${controller.url}/v1/control/info`, { method: "GET", headers: headers(controller, false) });
    if (r === void 0) return `el controlador ${controller.url} no contesta.`;
    if (r.status !== 200) return `el controlador ${controller.url} respondi\xF3 ${r.status} a /v1/control/info${r.status === 401 || r.status === 403 ? " (\xBFtoken?)" : ""}.`;
    const info2 = parseJson(r.text);
    if (typeof info2?.pair_url !== "string") return `el controlador ${controller.url} no da "pair_url": no s\xE9 qu\xE9 poner en el QR.`;
    const k = await p.random(32);
    const link = fillPairUrl(info2.pair_url, ctx.instance, controller.token, k);
    if (link === void 0) return `la plantilla "pair_url" del controlador no lleva {k}: el aprobador no podr\xEDa demostrar que ley\xF3 el QR.`;
    const path = this.file(ctx, "pairing.json");
    if (path === void 0) return "no s\xE9 d\xF3nde guardar el emparejamiento (sin HOME ni XDG_STATE_HOME).";
    const now = await p.now();
    await p.write(path, JSON.stringify(addPairKey(parsePairing(await readOr(p, path)), k, ctx.instance, now), null, 2) + "\n");
    this.watchPairing(p, ctx, now + PAIR_WAIT_MS);
    const name = typeof info2.name === "string" && info2.name !== "" ? ` (${info2.name.slice(0, 64)})` : "";
    return [
      `Empareja un aprobador con ${controller.url}${name}:`,
      qrText(link),
      "",
      "Escanea el QR con el aprobador. Espero su oferta 2 min (barra de estado); si llega despu\xE9s, se empareja al",
      `empezar la siguiente sesi\xF3n o antes del siguiente permiso. El QR vale ${PAIR_TTL_MS / 6e4} min y una sola vez.`,
      controller.token ? "El QR lleva el token del controlador: no lo compartas." : ""
    ].filter((l, i, all) => l !== "" || i < all.length - 1).join("\n");
  }
  /** Tras `/nod emparejar`: busca la oferta cada 2 s durante 2 min, con la cuenta atrás en la barra de estado. */
  watchPairing(p, ctx, until) {
    this.pairWatch?.cancel();
    this.pairUntil = until;
    const tick = async () => {
      const r = await pairOffers(this.controller(ctx), ioOf(p), ctx.instance, this.pairingStore(p, ctx));
      const now = await p.now();
      if (r.paired.length > 0 || now >= this.pairUntil) {
        this.pairWatch = void 0;
        quiet(() => p.status?.(void 0));
        if (r.paired.length > 0) {
          const names = r.paired.map((k) => k.name ?? k.kid).join(", ");
          p.log(`nod control: aprobador emparejado: ${names}`);
          quiet(() => p.toast?.(`Nod: aprobador emparejado (${names})`));
        } else {
          quiet(() => p.toast?.("Nod: no lleg\xF3 la oferta en 2 min. El QR sigue valiendo: se emparejar\xE1 en la siguiente sesi\xF3n o permiso."));
        }
        return;
      }
      quiet(() => p.status?.(`Nod: escanea el QR con el aprobador\u2026 (${Math.ceil((this.pairUntil - now) / 1e3)} s)`));
      this.pairWatch = p.after(PAIR_POLL_MS, () => void tick().catch(() => void 0));
    };
    void tick().catch(() => void 0);
  }
  async approversCommand(p, ctx, rest) {
    const path = this.file(ctx, "approvers.json");
    const a = await this.approvers(p, ctx);
    const sub = rest[0]?.toLowerCase();
    if (sub === void 0) {
      if (a.entries.length === 0) return `sin aprobadores emparejados (${path ?? "approvers.json"}): /nod emparejar`;
      const lines = [`aprobadores emparejados (${path}), de toda la m\xE1quina:`];
      for (const e of a.entries) lines.push(`  ${e.kid}  ${e.name ?? "(sin nombre)"}${e.added_ms > 0 ? `  desde ${new Date(e.added_ms).toISOString().slice(0, 10)}` : ""}`);
      for (const w of a.ignored) lines.push(`  ignorada: ${w}`);
      lines.push("Para revocar uno: /nod aprobadores quitar <kid>");
      return lines.join("\n");
    }
    if ((sub === "quitar" || sub === "remove") && rest[1] !== void 0 && path !== void 0) {
      const r = removeApprover(a.entries, rest[1]);
      if (r === void 0) return `no hay ning\xFAn aprobador con kid ${rest[1]} (/nod aprobadores los lista).`;
      await p.write(path, JSON.stringify(r.file, null, 2) + "\n");
      return `aprobador ${r.removed.kid}${r.removed.name ? ` (${r.removed.name})` : ""} revocado: sus firmas dejan de contar desde la siguiente decisi\xF3n.`;
    }
    return "uso: /nod aprobadores [quitar <kid>]";
  }
  // ---------- ficheros de la máquina ----------
  controller(ctx) {
    return { url: ctx.config.url, token: ctx.config.token };
  }
  file(ctx, name) {
    const dir = stateDir(ctx.env);
    return dir === void 0 ? void 0 : `${dir}/${name}`;
  }
  async approvers(p, ctx) {
    const path = this.file(ctx, "approvers.json");
    return parseApprovers(path === void 0 ? void 0 : await readOr(p, path));
  }
  pairingStore(p, ctx) {
    const pairing = this.file(ctx, "pairing.json");
    const approvers = this.file(ctx, "approvers.json");
    return {
      pairKeys: async () => pairing === void 0 ? [] : parsePairing(await readOr(p, pairing)),
      consume: async (k) => {
        if (pairing === void 0) return;
        const left = parsePairing(await readOr(p, pairing)).filter((e) => e.k !== k);
        await p.write(pairing, JSON.stringify({ v: 1, keys: left }, null, 2) + "\n");
      },
      addApprover: async (spki, name) => {
        if (approvers === void 0) return "sin HOME ni XDG_STATE_HOME";
        const r = addApprover((await this.approvers(p, ctx)).entries, spki, name, await p.now());
        if ("error" in r) return r.error;
        await p.write(approvers, JSON.stringify(r.file, null, 2) + "\n");
        return void 0;
      }
    };
  }
  async isAway(p, ctx) {
    const path = this.file(ctx, "away.json");
    const text = path === void 0 ? void 0 : await readOr(p, path);
    return parseJson(text ?? "")?.away === true;
  }
  async setAway(p, ctx, away) {
    const path = this.file(ctx, "away.json");
    if (path === void 0) return "sin HOME ni XDG_STATE_HOME";
    try {
      await p.write(path, JSON.stringify({ v: 1, away, since_ms: await p.now() }) + "\n");
      return void 0;
    } catch (err) {
      return String(err);
    }
  }
  async holdMs(p, ctx) {
    return await this.isAway(p, ctx) ? AWAY_HOLD_MS : ctx.config?.holdMs ?? 0;
  }
};
function ioOf(p) {
  return { now: () => p.now(), after: (ms, cb) => p.after(ms, cb), fetch: (url, init) => p.fetch(url, init), random: (n) => p.random(n), log: (m) => p.log(m) };
}
async function readOr(p, path) {
  try {
    return await p.read(path);
  } catch {
    return void 0;
  }
}
function quiet(f) {
  try {
    f();
  } catch {
  }
}

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
var COMMAND_DESCRIPTION = "Nod: estado de la sesi\xF3n, los destinos y el canal de control; /nod tarea, privacidad, pausa, reanuda, emparejar, aprobadores, lejos, cerca";
var KEYS = {
  /** Id aleatorio y estable de este perfil en esta máquina: la instancia por defecto sin el nombre del equipo. */
  anonId: "nod.id",
  paused: "nod.paused",
  privacy: "nod.privacy"
};
var URGENT = /* @__PURE__ */ new Set(["turn.end", "session.end", "permission.request", "agent.end"]);
var USAGE = [
  "uso: /nod [estado | tarea [<id> [t\xEDtulo] | fin] | privacidad [completo|redactado|trabajo] | pausa | reanuda | emparejar | aprobadores [quitar <kid>] | lejos | cerca | ayuda]"
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
  /** Nod Control: retención de permisos, mensajes y emparejamiento (docs/control-v1.md). */
  channel = new ControlChannel((p, session, id, decision) => {
    void this.guard(p, "permission.remote", async (now) => this.norm.remoteDecision(now, session, id, decision));
  });
  // ---------- lo que llama el adaptador ----------
  async sessionStart(p, session, info2) {
    await this.guard(p, "session.start", async (now, rt) => {
      this.session = session;
      this.started.add(session);
      this.stats = freshStats();
      const out = this.norm.sessionStart(now, session, info2);
      if (rt.config.task !== void 0 && this.norm.task === void 0) out.push(...this.norm.setTask(now, session, rt.config.task, void 0, "env"));
      this.channel.sessionStarted(p, this.ctx(rt), session);
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
    await this.guard(p, "turn.start", async (now) => {
      this.channel.turnStarted(turn, agent);
      return this.norm.turnStart(now, session, turn, agent);
    });
  }
  async step(p, session, s) {
    await this.guard(p, "turn.step", async (now) => this.norm.step(now, session, s));
  }
  /** Fin de turno. En la sesión principal, `usage` (contexto, límites, costo) sale justo después. */
  async turnEnd(p, session, t, usage) {
    await this.guard(p, "turn.end", async (now) => {
      const out = this.norm.turnEnd(now, session, t);
      this.channel.turnEnded(p, t.turn, t.agent);
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
  /**
   * Un permiso que el agente va a preguntar: con Nod Control activo, llaves emparejadas y un modo que no sea
   * `auto`, se retiene hasta una decisión remota verificada, el plazo o la cancelación. Devuelve esa decisión
   * (ya emitida como permission.decision by "remote") o undefined: el veredicto original sigue. Es el único sitio
   * donde Nod cambia una decisión. `mode` se consulta solo si hace falta. Nunca lanza.
   */
  async checkPermission(p, session, c, signal, mode) {
    try {
      const rt = await this.getRuntime(p);
      return await this.channel.check(p, this.ctx(rt), session, c, signal, mode);
    } catch (err) {
      p.log(`nod: retenci\xF3n fall\xF3 (${String(err)})`);
      return void 0;
    }
  }
  /** Mensaje de un aprobador llegado a mitad de turno, para el resultado de una tool de la sesión principal. */
  takeNote(agent) {
    return this.channel.takeNote(agent);
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
    this.channel.sessionEnded();
    this.started.delete(session);
    const rt = await this.runtime?.catch(() => void 0);
    if (rt === void 0) return;
    const boxes = rt.outboxes.filter((o) => sinkAllowed(rt.privacy, o.sink));
    if (!rt.paused) await within2(p, CLOSE_TIMEOUT_MS, Promise.all(boxes.map((o) => o.flush())));
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
    await loadTokenFiles(config, (path2) => p.read(path2), warnings);
    const stored = await p.store.get(KEYS.privacy);
    let privacy = config.privacy;
    if (!env2.NOD_PRIVACY && PRIVACY_LEVELS.includes(stored)) {
      privacy = stricter(config.privacy, stored);
      if (isStricter(config.privacy, stored)) warnings.push(`la privacidad guardada (${String(stored)}) es m\xE1s laxa que la de la configuraci\xF3n: uso ${config.privacy}`);
    }
    for (const w of warnings) p.log(`nod: ${w}`);
    const rt = { info: info2, env: env2, config, warnings, privacy, outboxes: [], paused: await p.store.get(KEYS.paused) === true };
    for (const sink of config.sinks) {
      const transport = sink.kind === "file" ? async (envelope) => {
        await p.append(sink.target, JSON.stringify(envelope) + "\n");
        return { status: 200 };
      } : async (envelope) => {
        const headers2 = { "content-type": "application/json" };
        if (sink.token) headers2.authorization = `Bearer ${sink.token}`;
        const r = await within2(p, HTTP_TIMEOUT_MS, p.fetch(`${sink.target}/v1/events`, { method: "POST", headers: headers2, body: JSON.stringify(envelope) }));
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
  ctx(rt) {
    return { enabled: rt.config.enabled, config: rt.config.control, privacy: rt.privacy, instance: rt.config.instance, env: rt.env };
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
          this.channel.sessionContinued(p, this.ctx(rt), first.session);
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
    if (v === "" || v === "estado" || v === "status") return [this.statusText(rt, await p.now()), ...await this.channel.statusLines(p, this.ctx(rt))].join("\n");
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
    return await this.channel.command(p, this.ctx(rt), v, rest) ?? USAGE;
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
function within2(p, ms, work) {
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
  "Nod Control (aprobar permisos y mandar mensajes desde fuera, si hay controlador configurado):",
  "  /nod emparejar            QR para emparejar un aprobador (m\xF3vil, reloj\u2026)",
  "  /nod aprobadores          llaves emparejadas; /nod aprobadores quitar <kid> revoca una",
  "  /nod lejos \xB7 cerca        un permiso espera 90 s o hold_ms una decisi\xF3n desde fuera (toda la m\xE1quina)",
  "Configuraci\xF3n: NOD_SINKS, NOD_PRIVACY, NOD_TASK, NOD_CONTROL\u2026 o ~/.config/nod/config.json (README)."
].join("\n");

// src/hosts/claude/mode.ts
function projectSlug(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}
function transcriptPath(configDir, cwd, session) {
  return `${configDir.replace(/\/+$/, "")}/projects/${projectSlug(cwd)}/${session}.jsonl`;
}
function modeGrepArgs(path) {
  return ["/usr/bin/grep", "-o", '"permissionMode":"[A-Za-z]*"', path];
}
function lastMode(stdout) {
  if (typeof stdout !== "string") return void 0;
  const all = [...stdout.matchAll(/"permissionMode":"([A-Za-z]+)"/g)];
  return all.length === 0 ? void 0 : all[all.length - 1][1];
}
var MODE_CACHE_MS = 2e3;

// src/hosts/claude/register.ts
var nod = new NodEngine();
var env;
var info;
var sessionId;
var sessionCwd;
var madeDirs = /* @__PURE__ */ new Set();
var hookMode;
var transcript;
var modeCache;
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
    NOD_CONTROL: await $.env.get("NOD_CONTROL"),
    NOD_CONTROL_TOKEN: await $.env.get("NOD_CONTROL_TOKEN"),
    NOD_FORBIDDEN_ADD: await $.env.get("NOD_FORBIDDEN_ADD"),
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
async function mkdirFor($, path) {
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir !== "" && !madeDirs.has(dir)) {
    await $.process.run(["mkdir", "-p", dir]);
    madeDirs.add(dir);
  }
}
async function randomBytes3($, n) {
  const c = globalThis.crypto;
  if (c !== void 0 && typeof c.getRandomValues === "function") return c.getRandomValues(new Uint8Array(n));
  const r = await $.process.run(["openssl", "rand", "-hex", String(n)]);
  const hex2 = String(r?.stdout ?? "").trim();
  if (!new RegExp(`^[0-9a-f]{${2 * n}}$`).test(hex2)) throw new Error("sin generador aleatorio criptogr\xE1fico");
  return Uint8Array.from(hex2.match(/../g).map((h) => parseInt(h, 16)));
}
function quiet2(f) {
  try {
    f();
  } catch {
  }
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
      await mkdirFor($, path);
      const r = await $.process.run(["tee", "-a", path], { stdin: text });
      const code = r?.exitCode ?? r?.code ?? 0;
      if (code !== 0) throw new Error(`tee sali\xF3 con ${code}: ${String(r?.stderr ?? "").trim()}`);
    },
    write: async (path, text) => {
      await mkdirFor($, path);
      await $.fs.write(path, text);
    },
    random: (n) => randomBytes3($, n),
    log: (message) => $.ui.log(message, { to: "debug" }),
    status: (text) => quiet2(() => $.ui.status(text)),
    toast: (text) => quiet2(() => $.ui.toast(text)),
    session: {
      abortTurn: async (turnId) => {
        await $.turn.abort({ turnId });
      },
      submitPrompt: async (text) => {
        await $.prompt.submit({ text, asUser: true });
      }
    }
  };
}
async function sessionMode($) {
  if (hookMode !== void 0) return hookMode;
  try {
    const now = Number(await $.clock.now());
    const session = await currentSession($);
    if (modeCache !== void 0 && modeCache.session === session && now - modeCache.at < MODE_CACHE_MS) return modeCache.mode;
    if (transcript === void 0 || !transcript.endsWith(`/${session}.jsonl`)) {
      const home = await $.env.get("HOME");
      const configDir = await $.env.get("CLAUDE_CONFIG_DIR") || (home ? `${home}/.claude` : void 0);
      const cwd = sessionCwd ?? await $.session.cwd();
      if (typeof configDir !== "string" || typeof cwd !== "string") return void 0;
      transcript = transcriptPath(configDir, cwd, session);
    }
    let r = await $.process.run(modeGrepArgs(transcript));
    if (lastMode(r?.stdout) === void 0) {
      const projects = transcript.slice(0, transcript.lastIndexOf("/projects/") + "/projects".length);
      const f = await $.process.run(["/usr/bin/find", projects, "-maxdepth", "2", "-name", `${session}.jsonl`]);
      const found = typeof f?.stdout === "string" ? f.stdout.split("\n").find((l) => l.endsWith(".jsonl")) : void 0;
      if (found !== void 0 && found !== transcript) {
        transcript = found;
        r = await $.process.run(modeGrepArgs(found));
      }
    }
    const mode = lastMode(r?.stdout);
    modeCache = { at: now, session, mode };
    return mode;
  } catch {
    return void 0;
  }
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
      sessionCwd = opt(e?.cwd);
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
    const note = nod.takeNote(opt(e?.agentId));
    return note === void 0 ? out : withContext(out, note);
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
    if (id !== void 0 && d === "ask") {
      const info2 = { toolUseId: id, tool: String(e?.tool ?? "?"), input: e?.input, agent: opt(e?.agentId) };
      const remote = await nod.checkPermission(platform($), await currentSession($), info2, next?.signal, () => sessionMode($));
      if (remote === "allow") return { decision: "allow", reason: "aprobado desde fuera del terminal (Nod Control)" };
      if (remote === "deny") return { decision: "deny", reason: "denegado desde fuera del terminal (Nod Control)" };
    }
    return verdict;
  }).catch((_$, e, next) => next(e));
  on("classic.UserPromptSubmit", async (_$, e, next) => {
    if (typeof e?.permission_mode === "string" && e.permission_mode !== "") hookMode = e.permission_mode;
    return next(e);
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
