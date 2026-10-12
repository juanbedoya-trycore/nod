//! nod-collector: la línea de comandos. Los argumentos se leen a mano: son pocos, y así la ayuda y los errores
//! salen en español sin arrastrar un parser.

use nod_collector::{import_file, limits, report, server, store, time};
use std::path::PathBuf;
use std::process::ExitCode;

const HELP: &str = "\
nod-collector: recibe eventos Nod v1, calcula métricas por tarea y da los límites de uso.

Uso:
  nod-collector serve  [--listen 127.0.0.1:8787] [--db <ruta>] [--token-file <ruta>]
  nod-collector import <fichero.jsonl>... [--db <ruta>]
  nod-collector report [--task T] [--session S] [--since 7d|24h|<fecha>] [--json] [--db <ruta>]
  nod-collector limits [--from-file <events.jsonl>] [--db <ruta>] [--instance I] [--format tmux|text|json]

La db por defecto es $XDG_STATE_HOME/nod/nod.db (o ~/.local/state/nod/nod.db).
Las fechas de --since son YYYY-MM-DD o RFC 3339; sin zona se leen en UTC.
";

/// Argumentos de un subcomando: `--opción valor`, `--opción=valor`, banderas y posicionales.
struct Args {
    opts: Vec<(String, Option<String>)>,
    positional: Vec<String>,
}

impl Args {
    fn parse(raw: &[String], with_value: &[&str], flags: &[&str]) -> Result<Args, String> {
        let mut a = Args {
            opts: Vec::new(),
            positional: Vec::new(),
        };
        let mut it = raw.iter();
        while let Some(s) = it.next() {
            if let Some(name) = s.strip_prefix("--") {
                let (name, inline) = match name.split_once('=') {
                    Some((n, v)) => (n, Some(v.to_string())),
                    None => (name, None),
                };
                if with_value.contains(&name) {
                    let v = match inline {
                        Some(v) => v,
                        None => it
                            .next()
                            .cloned()
                            .ok_or(format!("--{name} necesita un valor"))?,
                    };
                    a.opts.push((name.into(), Some(v)));
                } else if flags.contains(&name) && inline.is_none() {
                    a.opts.push((name.into(), None));
                } else {
                    return Err(format!("opción desconocida: --{name}"));
                }
            } else {
                a.positional.push(s.clone());
            }
        }
        Ok(a)
    }
    fn get(&self, name: &str) -> Option<&str> {
        self.opts
            .iter()
            .rev()
            .find(|(n, _)| n == name)
            .and_then(|(_, v)| v.as_deref())
    }
    fn flag(&self, name: &str) -> bool {
        self.opts.iter().any(|(n, _)| n == name)
    }
    fn db(&self) -> PathBuf {
        self.get("db")
            .map(expand)
            .unwrap_or_else(store::default_db_path)
    }
}

/// `~/…` → `$HOME/…`, para rutas puestas entre comillas o en ficheros de configuración.
fn expand(p: &str) -> PathBuf {
    match (p.strip_prefix("~/"), std::env::var_os("HOME")) {
        (Some(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => PathBuf::from(p),
    }
}

fn serve(a: &Args) -> Result<(), String> {
    let listen = a.get("listen").unwrap_or("127.0.0.1:8787");
    let db = a.db();
    let token = match a.get("token-file") {
        None => None,
        Some(p) => {
            let t =
                std::fs::read_to_string(expand(p)).map_err(|e| format!("--token-file {p}: {e}"))?;
            let t = t.trim().to_string();
            if t.is_empty() {
                return Err(format!("--token-file {p}: está vacío"));
            }
            Some(t)
        }
    };
    let st = store::Store::open(&db)?;
    let c = server::Collector::bind(listen, st, token.clone())?;
    eprintln!(
        "nod-collector: escuchando en http://{} (db {}, {})",
        c.addr()
            .map(|a| a.to_string())
            .unwrap_or_else(|| listen.into()),
        db.display(),
        if token.is_some() {
            "con token"
        } else {
            "sin token"
        }
    );
    c.run(true);
    Ok(())
}

fn import(a: &Args) -> Result<ExitCode, String> {
    if a.positional.is_empty() {
        return Err("import: falta al menos un fichero .jsonl".into());
    }
    let mut st = store::Store::open(&a.db())?;
    let mut code = ExitCode::SUCCESS;
    for f in &a.positional {
        let s = import_file(&mut st, &expand(f))?;
        println!(
            "{f}: {} sobres, {} eventos nuevos, {} duplicados{}",
            s.envelopes,
            s.accepted,
            s.duplicates,
            if s.invalid.is_empty() {
                String::new()
            } else {
                format!(", {} líneas inválidas", s.invalid.len())
            }
        );
        for (line, why) in s.invalid.iter().take(5) {
            eprintln!("  línea {line}: {why}");
        }
        // Lo válido ya está dentro; el código de salida avisa de que algo se quedó fuera.
        if !s.invalid.is_empty() {
            code = ExitCode::FAILURE;
        }
    }
    Ok(code)
}

fn report(a: &Args) -> Result<(), String> {
    let since = match a.get("since") {
        None => None,
        Some(s) => Some(time::parse_since(s, time::now_ms()).ok_or(format!(
            "--since {s}: usa 30m, 24h, 7d, 2w, YYYY-MM-DD o una fecha RFC 3339"
        ))?),
    };
    let filter = store::Filter {
        task: a.get("task").map(String::from),
        session: a.get("session").map(String::from),
        since,
    };
    let db = a.db();
    let events = match store::Store::open_read_only(&db)? {
        Some(st) => st.events(&filter)?,
        None => Vec::new(),
    };
    let r = report::build(&events, filter.session.is_some());
    if a.flag("json") {
        println!(
            "{}",
            serde_json::to_string_pretty(&r).map_err(|e| e.to_string())?
        );
    } else {
        print!("{}", report::render(&r));
    }
    Ok(())
}

fn limits_cmd(a: &Args) -> Result<(), String> {
    let instance = a.get("instance");
    let snap = match a.get("from-file") {
        Some(f) => {
            limits::latest_from_file(&expand(f), instance).map_err(|e| format!("{f}: {e}"))?
        }
        None => match store::Store::open_read_only(&a.db())? {
            Some(st) => st.latest_limit(instance)?,
            None => None,
        },
    };
    let now = time::now_ms();
    let out = match a.get("format").unwrap_or("text") {
        "tmux" => limits::tmux(snap.as_ref(), now),
        "text" => limits::text(snap.as_ref(), now),
        "json" => limits::json(snap.as_ref(), now),
        f => return Err(format!("--format {f}: usa tmux, text o json")),
    };
    // Sin datos no se imprime nada, ni siquiera el salto de línea.
    if !out.is_empty() {
        println!("{out}");
    }
    Ok(())
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let Some((cmd, rest)) = argv.split_first() else {
        eprint!("{HELP}");
        return ExitCode::from(2);
    };
    if rest.iter().any(|a| a == "-h" || a == "--help")
        || matches!(cmd.as_str(), "-h" | "--help" | "help")
    {
        print!("{HELP}");
        return ExitCode::SUCCESS;
    }
    let result = match cmd.as_str() {
        "serve" => Args::parse(rest, &["listen", "db", "token-file"], &[])
            .and_then(|a| serve(&a).map(|_| ExitCode::SUCCESS)),
        "import" => Args::parse(rest, &["db"], &[]).and_then(|a| import(&a)),
        "report" => Args::parse(rest, &["task", "session", "since", "db"], &["json"])
            .and_then(|a| report(&a).map(|_| ExitCode::SUCCESS)),
        "limits" => Args::parse(rest, &["from-file", "db", "format", "instance"], &[])
            .and_then(|a| limits_cmd(&a).map(|_| ExitCode::SUCCESS)),
        other => Err(format!("comando desconocido: {other} (prueba --help)")),
    };
    match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("nod-collector: {e}");
            ExitCode::FAILURE
        }
    }
}
