//! Almacén SQLite. Una fila por evento; la clave primaria es la identidad del contrato (§1.3:
//! instance, run, seq), así que una entrega repetida (Nod entrega al menos una vez) o un `import` del mismo
//! fichero no duplican nada.

use crate::envelope::Event;
use rusqlite::{params, Connection, OpenFlags};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub type Result<T> = std::result::Result<T, String>;

fn err(e: rusqlite::Error) -> String {
    format!("sqlite: {e}")
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS events (
  instance    TEXT    NOT NULL,
  run         TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  type        TEXT    NOT NULL,
  session     TEXT    NOT NULL,
  turn        TEXT,
  agent       TEXT,
  task        TEXT,
  privacy     TEXT    NOT NULL,
  host        TEXT    NOT NULL,
  profile     TEXT    NOT NULL,
  data        TEXT    NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (instance, run, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS events_type_ts ON events (type, instance, ts);
CREATE INDEX IF NOT EXISTS events_task ON events (task, ts);
CREATE INDEX IF NOT EXISTS events_session ON events (session, ts);
";

/// `$XDG_STATE_HOME/nod/nod.db`, o `~/.local/state/nod/nod.db` (donde Nod deja también su fichero de eventos).
pub fn default_db_path() -> PathBuf {
    let state = std::env::var_os("XDG_STATE_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/state")
        });
    state.join("nod/nod.db")
}

/// Filtros de `report`. `since` en ms Unix.
#[derive(Debug, Default, Clone)]
pub struct Filter {
    pub task: Option<String>,
    pub session: Option<String>,
    pub since: Option<i64>,
}

/// La última instantánea `usage` con límites de una instancia.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct UsageSnapshot {
    pub instance: String,
    pub session: String,
    pub ts: i64,
    pub limits: Value,
    pub context: Option<Value>,
}

pub struct Store {
    conn: Connection,
}

impl Store {
    /// Abre (o crea) la base de datos, con sus directorios.
    pub fn open(path: &Path) -> Result<Store> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("no puedo crear {}: {e}", dir.display()))?;
        }
        let conn = Connection::open(path).map_err(err)?;
        Self::init(conn, true)
    }

    pub fn open_memory() -> Result<Store> {
        Self::init(Connection::open_in_memory().map_err(err)?, true)
    }

    /// Solo lectura, para `limits` y `report`: `None` si la base de datos no existe (no se crea por consultar).
    pub fn open_read_only(path: &Path) -> Result<Option<Store>> {
        if !path.exists() {
            return Ok(None);
        }
        let conn =
            Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(err)?;
        Self::init(conn, false).map(Some)
    }

    fn init(conn: Connection, write: bool) -> Result<Store> {
        // El servidor escribe mientras tmux consulta límites cada pocos segundos: WAL deja leer sin bloquear.
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(err)?;
        if write {
            conn.pragma_update(None, "journal_mode", "WAL")
                .map_err(err)?;
            conn.execute_batch(SCHEMA).map_err(err)?;
        }
        Ok(Store { conn })
    }

    /// Inserta los eventos en una transacción. Devuelve (nuevos, duplicados).
    pub fn insert(&mut self, events: &[Event], received_at: i64) -> Result<(usize, usize)> {
        let tx = self.conn.transaction().map_err(err)?;
        let mut accepted = 0;
        {
            let mut st = tx
                .prepare_cached(
                    "INSERT OR IGNORE INTO events (instance, run, seq, ts, type, session, turn, agent, task,
                       privacy, host, profile, data, received_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                )
                .map_err(err)?;
            for e in events {
                accepted += st
                    .execute(params![
                        e.instance,
                        e.run,
                        e.seq,
                        e.ts,
                        e.kind,
                        e.session,
                        e.turn,
                        e.agent,
                        e.task,
                        e.privacy,
                        e.host,
                        e.profile,
                        e.data.to_string(),
                        received_at
                    ])
                    .map_err(err)?;
            }
        }
        tx.commit().map_err(err)?;
        Ok((accepted, events.len() - accepted))
    }

    pub fn count(&self) -> Result<i64> {
        self.conn
            .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
            .map_err(err)
    }

    /// Eventos que cumplen el filtro, en orden de tiempo (y de seq dentro de una ejecución).
    pub fn events(&self, f: &Filter) -> Result<Vec<Event>> {
        let mut st = self
            .conn
            .prepare(
                "SELECT instance, run, seq, ts, type, session, turn, agent, task, privacy, host, profile, data
                 FROM events
                 WHERE (?1 IS NULL OR task = ?1) AND (?2 IS NULL OR session = ?2) AND (?3 IS NULL OR ts >= ?3)
                 ORDER BY ts, instance, run, seq",
            )
            .map_err(err)?;
        let rows = st
            .query_map(params![f.task, f.session, f.since], |r| {
                let data: String = r.get(12)?;
                Ok(Event {
                    instance: r.get(0)?,
                    run: r.get(1)?,
                    seq: r.get(2)?,
                    ts: r.get(3)?,
                    kind: r.get(4)?,
                    session: r.get(5)?,
                    turn: r.get(6)?,
                    agent: r.get(7)?,
                    task: r.get(8)?,
                    privacy: r.get(9)?,
                    host: r.get(10)?,
                    profile: r.get(11)?,
                    data: serde_json::from_str(&data).unwrap_or(Value::Null),
                })
            })
            .map_err(err)?;
        rows.collect::<std::result::Result<_, _>>().map_err(err)
    }

    /// Por instancia, el `usage` más reciente que trae `limits` (el último que dice algo de los límites; Nod los
    /// manda juntos con el contexto al final de cada turno principal).
    pub fn latest_limits(&self) -> Result<Vec<UsageSnapshot>> {
        let mut st = self
            .conn
            .prepare(
                "SELECT instance, session, ts, json_extract(data, '$.limits'), json_extract(data, '$.context')
                 FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY instance ORDER BY ts DESC, run DESC, seq DESC) AS n
                       FROM events
                       WHERE type = 'usage' AND json_type(data, '$.limits') = 'array')
                 WHERE n = 1
                 ORDER BY ts DESC",
            )
            .map_err(err)?;
        let rows = st
            .query_map([], |r| {
                let limits: String = r.get(3)?;
                let context: Option<String> = r.get(4)?;
                Ok(UsageSnapshot {
                    instance: r.get(0)?,
                    session: r.get(1)?,
                    ts: r.get(2)?,
                    limits: serde_json::from_str(&limits).unwrap_or(Value::Null),
                    context: context.and_then(|c| serde_json::from_str(&c).ok()),
                })
            })
            .map_err(err)?;
        rows.collect::<std::result::Result<_, _>>().map_err(err)
    }

    /// El `usage` con límites más reciente de todas las instancias (o de una).
    pub fn latest_limit(&self, instance: Option<&str>) -> Result<Option<UsageSnapshot>> {
        Ok(self
            .latest_limits()?
            .into_iter()
            .find(|s| instance.is_none_or(|i| s.instance == i)))
    }
}
