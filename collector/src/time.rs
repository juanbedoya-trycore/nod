//! Fechas sin dependencias: Nod da `ts` en milisegundos Unix y `resets_at` en RFC 3339; aquí solo hace falta
//! pasar de uno a otro, interpretar `--since` y escribir fechas legibles (siempre en UTC).

use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Días desde 1970-01-01 de una fecha civil (algoritmo de H. Hinnant, válido para todo el calendario gregoriano).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (
        if m <= 2 {
            yoe + era * 400 + 1
        } else {
            yoe + era * 400
        },
        m,
        d,
    )
}

fn num(s: &str) -> Option<i64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// `YYYY-MM-DD`, o `YYYY-MM-DDTHH:MM[:SS[.fff]]` con `Z`, `±HH:MM` o sin zona (= UTC). Devuelve ms Unix.
pub fn parse_datetime(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.len() < 10 {
        return None;
    }
    let (date, rest) = s.split_at(10);
    let mut parts = date.split('-');
    let (y, mo, d) = (
        num(parts.next()?)?,
        num(parts.next()?)?,
        num(parts.next()?)?,
    );
    if parts.next().is_some() || !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let mut ms = days_from_civil(y, mo, d) * 86_400_000;
    if rest.is_empty() {
        return Some(ms);
    }
    let rest = rest.strip_prefix(['T', 't', ' '])?;
    // La zona es lo que va tras la hora: Z, +HH:MM o -HH:MM.
    let (clock, offset_ms) = if let Some(c) = rest.strip_suffix(['Z', 'z']) {
        (c, 0)
    } else if let Some(i) = rest.rfind(['+', '-']) {
        let (c, z) = rest.split_at(i);
        let sign = if z.starts_with('-') { -1 } else { 1 };
        let mut hm = z[1..].split(':');
        let (h, m) = (num(hm.next()?)?, num(hm.next().unwrap_or("0"))?);
        (c, sign * (h * 3_600_000 + m * 60_000))
    } else {
        (rest, 0)
    };
    let mut hms = clock.split(':');
    let h = num(hms.next()?)?;
    let mi = num(hms.next()?)?;
    let (sec, frac) = match hms.next() {
        None => (0, 0),
        Some(sf) => match sf.split_once('.') {
            None => (num(sf)?, 0),
            Some((s, f)) => {
                // Solo los milisegundos: lo que sobra no cabe en un ts de Nod.
                let f3: String = f.chars().chain("000".chars()).take(3).collect();
                num(f)?;
                (num(s)?, num(&f3)?)
            }
        },
    };
    if hms.next().is_some() || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    ms += h * 3_600_000 + mi * 60_000 + sec * 1000 + frac;
    Some(ms - offset_ms)
}

/// `--since`: una duración hacia atrás (`30m`, `24h`, `7d`, `2w`) o una fecha de [`parse_datetime`].
pub fn parse_since(s: &str, now: i64) -> Option<i64> {
    let s = s.trim();
    if let Some(unit) = s.chars().last() {
        let n = &s[..s.len() - unit.len_utf8()];
        let per = match unit {
            'm' => Some(60_000),
            'h' => Some(3_600_000),
            'd' => Some(86_400_000),
            'w' => Some(7 * 86_400_000),
            _ => None,
        };
        if let (Some(per), Some(n)) = (per, num(n)) {
            return Some(now - n * per);
        }
    }
    parse_datetime(s)
}

/// `2026-10-12 23:00Z`: corta y sin ambigüedad de zona.
pub fn fmt_utc(ms: i64) -> String {
    let (y, m, d) = civil_from_days(ms.div_euclid(86_400_000));
    let t = ms.rem_euclid(86_400_000) / 60_000;
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}Z", t / 60, t % 60)
}

/// Duración legible: `850 ms`, `12.4 s`, `3m 05s`, `1h 02m`.
pub fn fmt_duration(ms: u64) -> String {
    if ms < 1000 {
        format!("{ms} ms")
    } else if ms < 60_000 {
        format!("{:.1} s", ms as f64 / 1000.0)
    } else if ms < 3_600_000 {
        format!("{}m {:02}s", ms / 60_000, ms % 60_000 / 1000)
    } else {
        format!("{}h {:02}m", ms / 3_600_000, ms % 3_600_000 / 60_000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fechas() {
        assert_eq!(parse_datetime("1970-01-01"), Some(0));
        assert_eq!(
            parse_datetime("2026-10-12T23:00:00.000Z"),
            Some(1_791_846_000_000)
        );
        assert_eq!(
            parse_datetime("2026-10-12T18:00-05:00"),
            Some(1_791_846_000_000)
        );
        assert_eq!(
            parse_datetime("2026-10-12 23:00:00.5Z"),
            Some(1_791_846_000_500)
        );
        assert_eq!(parse_datetime("2026-13-01"), None);
        assert_eq!(parse_datetime("ayer"), None);
        assert_eq!(fmt_utc(1_791_846_000_000), "2026-10-12 23:00Z");
        for z in [-800_000, -1, 0, 59, 20_000, 1_000_000] {
            let (y, m, d) = civil_from_days(z);
            assert_eq!(days_from_civil(y, m, d), z);
        }
    }

    #[test]
    fn since() {
        assert_eq!(
            parse_since("24h", 100_000_000),
            Some(100_000_000 - 86_400_000)
        );
        assert_eq!(parse_since("7d", 0), Some(-7 * 86_400_000));
        assert_eq!(parse_since("2026-10-12", 0), Some(1_791_763_200_000));
        assert_eq!(parse_since("7x", 0), None);
    }
}
