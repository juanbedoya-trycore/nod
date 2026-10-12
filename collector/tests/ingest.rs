//! `serve` de verdad: un servidor en un puerto libre y peticiones HTTP crudas.

mod common;

use nod_collector::server::{Collector, MAX_BODY};
use nod_collector::store::Store;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};

fn start(name: &str, token: Option<&str>) -> (SocketAddr, PathBuf) {
    let db = common::tempdir(name).join("nod.db");
    let c = Collector::bind(
        "127.0.0.1:0",
        Store::open(&db).unwrap(),
        token.map(String::from),
    )
    .unwrap();
    let addr = c.addr().unwrap();
    c.run(false);
    (addr, db)
}

/// Una petición HTTP/1.1 con `Connection: close`. El cuerpo se escribe en otro hilo: con un 413 el servidor
/// contesta sin leerlo y la escritura puede fallar; lo que cuenta es la respuesta.
fn request(
    addr: SocketAddr,
    method: &str,
    path: &str,
    body: Vec<u8>,
    token: Option<&str>,
) -> (u16, Value) {
    let mut s = TcpStream::connect(addr).unwrap();
    let auth = token
        .map(|t| format!("Authorization: Bearer {t}\r\n"))
        .unwrap_or_default();
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: test\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{auth}Connection: close\r\n\r\n",
        body.len()
    );
    let mut w = s.try_clone().unwrap();
    let writer = std::thread::spawn(move || {
        let _ = w.write_all(head.as_bytes());
        let _ = w.write_all(&body);
    });
    let mut raw = Vec::new();
    let _ = s.read_to_end(&mut raw);
    let _ = writer.join();
    let text = String::from_utf8_lossy(&raw);
    let status: u16 = text
        .split_whitespace()
        .nth(1)
        .expect("respuesta HTTP")
        .parse()
        .unwrap();
    let body = text.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("");
    (status, serde_json::from_str(body).unwrap_or(Value::Null))
}

fn post(addr: SocketAddr, body: impl Into<Vec<u8>>, token: Option<&str>) -> (u16, Value) {
    request(addr, "POST", "/v1/events", body.into(), token)
}

fn count(db: &Path) -> i64 {
    Store::open_read_only(db).unwrap().unwrap().count().unwrap()
}

fn envelope(events: Value) -> String {
    json!({
        "nod": 1,
        "source": { "instance": "personal-0001", "run": "0a0b0c0d", "host": "claude", "profile": "personal", "privacy": "redactado" },
        "events": events
    })
    .to_string()
}

#[test]
fn ingesta_del_fixture_y_duplicados() {
    let (addr, db) = start("ingesta", None);
    let mut accepted = 0;
    for l in common::fixture_lines() {
        let (st, r) = post(addr, l, None);
        assert_eq!(st, 200, "{r}");
        assert_eq!(r["duplicates"], 0);
        accepted += r["accepted"].as_u64().unwrap();
    }
    assert_eq!(accepted, 13);
    assert_eq!(count(&db), 13);

    // Nod entrega al menos una vez: todo otra vez, nada nuevo.
    let mut dups = 0;
    for l in common::fixture_lines() {
        let (st, r) = post(addr, l, None);
        assert_eq!(st, 200);
        assert_eq!(r["accepted"], 0);
        dups += r["duplicates"].as_u64().unwrap();
    }
    assert_eq!(dups, 13);
    assert_eq!(count(&db), 13);

    // Un lote con un evento nuevo y uno repetido.
    let mixed = envelope(json!([
        { "seq": 1, "ts": 1, "type": "command", "session": "s", "data": { "name": "exit" } },
        { "seq": 2, "ts": 2, "type": "command", "session": "s", "data": { "name": "exit" } }
    ]));
    assert_eq!(
        post(addr, mixed.clone(), None).1,
        json!({ "accepted": 2, "duplicates": 0 })
    );
    let again = envelope(json!([
        { "seq": 2, "ts": 2, "type": "command", "session": "s", "data": { "name": "exit" } },
        { "seq": 3, "ts": 3, "type": "un.tipo.futuro", "session": "s", "data": {} }
    ]));
    assert_eq!(
        post(addr, again, None).1,
        json!({ "accepted": 1, "duplicates": 1 })
    );
    assert_eq!(count(&db), 16);

    let (st, r) = request(addr, "GET", "/v1/limits", vec![], None);
    assert_eq!(st, 200);
    let inst = &r["instances"][0];
    assert_eq!(inst["instance"], "personal-c1254137");
    assert_eq!(inst["ts"], 1791840817532_i64);
    assert_eq!(inst["limits"][0]["kind"], "five_hour");
    assert_eq!(inst["context"]["percent"], 4);
    assert_eq!(r["instances"].as_array().unwrap().len(), 1);

    assert_eq!(request(addr, "GET", "/health", vec![], None).0, 200);
    assert_eq!(request(addr, "GET", "/nada", vec![], None).0, 404);
    assert_eq!(request(addr, "GET", "/v1/events", vec![], None).0, 405);
}

#[test]
fn sobres_invalidos_400_sin_tocar_nada() {
    let (addr, db) = start("invalidos", None);
    let ok =
        json!({ "seq": 1, "ts": 1, "type": "command", "session": "s", "data": { "name": "x" } });
    let src = json!({ "instance": "personal-0001", "run": "0a0b0c0d", "host": "claude", "profile": "personal", "privacy": "completo" });
    let mut bad_run = src.clone();
    bad_run["run"] = json!("0A0B0C0D");
    let mut bad_instance = src.clone();
    bad_instance["instance"] = json!("Personal");
    let mut bad_privacy = src.clone();
    bad_privacy["privacy"] = json!("total");
    let mut no_profile = src.clone();
    no_profile.as_object_mut().unwrap().remove("profile");
    let env = |source: &Value, events: Value| {
        json!({ "nod": 1, "source": source, "events": events }).to_string()
    };

    let cases = vec![
        ("no es JSON", "{nod".to_string()),
        (
            "nod 2",
            json!({ "nod": 2, "source": src, "events": [ok] }).to_string(),
        ),
        (
            "sin nod",
            json!({ "source": src, "events": [ok] }).to_string(),
        ),
        ("sin events", json!({ "nod": 1, "source": src }).to_string()),
        ("run en mayúsculas", env(&bad_run, json!([ok]))),
        ("instance con mayúsculas", env(&bad_instance, json!([ok]))),
        ("privacidad inexistente", env(&bad_privacy, json!([ok]))),
        ("sin profile", env(&no_profile, json!([ok]))),
        (
            "seq 0",
            env(
                &src,
                json!([{ "seq": 0, "ts": 1, "type": "command", "session": "s", "data": { "name": "x" } }]),
            ),
        ),
        (
            "sin session",
            env(
                &src,
                json!([{ "seq": 1, "ts": 1, "type": "command", "data": { "name": "x" } }]),
            ),
        ),
        (
            "command sin name",
            env(
                &src,
                json!([{ "seq": 1, "ts": 1, "type": "command", "session": "s", "data": {} }]),
            ),
        ),
        (
            "turn.step sin turn",
            env(
                &src,
                json!([{ "seq": 1, "ts": 1, "type": "turn.step", "session": "s",
            "data": { "index": 0, "tools": [], "usage": { "input": 1, "output": 1, "cache_read": 0, "cache_write": 0 } } }]),
            ),
        ),
        (
            "usage sin cache_write",
            env(
                &src,
                json!([{ "seq": 1, "ts": 1, "type": "turn.step", "session": "s", "turn": "t",
            "data": { "index": 0, "tools": [], "usage": { "input": 1, "output": 1, "cache_read": 0 } } }]),
            ),
        ),
        (
            "by inexistente",
            env(
                &src,
                json!([{ "seq": 1, "ts": 1, "type": "permission.decision", "session": "s",
            "data": { "tool_use_id": "u", "tool": "Bash", "decision": "allow", "by": "bot", "wait_ms": 0, "exact": true } }]),
            ),
        ),
        (
            "usage vacío",
            env(
                &src,
                json!([{ "seq": 1, "ts": 1, "type": "usage", "session": "s", "data": {} }]),
            ),
        ),
        // Un evento válido junto a uno inválido: el lote entero es inválido y el válido tampoco entra.
        (
            "lote mixto",
            env(
                &src,
                json!([ok, { "seq": 2, "ts": 1, "type": "session.end", "session": "s", "data": { "reason": "exit" } }]),
            ),
        ),
    ];
    for (name, body) in cases {
        let (st, r) = post(addr, body, None);
        assert_eq!(st, 400, "{name}: {r}");
        assert!(r["error"].is_string(), "{name}");
    }
    assert_eq!(count(&db), 0);
    assert_eq!(post(addr, env(&src, json!([ok])), None).0, 200);
    assert_eq!(count(&db), 1);
}

#[test]
fn token_401() {
    let (addr, db) = start("token", Some("s3creto"));
    let body = common::fixture_lines()[0].clone();
    assert_eq!(post(addr, body.clone(), None).0, 401);
    assert_eq!(post(addr, body.clone(), Some("s3cret")).0, 401);
    assert_eq!(post(addr, body.clone(), Some("s3creto-y-mas")).0, 401);
    assert_eq!(count(&db), 0);
    let (st, r) = post(addr, body, Some("s3creto"));
    assert_eq!((st, r), (200, json!({ "accepted": 1, "duplicates": 0 })));
    assert_eq!(count(&db), 1);
}

#[test]
fn cuerpo_grande_413() {
    let (addr, db) = start("grande", None);
    // Un sobre válido de más de 5 MB (un prompt enorme): el tamaño manda aunque el JSON esté bien.
    let big = envelope(
        json!([{ "seq": 1, "ts": 1, "type": "prompt.submit", "session": "s",
        "data": { "origin": "composer", "chars": MAX_BODY, "text": "a".repeat(MAX_BODY) } }]),
    );
    assert!(big.len() > MAX_BODY);
    assert_eq!(post(addr, big, None).0, 413);
    assert_eq!(count(&db), 0);
    // Justo por debajo del tope, entra.
    let pad = MAX_BODY
        - envelope(
            json!([{ "seq": 1, "ts": 1, "type": "prompt.submit", "session": "s",
        "data": { "origin": "composer", "chars": 1, "text": "" } }]),
        )
        .len();
    let fits = envelope(
        json!([{ "seq": 1, "ts": 1, "type": "prompt.submit", "session": "s",
        "data": { "origin": "composer", "chars": 1, "text": "a".repeat(pad) } }]),
    );
    assert_eq!(fits.len(), MAX_BODY);
    assert_eq!(post(addr, fits, None).0, 200);
    assert_eq!(count(&db), 1);
}

#[test]
fn comparacion_de_token() {
    use nod_collector::server::same_token;
    assert!(same_token(b"abc", b"abc"));
    assert!(!same_token(b"abc", b"abd"));
    assert!(!same_token(b"abc", b"ab"));
    assert!(!same_token(b"", b"a"));
    assert!(same_token(b"", b""));
}
