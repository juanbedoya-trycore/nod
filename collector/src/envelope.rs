//! El sobre Nod v1 (`docs/nod-v1.md` §2 y §3, `schema/nod-v1.schema.json`): validación y paso a filas.
//!
//! La validación sigue el esquema y nada más: campos requeridos, sus tipos y los enums que fija. Un tipo de
//! evento desconocido es válido (el contrato dice que el consumidor lo ignora, no que lo rechace) y se guarda
//! igual, para que una versión posterior del collector pueda usarlo sin volver a recibirlo.

use serde_json::{Map, Value};

/// Un evento ya validado, con lo del sobre que hace falta para guardarlo.
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub instance: String,
    pub run: String,
    pub seq: i64,
    pub ts: i64,
    pub kind: String,
    pub session: String,
    pub turn: Option<String>,
    pub agent: Option<String>,
    pub task: Option<String>,
    pub privacy: String,
    pub host: String,
    pub profile: String,
    pub data: Value,
}

impl Event {
    pub fn str(&self, key: &str) -> Option<&str> {
        self.data.get(key).and_then(Value::as_str)
    }
    pub fn num(&self, key: &str) -> Option<f64> {
        self.data.get(key).and_then(Value::as_f64)
    }
    pub fn bool(&self, key: &str) -> Option<bool> {
        self.data.get(key).and_then(Value::as_bool)
    }
    /// Sesión principal: el contrato marca los subagentes con `agent`; sin él, el evento es del principal.
    pub fn is_main(&self) -> bool {
        self.agent.is_none()
    }
}

/// Lo que exige el esquema en `data` según el tipo (los `if/then` de `$defs.event.allOf`).
fn required_data(kind: &str) -> &'static [&'static str] {
    match kind {
        "session.start" => &["interactive"],
        "session.end" => &["reason", "duration_ms"],
        "prompt.submit" => &["origin", "chars"],
        "turn.step" => &["index", "tools", "usage"],
        "turn.end" => &["outcome", "usage", "steps", "answer_chars"],
        "tool.call" => &["tool_use_id", "tool"],
        "tool.result" => &[
            "tool_use_id",
            "tool",
            "duration_ms",
            "ok",
            "rejected",
            "output_chars",
        ],
        "permission.request" => &["tool_use_id", "tool"],
        "permission.decision" => &["tool_use_id", "tool", "decision", "by", "wait_ms", "exact"],
        "agent.spawn" => &["agent", "type", "background"],
        "agent.end" => &["agent", "duration_ms", "usage"],
        "command" => &["name"],
        "task.set" => &["task", "source"],
        _ => &[],
    }
}

/// Entero JSON. El esquema 2020-12 cuenta `3.0` como entero; serde lo lee como f64.
fn int(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| {
        v.as_f64()
            .filter(|f| f.fract() == 0.0 && f.abs() < 9.0e15)
            .map(|f| f as i64)
    })
}

fn req_str<'a>(o: &'a Map<String, Value>, key: &str, at: &str) -> Result<&'a str, String> {
    match o.get(key) {
        Some(Value::String(s)) => Ok(s),
        Some(_) => Err(format!("{at}.{key}: debe ser texto")),
        None => Err(format!("{at}: falta \"{key}\"")),
    }
}

fn opt_str(o: &Map<String, Value>, key: &str, at: &str) -> Result<Option<String>, String> {
    match o.get(key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("{at}.{key}: debe ser texto")),
    }
}

/// `^[a-z0-9][a-z0-9._-]{0,63}$`
fn instance_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(c))
}

/// `^[0-9a-f]{8}$`
fn run_ok(s: &str) -> bool {
    s.len() == 8
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn check_usage(v: Option<&Value>, at: &str) -> Result<(), String> {
    let o = v
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{at}: debe ser un objeto"))?;
    for k in ["input", "output", "cache_read", "cache_write"] {
        match o.get(k).and_then(Value::as_f64) {
            Some(n) if n >= 0.0 => {}
            Some(_) => return Err(format!("{at}.{k}: debe ser ≥ 0")),
            None => return Err(format!("{at}: falta \"{k}\" numérico")),
        }
    }
    if o.get("model").is_some_and(|m| !m.is_string()) {
        return Err(format!("{at}.model: debe ser texto"));
    }
    Ok(())
}

fn check_event(e: &Map<String, Value>, at: &str) -> Result<(), String> {
    let kind = req_str(e, "type", at)?;
    let data = match e.get("data") {
        Some(Value::Object(d)) => d,
        Some(_) => return Err(format!("{at}.data: debe ser un objeto")),
        None => return Err(format!("{at}: falta \"data\"")),
    };
    let dat = format!("{at}.data");
    for k in required_data(kind) {
        if !data.contains_key(*k) {
            return Err(format!("{dat}: falta \"{k}\" (obligatorio en {kind})"));
        }
    }
    match kind {
        "turn.step" | "turn.end" => {
            if !e.contains_key("turn") {
                return Err(format!("{at}: falta \"turn\" (obligatorio en {kind})"));
            }
            check_usage(data.get("usage"), &format!("{dat}.usage"))?;
        }
        "permission.decision" => {
            if !matches!(data["decision"].as_str(), Some("allow" | "deny")) {
                return Err(format!("{dat}.decision: debe ser allow o deny"));
            }
            if !matches!(data["by"].as_str(), Some("policy" | "user" | "remote")) {
                return Err(format!("{dat}.by: debe ser policy, user o remote"));
            }
            if !data["exact"].is_boolean() {
                return Err(format!("{dat}.exact: debe ser booleano"));
            }
        }
        "task.set" if !(data["task"].is_string() || data["task"].is_null()) => {
            return Err(format!("{dat}.task: debe ser texto o null"));
        }
        "usage" if data.is_empty() => {
            return Err(format!("{dat}: un usage necesita al menos un campo"));
        }
        _ => {}
    }
    Ok(())
}

/// Valida un sobre entero y lo convierte en eventos. Si algo falla no devuelve ninguno: el contrato trata el
/// lote como inválido (Nod lo parte por la mitad hasta aislar el evento culpable).
pub fn parse_envelope(v: &Value) -> Result<Vec<Event>, String> {
    let o = v.as_object().ok_or("el sobre debe ser un objeto JSON")?;
    if o.get("nod").and_then(int) != Some(1) {
        return Err("\"nod\" debe ser 1".into());
    }
    let src = o
        .get("source")
        .and_then(Value::as_object)
        .ok_or("falta \"source\" (objeto)")?;
    let instance = req_str(src, "instance", "source")?;
    if !instance_ok(instance) {
        return Err(format!("source.instance no válido: {instance:?}"));
    }
    let run = req_str(src, "run", "source")?;
    if !run_ok(run) {
        return Err(format!(
            "source.run no válido (8 hex en minúsculas): {run:?}"
        ));
    }
    let host = req_str(src, "host", "source")?;
    let profile = req_str(src, "profile", "source")?;
    if host.is_empty() || profile.is_empty() {
        return Err("source.host y source.profile no pueden estar vacíos".into());
    }
    let privacy = req_str(src, "privacy", "source")?;
    if !matches!(privacy, "completo" | "redactado" | "trabajo") {
        return Err(format!("source.privacy no válida: {privacy:?}"));
    }
    for k in ["host_version", "machine"] {
        opt_str(src, k, "source")?;
    }
    let events = o
        .get("events")
        .and_then(Value::as_array)
        .ok_or("falta \"events\" (lista)")?;

    let mut out = Vec::with_capacity(events.len());
    for (i, ev) in events.iter().enumerate() {
        let at = format!("events[{i}]");
        let e = ev
            .as_object()
            .ok_or_else(|| format!("{at}: debe ser un objeto"))?;
        let seq = e
            .get("seq")
            .and_then(int)
            .filter(|n| *n >= 1)
            .ok_or_else(|| format!("{at}.seq: entero ≥ 1 obligatorio"))?;
        let ts = e
            .get("ts")
            .and_then(int)
            .filter(|n| *n >= 0)
            .ok_or_else(|| format!("{at}.ts: entero ≥ 0 obligatorio"))?;
        let session = req_str(e, "session", &at)?;
        if session.is_empty() {
            return Err(format!("{at}.session: no puede estar vacío"));
        }
        check_event(e, &at)?;
        out.push(Event {
            instance: instance.into(),
            run: run.into(),
            seq,
            ts,
            kind: e["type"].as_str().unwrap_or_default().into(),
            session: session.into(),
            turn: opt_str(e, "turn", &at)?,
            agent: opt_str(e, "agent", &at)?,
            task: opt_str(e, "task", &at)?,
            privacy: privacy.into(),
            host: host.into(),
            profile: profile.into(),
            data: e["data"].clone(),
        });
    }
    Ok(out)
}
