//! nod-collector: recibe y guarda eventos Nod v1 (`docs/nod-v1.md`), calcula métricas por tarea y da los
//! límites de uso para la barra de tmux.

pub mod envelope;
pub mod limits;
pub mod report;
pub mod server;
pub mod store;
pub mod time;

use std::io::{BufRead, BufReader};
use std::path::Path;

/// Resultado de importar un fichero del destino de tipo fichero.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ImportStats {
    pub envelopes: usize,
    pub accepted: usize,
    pub duplicates: usize,
    /// Líneas que no son un sobre válido: (número de línea, motivo).
    pub invalid: Vec<(usize, String)>,
}

/// Carga un fichero JSONL de sobres (una línea = un sobre, §1.2). Las líneas inválidas se saltan y se cuentan:
/// una línea cortada (Nod escribiendo mientras se importa) no debe impedir cargar el resto. Todo el fichero va
/// en una sola transacción.
pub fn import_file(store: &mut store::Store, path: &Path) -> Result<ImportStats, String> {
    let f = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut stats = ImportStats::default();
    let mut events = Vec::new();
    for (i, line) in BufReader::new(f).lines().enumerate() {
        let line = line.map_err(|e| format!("{}: {e}", path.display()))?;
        if line.trim().is_empty() {
            continue;
        }
        let parsed = serde_json::from_str(&line)
            .map_err(|e| format!("JSON inválido: {e}"))
            .and_then(|v| envelope::parse_envelope(&v));
        match parsed {
            Ok(evs) => {
                stats.envelopes += 1;
                events.extend(evs);
            }
            Err(e) => stats.invalid.push((i + 1, e)),
        }
    }
    let (a, d) = store.insert(&events, time::now_ms())?;
    stats.accepted = a;
    stats.duplicates = d;
    Ok(stats)
}
