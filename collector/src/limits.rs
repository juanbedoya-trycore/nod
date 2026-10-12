//! `limits`: los límites de 5 h y 7 días más recientes, para la barra de tmux.
//!
//! La fuente es el último `usage` con `limits` (§3), de la base de datos o directamente del fichero del destino
//! de tipo fichero: así funciona también para quien no tenga el collector en marcha.

use crate::envelope::parse_envelope;
use crate::store::UsageSnapshot;
use crate::time::parse_datetime;
use serde_json::{json, Value};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Un límite tal como viene en `usage.limits`.
#[derive(Debug, Clone, PartialEq)]
pub struct Limit {
    pub kind: String,
    pub percent_used: f64,
    /// ms Unix de la renovación, si el agente la da.
    pub resets_at: Option<i64>,
}

pub fn limits_of(snap: &UsageSnapshot) -> Vec<Limit> {
    snap.limits
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|l| {
            Some(Limit {
                kind: l["kind"].as_str()?.to_string(),
                percent_used: l["percent_used"].as_f64()?,
                resets_at: l["resets_at"].as_str().and_then(parse_datetime),
            })
        })
        .collect()
}

/// El `usage` con límites más reciente de un sobre (validado; los inválidos no cuentan).
fn latest_in_line(line: &str, instance: Option<&str>) -> Option<UsageSnapshot> {
    let v: Value = serde_json::from_str(line).ok()?;
    parse_envelope(&v)
        .ok()?
        .into_iter()
        .filter(|e| e.kind == "usage" && e.data["limits"].is_array())
        .filter(|e| instance.is_none_or(|i| e.instance == i))
        .max_by_key(|e| (e.ts, e.seq))
        .map(|e| UsageSnapshot {
            instance: e.instance,
            session: e.session,
            ts: e.ts,
            limits: e.data["limits"].clone(),
            context: e.data.get("context").cloned(),
        })
}

/// Lee el fichero de eventos desde el final hacia atrás hasta dar con un sobre que tenga límites. El fichero
/// crece sin parar y tmux pregunta cada pocos segundos: leerlo entero cada vez no escala. Nod añade los sobres
/// al final en orden de entrega, así que el primero con límites empezando por el final es el más reciente
/// (salvo dos sesiones entregando a la vez, donde la diferencia es de segundos). `None` si el fichero no existe.
pub fn latest_from_file(
    path: &Path,
    instance: Option<&str>,
) -> std::io::Result<Option<UsageSnapshot>> {
    let mut f = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    const BLOCK: u64 = 64 * 1024;
    let mut pos = f.seek(SeekFrom::End(0))?;
    // Bytes leídos que aún no forman una línea completa (el principio de la línea queda más atrás).
    let mut tail: Vec<u8> = Vec::new();
    while pos > 0 {
        let start = pos.saturating_sub(BLOCK);
        let mut buf = vec![0; (pos - start) as usize];
        f.seek(SeekFrom::Start(start))?;
        f.read_exact(&mut buf)?;
        buf.extend_from_slice(&tail);
        pos = start;
        // Todo lo que va tras el primer salto de línea son líneas completas; lo de antes, si no estamos al
        // principio del fichero, es el final de una línea que sigue más atrás.
        let cut = if pos == 0 {
            0
        } else {
            match buf.iter().position(|&b| b == b'\n') {
                Some(i) => i + 1,
                None => {
                    tail = buf;
                    continue;
                }
            }
        };
        for line in buf[cut..].split(|&b| b == b'\n').rev() {
            let Ok(line) = std::str::from_utf8(line) else {
                continue;
            };
            // Evita parsear sobres que no pueden tener límites.
            if !line.contains("\"limits\"") {
                continue;
            }
            if let Some(s) = latest_in_line(line, instance) {
                return Ok(Some(s));
            }
        }
        tail = buf[..cut].to_vec();
    }
    Ok(None)
}

fn short(kind: &str) -> Option<&'static str> {
    match kind {
        "five_hour" => Some("5h"),
        "seven_day" => Some("7d"),
        _ => None,
    }
}

/// `↻2h10`, `↻45m`, `↻6d12h`: lo que falta para la renovación (redondeado hacia arriba al minuto).
fn until(reset: i64, now: i64) -> String {
    let min = ((reset - now).max(0) + 59_999) / 60_000;
    if min >= 24 * 60 {
        format!("{}d{}h", min / 1440, min % 1440 / 60)
    } else if min >= 60 {
        format!("{}h{:02}", min / 60, min % 60)
    } else {
        format!("{min}m")
    }
}

/// Los límites de 5 h y 7 días que siguen vigentes. Uno cuya renovación ya pasó no dice nada de la ventana
/// actual (empezó otra y Nod aún no la ha visto): se omite en vez de mostrar un porcentaje viejo.
fn current(snap: &UsageSnapshot, now: i64) -> Vec<(&'static str, Limit)> {
    let ls = limits_of(snap);
    ["5h", "7d"]
        .into_iter()
        .filter_map(|want| {
            ls.iter()
                .find(|l| short(&l.kind) == Some(want))
                .filter(|l| l.resets_at.is_none_or(|r| r > now))
                .map(|l| (want, l.clone()))
        })
        .collect()
}

/// Línea para `status-right` de tmux: `5h 37% ↻2h10 · 7d 12%`. Rojo desde el 80 %, amarillo desde el 50 %.
/// Vacía sin datos: tmux no muestra nada y la barra no queda con un hueco raro.
pub fn tmux(snap: Option<&UsageSnapshot>, now: i64) -> String {
    let Some(snap) = snap else {
        return String::new();
    };
    current(snap, now)
        .into_iter()
        .map(|(label, l)| {
            // El color sigue al número que se ve: un 49.6 que se muestra como «50%» ya va en amarillo.
            let shown = l.percent_used.round();
            let mut s = format!("{label} {shown:.0}%");
            if label == "5h" {
                if let Some(r) = l.resets_at {
                    s.push_str(&format!(" ↻{}", until(r, now)));
                }
            }
            let color = if shown >= 80.0 {
                Some("red")
            } else if shown >= 50.0 {
                Some("yellow")
            } else {
                None
            };
            match color {
                Some(c) => format!("#[fg={c}]{s}#[fg=default]"),
                None => s,
            }
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

pub fn text(snap: Option<&UsageSnapshot>, now: i64) -> String {
    let Some(snap) = snap else {
        return String::new();
    };
    let parts: Vec<String> = current(snap, now)
        .into_iter()
        .map(|(label, l)| match l.resets_at {
            Some(r) => format!(
                "{label}: {:.0} % (se renueva en {}, {})",
                l.percent_used,
                until(r, now),
                crate::time::fmt_utc(r)
            ),
            None => format!("{label}: {:.0} %", l.percent_used),
        })
        .collect();
    if parts.is_empty() {
        return String::new();
    }
    let age = (now - snap.ts).max(0) / 60_000;
    format!("{} · {} (hace {age} min)", parts.join(" · "), snap.instance)
}

pub fn json(snap: Option<&UsageSnapshot>, now: i64) -> String {
    let Some(snap) = snap else {
        return String::new();
    };
    let cur = current(snap, now);
    if cur.is_empty() {
        return String::new();
    }
    let lim = |label: &str| {
        cur.iter()
            .find(|(l, _)| *l == label)
            .map(|(_, l)| json!({ "percent_used": l.percent_used, "resets_at": l.resets_at }))
    };
    json!({
        "instance": snap.instance,
        "session": snap.session,
        "ts": snap.ts,
        "five_hour": lim("5h"),
        "seven_day": lim("7d"),
        "limits": snap.limits,
        "context": snap.context,
    })
    .to_string()
}
