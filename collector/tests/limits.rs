//! `limits`: formato tmux con umbrales, datos vacíos y lectura del fichero del destino.

mod common;

use nod_collector::limits::{json, latest_from_file, text, tmux};
use nod_collector::store::{Store, UsageSnapshot};
use nod_collector::time::parse_datetime;
use serde_json::json as j;

fn snap(five: f64, seven: f64, resets5: &str, resets7: &str) -> UsageSnapshot {
    UsageSnapshot {
        instance: "personal-0001".into(),
        session: "s".into(),
        ts: 0,
        limits: j!([
            { "kind": "five_hour", "percent_used": five, "resets_at": resets5 },
            { "kind": "seven_day", "percent_used": seven, "resets_at": resets7 },
            { "kind": "seven_day_opus", "percent_used": 99 }
        ]),
        context: None,
    }
}

fn now() -> i64 {
    parse_datetime("2026-10-12T20:50:00Z").unwrap()
}

#[test]
fn tmux_umbrales() {
    let r5 = "2026-10-12T23:00:00.000Z"; // dentro de 2 h 10 min
    let r7 = "2026-10-19T10:00:00.000Z";
    assert_eq!(
        tmux(Some(&snap(37.0, 12.0, r5, r7)), now()),
        "5h 37% ↻2h10 · 7d 12%"
    );
    assert_eq!(
        tmux(Some(&snap(50.0, 49.6, r5, r7)), now()),
        "#[fg=yellow]5h 50% ↻2h10#[fg=default] · #[fg=yellow]7d 50%#[fg=default]"
    );
    assert_eq!(
        tmux(Some(&snap(80.0, 79.0, r5, r7)), now()),
        "#[fg=red]5h 80% ↻2h10#[fg=default] · #[fg=yellow]7d 79%#[fg=default]"
    );
    assert_eq!(
        tmux(Some(&snap(100.0, 85.0, "2026-10-12T21:05:30Z", r7)), now()),
        "#[fg=red]5h 100% ↻16m#[fg=default] · #[fg=red]7d 85%#[fg=default]"
    );
}

#[test]
fn ventanas_vencidas_y_vacio() {
    let r7 = "2026-10-19T10:00:00.000Z";
    // La ventana de 5 h ya se renovó: su porcentaje es de la anterior y no se muestra.
    assert_eq!(
        tmux(Some(&snap(90.0, 12.0, "2026-10-12T20:00:00Z", r7)), now()),
        "7d 12%"
    );
    assert_eq!(
        tmux(
            Some(&snap(
                90.0,
                12.0,
                "2026-10-12T20:00:00Z",
                "2026-10-12T20:00:00Z"
            )),
            now()
        ),
        ""
    );
    assert_eq!(tmux(None, now()), "");
    assert_eq!(text(None, now()), "");
    assert_eq!(json(None, now()), "");
    let only_other = UsageSnapshot {
        limits: j!([{ "kind": "seven_day_opus", "percent_used": 3 }]),
        ..snap(0.0, 0.0, "", "")
    };
    assert_eq!(tmux(Some(&only_other), now()), "");
    assert!(
        text(Some(&snap(37.0, 12.0, "2026-10-12T23:00:00Z", r7)), now())
            .starts_with("5h: 37 % (se renueva en 2h10")
    );
}

#[test]
fn desde_el_fichero_y_desde_la_db() {
    let dir = common::tempdir("limites");
    let f = dir.join("events.jsonl");
    // Sin fichero: sin datos, sin error.
    assert_eq!(latest_from_file(&f, None).unwrap(), None);

    // El fixture real, y detrás sobres sin límites hasta pasar de varios bloques de lectura (64 KiB): el último
    // con límites queda lejos del final.
    let mut body = common::fixture_lines().join("\n") + "\n";
    let filler = j!({ "nod": 1, "source": { "instance": "personal-0001", "run": "0a0b0c0d", "host": "claude", "profile": "personal", "privacy": "completo" },
        "events": [{ "seq": 1, "ts": 1, "type": "prompt.submit", "session": "s", "data": { "origin": "composer", "chars": 1, "text": "x".repeat(1000) } }] });
    for _ in 0..300 {
        body.push_str(&filler.to_string());
        body.push('\n');
    }
    body.push_str("{\"nod\":1,\"events\":[{\"type\":\"usage\",\"data\":{\"limits\""); // línea a medio escribir
    std::fs::write(&f, &body).unwrap();
    assert!(body.len() > 4 * 64 * 1024);

    let s = latest_from_file(&f, None).unwrap().expect("límites");
    assert_eq!(
        (s.instance.as_str(), s.ts),
        ("personal-c1254137", 1791840817532)
    );
    assert_eq!(s.limits[0]["percent_used"], 15);
    assert_eq!(latest_from_file(&f, Some("otra")).unwrap(), None);

    let at = parse_datetime("2026-10-12T21:40:00Z").unwrap();
    assert_eq!(tmux(Some(&s), at), "5h 15% ↻1h20 · 7d 2%");

    // La db da lo mismo.
    let mut st = Store::open_memory().unwrap();
    nod_collector::import_file(&mut st, &common::fixture()).unwrap();
    assert_eq!(st.latest_limit(None).unwrap().as_ref(), Some(&s));
}

#[test]
fn por_sesion_contexto_y_limites_de_su_cuenta() {
    use nod_collector::limits::{for_session, session_from_file, tmux_session};
    let r5 = "2026-10-12T23:00:00.000Z";
    let r7 = "2026-10-19T10:00:00.000Z";
    // El contexto es de la sesión; los límites, del `usage` más reciente de su instancia.
    let ctx = UsageSnapshot {
        ts: 10,
        context: Some(j!({ "percent": 63, "tokens": 630000, "window": 1000000 })),
        ..snap(20.0, 5.0, r5, r7)
    };
    let newer = UsageSnapshot {
        ts: 20,
        session: "otra".into(),
        ..snap(37.0, 12.0, r5, r7)
    };
    let s = for_session(ctx.clone(), Some(newer.clone()));
    assert_eq!((s.session.as_str(), s.ts), ("s", 20));
    assert_eq!(
        tmux_session(Some(&s), now()),
        "#[fg=yellow]ctx 63%#[fg=default] · 5h 37% ↻2h10 · 7d 12%"
    );
    // MiniMax (`limits: []`) u OpenCode (sin el campo) no gastan los límites de la cuenta: no los toman
    // prestados de otra sesión y queda solo el contexto. Sin datos, nada.
    for limits in [j!([]), serde_json::Value::Null] {
        let third = UsageSnapshot {
            limits,
            ..ctx.clone()
        };
        let s = for_session(third.clone(), Some(newer.clone()));
        assert_eq!(s, third);
        assert_eq!(
            tmux_session(Some(&s), now()),
            "#[fg=yellow]ctx 63%#[fg=default]"
        );
    }
    assert_eq!(tmux_session(None, now()), "");
    // Un `limits: []` tampoco tapa los de la cuenta en la barra general.
    let dir = common::tempdir("limites-vacios");
    let f = dir.join("events.jsonl");
    let empty = j!({ "nod": 1, "source": { "instance": "personal-c1254137", "run": "0a0b0c0d", "host": "claude", "profile": "personal", "privacy": "completo" },
        "events": [{ "seq": 1, "ts": 1791840817533_i64, "type": "usage", "session": "mm", "data": { "limits": [], "context": { "percent": 9 } } }] });
    std::fs::write(
        &f,
        common::fixture_lines().join("\n") + "\n" + &empty.to_string() + "\n",
    )
    .unwrap();
    assert_eq!(
        latest_from_file(&f, None).unwrap().unwrap().ts,
        1791840817532
    );

    // Del fichero y de la db sale la misma sesión.
    let dir = common::tempdir("limites-sesion");
    let f = dir.join("events.jsonl");
    std::fs::write(&f, common::fixture_lines().join("\n") + "\n").unwrap();
    let last = latest_from_file(&f, None).unwrap().expect("límites");
    let from_file = session_from_file(&f, &last.session)
        .unwrap()
        .expect("sesión");
    assert_eq!(from_file.session, last.session);
    assert!(from_file.context.is_some());
    assert_eq!(session_from_file(&f, "no-existe").unwrap(), None);
    let mut st = Store::open_memory().unwrap();
    nod_collector::import_file(&mut st, &common::fixture()).unwrap();
    assert_eq!(
        st.latest_session_usage(&last.session).unwrap().as_ref(),
        Some(&from_file)
    );
}
