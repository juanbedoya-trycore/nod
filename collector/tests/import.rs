//! `import` del destino de tipo fichero, por la biblioteca y por el binario.

mod common;

use nod_collector::store::{Filter, Store};
use nod_collector::{import_file, ImportStats};
use std::process::Command;

#[test]
fn import_del_fixture_dos_veces() {
    let mut st = Store::open_memory().unwrap();
    let first = import_file(&mut st, &common::fixture()).unwrap();
    assert_eq!(
        first,
        ImportStats {
            envelopes: 8,
            accepted: 13,
            duplicates: 0,
            invalid: vec![]
        }
    );
    let second = import_file(&mut st, &common::fixture()).unwrap();
    assert_eq!(
        second,
        ImportStats {
            envelopes: 8,
            accepted: 0,
            duplicates: 13,
            invalid: vec![]
        }
    );
    assert_eq!(st.count().unwrap(), 13);

    let evs = st.events(&Filter::default()).unwrap();
    assert_eq!(evs.first().unwrap().kind, "session.start");
    assert_eq!(evs.last().unwrap().kind, "session.end");
    let m = nod_collector::report::build(&evs, false).total;
    assert_eq!(m.tokens_total, 4 + 340 + 72318 + 14849);
    assert_eq!(m.time.agent_ms, 26943);
    assert_eq!(m.time.waiting_ms, 3962);
}

#[test]
fn lineas_invalidas_se_saltan_y_se_cuentan() {
    let dir = common::tempdir("invalidas");
    let f = dir.join("events.jsonl");
    let lines = common::fixture_lines();
    // Una línea cortada (Nod escribiendo) y un sobre de otra versión entre sobres buenos.
    let body = format!(
        "{}\n{{\"nod\":1,\"sou\n{}\n{{\"nod\":2}}\n\n",
        lines[0], lines[1]
    );
    std::fs::write(&f, body).unwrap();
    let mut st = Store::open_memory().unwrap();
    let s = import_file(&mut st, &f).unwrap();
    assert_eq!((s.envelopes, s.accepted), (2, 3));
    assert_eq!(
        s.invalid.iter().map(|(n, _)| *n).collect::<Vec<_>>(),
        vec![2, 4]
    );
}

#[test]
fn binario_import_report_y_limits() {
    let dir = common::tempdir("binario");
    let db = dir.join("sub/nod.db");
    let bin = env!("CARGO_BIN_EXE_nod-collector");
    let run = |args: &[&str]| {
        let o = Command::new(bin)
            .args(args)
            .env_remove("XDG_STATE_HOME")
            .output()
            .unwrap();
        (
            o.status.code(),
            String::from_utf8(o.stdout).unwrap(),
            String::from_utf8(o.stderr).unwrap(),
        )
    };
    let fx = common::fixture();
    let fx = fx.to_str().unwrap();
    let db = db.to_str().unwrap();

    // Sin db aún: limits no imprime nada y sale con 0; report dice que no hay eventos.
    assert_eq!(
        run(&["limits", "--db", db, "--format", "tmux"]),
        (Some(0), String::new(), String::new())
    );
    assert!(run(&["report", "--db", db]).1.contains("Sin eventos"));

    let (code, out, _) = run(&["import", fx, "--db", db]);
    assert_eq!(code, Some(0));
    assert!(
        out.contains("8 sobres, 13 eventos nuevos, 0 duplicados"),
        "{out}"
    );
    let (code, out, _) = run(&["import", fx, "--db", db]);
    assert_eq!(code, Some(0));
    assert!(out.contains("0 eventos nuevos, 13 duplicados"), "{out}");

    let (code, out, _) = run(&["report", "--db", db, "--json"]);
    assert_eq!(code, Some(0));
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["total"]["tokens_total"], 87511);
    assert_eq!(v["groups"][0]["task"], serde_json::Value::Null);

    // El límite de 5 h del fixture se renovó el 12-10-2026 a las 23:00Z; el de 7 días, el 19-10. Lo que se vea
    // depende de la fecha en que corra el test, pero la salida nunca es un error.
    let (code, _, err) = run(&["limits", "--db", db, "--format", "json"]);
    assert_eq!((code, err.as_str()), (Some(0), ""));

    let (code, _, err) = run(&["limits", "--format", "rara", "--db", db]);
    assert_eq!(code, Some(1));
    assert!(err.contains("--format rara"));
    let (code, _, err) = run(&["report", "--since", "ayer", "--db", db]);
    assert_eq!(code, Some(1));
    assert!(err.contains("--since"));

    // Un fichero con una línea mala: importa lo bueno pero sale con 1.
    let bad = dir.join("malo.jsonl");
    std::fs::write(&bad, "{\"nod\":2}\n").unwrap();
    assert_eq!(
        run(&["import", bad.to_str().unwrap(), "--db", db]).0,
        Some(1)
    );
}
