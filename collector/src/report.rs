//! `report`: métricas por tarea (y por sesión) a partir de los eventos guardados.
//!
//! Cada métrica sale solo de lo que el contrato define (docs/nod-v1.md §3 y §3.1). Cómo se calcula cada una
//! está en el comentario de su campo en [`Metrics`]; la salida `--json` es esta misma estructura, con los
//! nombres y el orden de campos estables.

use crate::envelope::Event;
use crate::time::{fmt_duration, fmt_utc};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt::Write as _;

/// Tokens de `usage` (§3): enteros en la práctica; se suman como f64 porque el esquema dice `number`.
#[derive(Debug, Default, Clone, Copy, PartialEq, Serialize)]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl Tokens {
    fn add(&mut self, u: &serde_json::Value) {
        let n = |k: &str| {
            u.get(k)
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0)
                .max(0.0)
                .round() as u64
        };
        self.input += n("input");
        self.output += n("output");
        self.cache_read += n("cache_read");
        self.cache_write += n("cache_write");
    }
    pub fn total(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
}

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
pub struct Times {
    /// Tiempo del agente: Σ `turn.end.duration_ms` de la sesión principal (sin `agent`). Los turnos de los
    /// subagentes corren dentro de los del principal: sumarlos contaría dos veces el mismo tiempo de reloj.
    pub agent_ms: u64,
    /// Tiempo esperándote: Σ `permission.decision.wait_ms` con `by` = `user` o `remote` (§3.1), de la sesión
    /// principal y de los subagentes (en ambos casos es el humano el que hace esperar).
    pub waiting_ms: u64,
    /// Cuántas decisiones entran en `waiting_ms`.
    pub waiting_count: u64,
    /// Cuántas de ellas son cota superior (`exact: false`): `waiting_ms` puede estar algo inflado.
    pub waiting_upper_bounds: u64,
    /// Tiempo bloqueado por otros mods: Σ `check_ms` de `permission.request` y `permission.decision` (Nod lo
    /// pone en el request si se preguntó y en la decisión si la resolvió la política; nunca en los dos).
    pub blocked_by_mods_ms: u64,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
pub struct Turns {
    /// `prompt.submit` con `origin: "composer"`: los prompts que escribió el humano.
    pub composer_prompts: u64,
    /// `turn.step` de la sesión principal (llamadas al modelo).
    pub main_steps: u64,
    /// Autonomía: `main_steps / composer_prompts` (null sin prompts del humano).
    pub autonomy: Option<f64>,
    /// Interrupciones: `turn.end` de la sesión principal con `outcome: "aborted"`. Los de los subagentes no
    /// cuentan: abortar el turno principal también corta sus subagentes y sería contar dos veces la misma tecla.
    pub aborted: u64,
    /// `prompt.submit.edit.revised`: se sustituyó o borró texto antes de enviarlo.
    pub revised_prompts: u64,
    /// `prompt.submit.edit.recalled`: el prompt partió de uno del historial.
    pub recalled_prompts: u64,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
pub struct ToolPermissions {
    pub tool: String,
    /// `permission.request` de esta tool (el agente preguntó al humano).
    pub asked: u64,
    /// `permission.decision` con `decision: "deny"` y `by` = `user` o `remote` (lo negó una persona; las
    /// negativas de la política no son una pregunta contestada).
    pub denied: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Loop {
    pub session: String,
    pub agent: Option<String>,
    pub tool: String,
    /// Fallos seguidos (≥ 3).
    pub failures: u64,
    pub first_ts: i64,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
pub struct Metrics {
    pub sessions: u64,
    pub events: u64,
    pub first_ts: Option<i64>,
    pub last_ts: Option<i64>,
    pub time: Times,
    pub turns: Turns,
    /// Por tool, ordenadas por nombre.
    pub permissions: Vec<ToolPermissions>,
    /// Bucles: rachas de ≥ 3 `tool.result` seguidos con `ok: false` de la misma tool, dentro de la misma
    /// sesión y del mismo agente (principal o cada subagente: sus tools se intercalan en el tiempo y mezclarlas
    /// rompería rachas reales). Un `tool.result` con `rejected: true` no es un fallo de la tool sino una
    /// negativa del humano: corta la racha.
    pub loops: Vec<Loop>,
    /// Tokens: Σ `turn.step.usage`, principal y subagentes (§3.1: `turn.end` y `agent.end` son agregados de esos
    /// mismos pasos y no se suman).
    pub tokens: Tokens,
    pub tokens_total: u64,
    /// La parte de `tokens` de los pasos con `agent` (subagentes).
    pub subagent_tokens: Tokens,
    /// Eficiencia de caché: `cache_read / (input + cache_read + cache_write)` (null si el denominador es 0). La
    /// salida no entra: no se puede cachear.
    pub cache_efficiency: Option<f64>,
    /// Presión de contexto: máximo de `usage.context.percent`.
    pub context_max_percent: Option<f64>,
    /// Costo: por sesión, el último `usage.cost_usd` (es acumulado de la sesión), sumado entre sesiones.
    pub cost_usd: Option<f64>,
    /// Ritmo del límite de 5 h en puntos porcentuales por hora: entre `usage` consecutivos de la misma
    /// instancia que traen el límite `five_hour` con el mismo `resets_at` (misma ventana), Σ Δpercent_used /
    /// Σ Δhoras. Es la media ponderada por tiempo; los pares que cruzan una renovación no cuentan.
    pub five_hour_pace: Option<f64>,
    /// Pares de `usage` que entran en `five_hour_pace`.
    pub five_hour_pace_pairs: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Group {
    /// `null`: eventos sin tarea.
    pub task: Option<String>,
    /// Solo si se pidió `--session`.
    pub session: Option<String>,
    pub metrics: Metrics,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Report {
    pub groups: Vec<Group>,
    pub total: Metrics,
}

fn ms(v: Option<f64>) -> u64 {
    v.unwrap_or(0.0).max(0.0).round() as u64
}

/// Las métricas de un conjunto de eventos, que deben venir ordenados por tiempo (como los da el almacén).
pub fn metrics(events: &[&Event]) -> Metrics {
    let mut m = Metrics {
        events: events.len() as u64,
        first_ts: events.first().map(|e| e.ts),
        last_ts: events.last().map(|e| e.ts),
        ..Default::default()
    };
    let mut sessions = BTreeSet::new();
    let mut perms: BTreeMap<String, ToolPermissions> = BTreeMap::new();
    // Racha de fallos en curso por (sesión, agente): (tool, fallos, ts del primero).
    let mut streaks: HashMap<(String, Option<String>), (String, u64, i64)> = HashMap::new();
    let mut last_cost: HashMap<&str, f64> = HashMap::new();
    // Último límite de 5 h visto por instancia: (ts, percent_used, resets_at).
    let mut last_five: HashMap<&str, (i64, f64, String)> = HashMap::new();
    let (mut pace_pp, mut pace_h) = (0.0, 0.0);

    let close = |m: &mut Metrics, key: &(String, Option<String>), s: (String, u64, i64)| {
        if s.1 >= 3 {
            m.loops.push(Loop {
                session: key.0.clone(),
                agent: key.1.clone(),
                tool: s.0,
                failures: s.1,
                first_ts: s.2,
            });
        }
    };

    for e in events {
        sessions.insert(e.session.as_str());
        match e.kind.as_str() {
            "turn.end" if e.is_main() => {
                m.time.agent_ms += ms(e.num("duration_ms"));
                if e.str("outcome") == Some("aborted") {
                    m.turns.aborted += 1;
                }
            }
            "turn.step" => {
                let u = &e.data["usage"];
                m.tokens.add(u);
                if e.is_main() {
                    m.turns.main_steps += 1;
                } else {
                    m.subagent_tokens.add(u);
                }
            }
            "prompt.submit" => {
                if e.str("origin") == Some("composer") {
                    m.turns.composer_prompts += 1;
                }
                let edit = &e.data["edit"];
                if edit["revised"].as_bool() == Some(true) {
                    m.turns.revised_prompts += 1;
                }
                if edit["recalled"].as_bool() == Some(true) {
                    m.turns.recalled_prompts += 1;
                }
            }
            "permission.request" => {
                let tool = e.str("tool").unwrap_or("?").to_string();
                perms
                    .entry(tool.clone())
                    .or_insert_with(|| ToolPermissions {
                        tool,
                        ..Default::default()
                    })
                    .asked += 1;
                m.time.blocked_by_mods_ms += ms(e.num("check_ms"));
            }
            "permission.decision" => {
                m.time.blocked_by_mods_ms += ms(e.num("check_ms"));
                if matches!(e.str("by"), Some("user" | "remote")) {
                    m.time.waiting_ms += ms(e.num("wait_ms"));
                    m.time.waiting_count += 1;
                    if e.bool("exact") == Some(false) {
                        m.time.waiting_upper_bounds += 1;
                    }
                    if e.str("decision") == Some("deny") {
                        let tool = e.str("tool").unwrap_or("?").to_string();
                        perms
                            .entry(tool.clone())
                            .or_insert_with(|| ToolPermissions {
                                tool,
                                ..Default::default()
                            })
                            .denied += 1;
                    }
                }
            }
            "tool.result" => {
                let key = (e.session.clone(), e.agent.clone());
                let tool = e.str("tool").unwrap_or("?");
                let failed = e.bool("ok") == Some(false) && e.bool("rejected") != Some(true);
                let cur = streaks.remove(&key);
                match (failed, cur) {
                    (true, Some((t, n, first))) if t == tool => {
                        streaks.insert(key, (t, n + 1, first));
                    }
                    (true, prev) => {
                        if let Some(p) = prev {
                            close(&mut m, &key, p);
                        }
                        streaks.insert(key, (tool.to_string(), 1, e.ts));
                    }
                    (false, prev) => {
                        if let Some(p) = prev {
                            close(&mut m, &key, p);
                        }
                    }
                }
            }
            "usage" => {
                if let Some(p) = e.data["context"]["percent"].as_f64() {
                    m.context_max_percent =
                        Some(m.context_max_percent.map_or(p, |x: f64| x.max(p)));
                }
                if let Some(c) = e.num("cost_usd") {
                    last_cost.insert(e.session.as_str(), c);
                }
                let five = e.data["limits"]
                    .as_array()
                    .and_then(|ls| ls.iter().find(|l| l["kind"].as_str() == Some("five_hour")));
                if let Some(l) = five {
                    if let (Some(p), Some(r)) =
                        (l["percent_used"].as_f64(), l["resets_at"].as_str())
                    {
                        if let Some((ts0, p0, r0)) = last_five.get(e.instance.as_str()) {
                            if r0 == r && e.ts > *ts0 {
                                pace_pp += p - p0;
                                pace_h += (e.ts - ts0) as f64 / 3_600_000.0;
                                m.five_hour_pace_pairs += 1;
                            }
                        }
                        last_five.insert(e.instance.as_str(), (e.ts, p, r.to_string()));
                    }
                }
            }
            _ => {}
        }
    }
    let mut rest: Vec<_> = streaks.into_iter().collect();
    rest.sort_by_key(|a| a.1 .2);
    for (key, s) in rest {
        close(&mut m, &key, s);
    }
    m.loops
        .sort_by(|a, b| (a.first_ts, &a.session).cmp(&(b.first_ts, &b.session)));

    m.sessions = sessions.len() as u64;
    m.permissions = perms.into_values().collect();
    m.tokens_total = m.tokens.total();
    let t = &m.tokens;
    let denom = t.input + t.cache_read + t.cache_write;
    m.cache_efficiency = (denom > 0).then(|| t.cache_read as f64 / denom as f64);
    m.turns.autonomy = (m.turns.composer_prompts > 0)
        .then(|| m.turns.main_steps as f64 / m.turns.composer_prompts as f64);
    m.cost_usd = (!last_cost.is_empty()).then(|| last_cost.values().sum());
    m.five_hour_pace = (pace_h > 0.0).then(|| pace_pp / pace_h);
    m
}

/// Agrupa por tarea (y por sesión si `by_session`) y calcula cada grupo y el total.
pub fn build(events: &[Event], by_session: bool) -> Report {
    let mut groups: BTreeMap<(Option<&str>, Option<&str>), Vec<&Event>> = BTreeMap::new();
    for e in events {
        let session = by_session.then_some(e.session.as_str());
        groups
            .entry((e.task.as_deref(), session))
            .or_default()
            .push(e);
    }
    let all: Vec<&Event> = events.iter().collect();
    Report {
        groups: groups
            .into_iter()
            .map(|((task, session), evs)| Group {
                task: task.map(String::from),
                session: session.map(String::from),
                metrics: metrics(&evs),
            })
            .collect(),
        total: metrics(&all),
    }
}

fn pct(x: f64) -> String {
    format!("{:.1} %", x * 100.0)
}

fn tokens_line(t: &Tokens) -> String {
    format!(
        "entrada {} · salida {} · caché leída {} · caché escrita {}",
        t.input, t.output, t.cache_read, t.cache_write
    )
}

fn render_metrics(out: &mut String, m: &Metrics) {
    let row = |out: &mut String, k: &str, v: String| {
        let _ = writeln!(out, "    {k:<26} {v}");
    };
    let span = match (m.first_ts, m.last_ts) {
        (Some(a), Some(b)) => format!("{} → {}", fmt_utc(a), fmt_utc(b)),
        _ => "—".into(),
    };
    let _ = writeln!(
        out,
        "  {} sesiones, {} eventos, {span}",
        m.sessions, m.events
    );

    let _ = writeln!(out, "  Tiempos");
    row(out, "agente", fmt_duration(m.time.agent_ms));
    let bounds = if m.time.waiting_upper_bounds > 0 {
        format!(", {} cota superior", m.time.waiting_upper_bounds)
    } else {
        String::new()
    };
    row(
        out,
        "esperándote",
        format!(
            "{} ({} respuestas{bounds})",
            fmt_duration(m.time.waiting_ms),
            m.time.waiting_count
        ),
    );
    row(
        out,
        "bloqueado por otros mods",
        fmt_duration(m.time.blocked_by_mods_ms),
    );

    let _ = writeln!(out, "  Turnos y permisos");
    let t = &m.turns;
    row(
        out,
        "autonomía",
        match t.autonomy {
            Some(a) => format!(
                "{a:.1} pasos por prompt ({} pasos / {} prompts)",
                t.main_steps, t.composer_prompts
            ),
            None => format!("— ({} pasos, sin prompts tuyos)", t.main_steps),
        },
    );
    row(out, "interrupciones", t.aborted.to_string());
    row(
        out,
        "prompts reescritos",
        format!(
            "{} · sacados del historial {}",
            t.revised_prompts, t.recalled_prompts
        ),
    );
    if m.permissions.is_empty() {
        row(out, "permisos", "ninguno preguntado ni negado".into());
    } else {
        row(out, "permisos", "preguntados / negados".into());
        for p in &m.permissions {
            let _ = writeln!(out, "      {:<26} {} / {}", p.tool, p.asked, p.denied);
        }
    }
    if m.loops.is_empty() {
        row(out, "bucles", "0".into());
    } else {
        row(out, "bucles", m.loops.len().to_string());
        for l in &m.loops {
            let who = l
                .agent
                .as_deref()
                .map(|a| format!(" (subagente {a})"))
                .unwrap_or_default();
            let _ = writeln!(
                out,
                "      {} falló {} veces seguidas{who}, {}",
                l.tool,
                l.failures,
                fmt_utc(l.first_ts)
            );
        }
    }

    let _ = writeln!(out, "  Tokens y costo");
    row(
        out,
        "tokens",
        format!("{} ({})", m.tokens_total, tokens_line(&m.tokens)),
    );
    row(
        out,
        "  de subagentes",
        format!(
            "{} ({})",
            m.subagent_tokens.total(),
            tokens_line(&m.subagent_tokens)
        ),
    );
    row(
        out,
        "eficiencia de caché",
        m.cache_efficiency.map_or("—".into(), pct),
    );
    row(
        out,
        "contexto máximo",
        m.context_max_percent
            .map_or("—".into(), |p| format!("{p:.0} %")),
    );
    row(
        out,
        "costo",
        m.cost_usd.map_or("—".into(), |c| format!("{c:.4} USD")),
    );
    row(
        out,
        "ritmo del límite de 5 h",
        match m.five_hour_pace {
            Some(p) => format!("{p:.1} pp/h ({} intervalos)", m.five_hour_pace_pairs),
            None => "— (hacen falta dos usage en la misma ventana)".into(),
        },
    );
}

/// La tabla legible.
pub fn render(r: &Report) -> String {
    let mut out = String::new();
    if r.groups.is_empty() {
        out.push_str("Sin eventos para ese filtro.\n");
        return out;
    }
    for g in &r.groups {
        let task = g.task.as_deref().unwrap_or("(sin tarea)");
        let _ = match &g.session {
            Some(s) => writeln!(out, "Tarea {task} · sesión {s}"),
            None => writeln!(out, "Tarea {task}"),
        };
        render_metrics(&mut out, &g.metrics);
        out.push('\n');
    }
    if r.groups.len() > 1 {
        let _ = writeln!(out, "Total");
        render_metrics(&mut out, &r.total);
    }
    out
}
