//! Métricas de `report` sobre eventos construidos a mano, con el resultado calculado de antemano.

use nod_collector::envelope::parse_envelope;
use nod_collector::report::{build, Loop, Tokens, ToolPermissions};
use nod_collector::store::{Filter, Store};
use serde_json::{json, Value};

const T0: i64 = 1_791_800_000_000;
const MIN: i64 = 60_000;
const R1: &str = "2026-10-12T23:00:00.000Z";
const R2: &str = "2026-10-13T04:00:00.000Z";

fn usage(i: u64, o: u64, cr: u64, cw: u64) -> Value {
    json!({ "input": i, "output": o, "cache_read": cr, "cache_write": cw })
}

/// Sesión s1 (tarea T1): principal + subagente a1, permisos, un bucle de 3, un turno abortado y tres `usage`.
fn session_one() -> Value {
    let ev = |seq: i64, extra: Value| {
        let mut e = json!({ "seq": seq, "ts": T0 + seq * 1000, "session": "s1", "task": "T1" });
        e.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        e
    };
    let events = vec![
        ev(
            1,
            json!({ "type": "session.start", "data": { "interactive": true } }),
        ),
        ev(
            2,
            json!({ "type": "prompt.submit", "data": { "origin": "composer", "chars": 10,
            "edit": { "events": 3, "typing_ms": 900, "recalled": false, "revised": true } } }),
        ),
        ev(3, json!({ "type": "turn.start", "turn": "t1", "data": {} })),
        ev(
            4,
            json!({ "type": "turn.step", "turn": "t1", "data": { "index": 0, "tools": ["Bash"], "usage": usage(100, 50, 1000, 200) } }),
        ),
        ev(
            5,
            json!({ "type": "tool.call", "turn": "t1", "data": { "tool_use_id": "u1", "tool": "Bash" } }),
        ),
        ev(
            6,
            json!({ "type": "permission.request", "turn": "t1", "data": { "tool_use_id": "u1", "tool": "Bash", "check_ms": 300 } }),
        ),
        ev(
            7,
            json!({ "type": "permission.decision", "turn": "t1", "data": { "tool_use_id": "u1", "tool": "Bash",
            "decision": "allow", "by": "user", "wait_ms": 2000, "exact": true } }),
        ),
        ev(
            8,
            json!({ "type": "tool.result", "turn": "t1", "data": { "tool_use_id": "u1", "tool": "Bash",
            "duration_ms": 10, "ok": true, "rejected": false, "output_chars": 1 } }),
        ),
        ev(
            9,
            json!({ "type": "turn.step", "turn": "t1", "data": { "index": 1, "tools": ["Task"], "usage": usage(10, 20, 2000, 0) } }),
        ),
        ev(
            10,
            json!({ "type": "agent.spawn", "agent": "a1", "turn": "t1", "data": { "agent": "a1", "type": "Explore", "background": false } }),
        ),
        ev(
            11,
            json!({ "type": "turn.step", "agent": "a1", "turn": "ta", "data": { "index": 0, "tools": ["Edit"], "usage": usage(5, 5, 500, 100) } }),
        ),
        // El subagente pregunta y el humano lo niega: espera exacta, negado, y el resultado rechazado no es un fallo.
        ev(
            12,
            json!({ "type": "permission.request", "agent": "a1", "data": { "tool_use_id": "u2", "tool": "Edit" } }),
        ),
        ev(
            13,
            json!({ "type": "permission.decision", "agent": "a1", "data": { "tool_use_id": "u2", "tool": "Edit",
            "decision": "deny", "by": "user", "wait_ms": 1500, "exact": true } }),
        ),
        ev(
            14,
            json!({ "type": "tool.result", "agent": "a1", "data": { "tool_use_id": "u2", "tool": "Edit",
            "duration_ms": 0, "ok": false, "rejected": true, "output_chars": 0 } }),
        ),
        // La política decide (no es espera humana) tras retener el permiso otro mod 700 ms.
        ev(
            15,
            json!({ "type": "permission.decision", "turn": "t1", "data": { "tool_use_id": "u3", "tool": "Read",
            "decision": "allow", "by": "policy", "wait_ms": 0, "exact": true, "check_ms": 700 } }),
        ),
        // Preguntado y aprobado, pero sin el instante exacto: cota superior.
        ev(
            16,
            json!({ "type": "permission.request", "turn": "t1", "data": { "tool_use_id": "u4", "tool": "Write" } }),
        ),
        ev(
            17,
            json!({ "type": "permission.decision", "turn": "t1", "data": { "tool_use_id": "u4", "tool": "Write",
            "decision": "allow", "by": "user", "wait_ms": 5000, "exact": false } }),
        ),
        ev(
            18,
            json!({ "type": "tool.result", "turn": "t1", "data": { "tool_use_id": "u4", "tool": "Write",
            "duration_ms": 5, "ok": true, "rejected": false, "output_chars": 1 } }),
        ),
        // Bucle: Bash falla 3 veces seguidas y luego funciona.
        ev(
            19,
            json!({ "type": "tool.result", "turn": "t1", "data": { "tool_use_id": "u5", "tool": "Bash", "duration_ms": 1, "ok": false, "rejected": false, "output_chars": 9 } }),
        ),
        ev(
            20,
            json!({ "type": "tool.result", "turn": "t1", "data": { "tool_use_id": "u6", "tool": "Bash", "duration_ms": 1, "ok": false, "rejected": false, "output_chars": 9 } }),
        ),
        ev(
            21,
            json!({ "type": "tool.result", "turn": "t1", "data": { "tool_use_id": "u7", "tool": "Bash", "duration_ms": 1, "ok": false, "rejected": false, "output_chars": 9 } }),
        ),
        ev(
            22,
            json!({ "type": "tool.result", "turn": "t1", "data": { "tool_use_id": "u8", "tool": "Bash", "duration_ms": 1, "ok": true, "rejected": false, "output_chars": 9 } }),
        ),
        // Fin del turno del subagente: ni su duración ni su usage (agregado) cuentan.
        ev(
            23,
            json!({ "type": "turn.end", "agent": "a1", "turn": "ta", "data": { "outcome": "aborted", "usage": usage(5, 5, 500, 100),
            "steps": 1, "answer_chars": 0, "duration_ms": 4000 } }),
        ),
        ev(
            24,
            json!({ "type": "agent.end", "agent": "a1", "data": { "agent": "a1", "duration_ms": 4000, "usage": usage(5, 5, 500, 100) } }),
        ),
        ev(
            25,
            json!({ "type": "turn.end", "turn": "t1", "data": { "outcome": "answer", "usage": usage(9999, 9999, 9999, 9999),
            "steps": 2, "answer_chars": 50, "duration_ms": 10000 } }),
        ),
        json!({ "seq": 26, "ts": T0, "session": "s1", "task": "T1", "type": "usage", "data": {
            "context": { "tokens": 300, "window": 1000, "percent": 30 },
            "limits": [{ "kind": "five_hour", "percent_used": 10, "resets_at": R1 }, { "kind": "seven_day", "percent_used": 1, "resets_at": R2 }],
            "cost_usd": 0.5 } }),
        ev(
            27,
            json!({ "type": "prompt.submit", "data": { "origin": "composer", "chars": 5,
            "edit": { "events": 1, "typing_ms": 10, "recalled": true, "revised": false } } }),
        ),
        ev(
            28,
            json!({ "type": "turn.start", "turn": "t2", "data": {} }),
        ),
        ev(
            29,
            json!({ "type": "turn.step", "turn": "t2", "data": { "index": 0, "tools": [], "usage": usage(1, 1, 0, 0), "partial": true } }),
        ),
        ev(
            30,
            json!({ "type": "turn.end", "turn": "t2", "data": { "outcome": "aborted", "usage": usage(1, 1, 0, 0),
            "steps": 1, "answer_chars": 0, "duration_ms": 3000 } }),
        ),
        // 30 min después del primer usage, misma ventana: +3 pp → 6 pp/h.
        json!({ "seq": 31, "ts": T0 + 30 * MIN, "session": "s1", "task": "T1", "type": "usage", "data": {
            "context": { "tokens": 450, "window": 1000, "percent": 45 },
            "limits": [{ "kind": "five_hour", "percent_used": 13, "resets_at": R1 }], "cost_usd": 0.8 } }),
        ev(
            32,
            json!({ "type": "prompt.submit", "data": { "origin": "task-notification", "chars": 5 } }),
        ),
        // Ventana nueva: el par con el anterior no cuenta para el ritmo.
        json!({ "seq": 33, "ts": T0 + 90 * MIN, "session": "s1", "task": "T1", "type": "usage", "data": {
            "limits": [{ "kind": "five_hour", "percent_used": 2, "resets_at": R2 }], "cost_usd": 0.9 } }),
    ];
    json!({ "nod": 1, "source": { "instance": "personal-0001", "run": "0000000a", "host": "claude", "profile": "personal", "privacy": "completo" },
        "events": events })
}

/// Sesión s2 (tarea T2): una racha rota (Read, Read, Grep, Read) y un bucle de 4 Bash.
fn session_two() -> Value {
    let fail = |seq: i64, tool: &str| {
        json!({ "seq": seq, "ts": T0 + 100 * MIN + seq * 1000, "type": "tool.result", "session": "s2", "task": "T2", "turn": "x",
        "data": { "tool_use_id": format!("v{seq}"), "tool": tool, "duration_ms": 1, "ok": false, "rejected": false, "output_chars": 0 } })
    };
    let events = vec![
        fail(1, "Read"),
        fail(2, "Read"),
        fail(3, "Grep"),
        fail(4, "Read"),
        fail(5, "Bash"),
        fail(6, "Bash"),
        fail(7, "Bash"),
        fail(8, "Bash"),
        json!({ "seq": 9, "ts": T0 + 100 * MIN + 9000, "type": "turn.step", "session": "s2", "task": "T2", "turn": "x",
            "data": { "index": 0, "tools": [], "usage": usage(1, 2, 3, 4) } }),
        // turn.end sin duration_ms (es opcional): no suma nada.
        json!({ "seq": 10, "ts": T0 + 100 * MIN + 10000, "type": "turn.end", "session": "s2", "task": "T2", "turn": "x",
            "data": { "outcome": "answer", "usage": usage(1, 2, 3, 4), "steps": 1, "answer_chars": 0 } }),
        json!({ "seq": 11, "ts": T0 + 100 * MIN + 11000, "type": "usage", "session": "s2", "task": "T2",
            "data": { "context": { "percent": 80 }, "cost_usd": 0.25 } }),
    ];
    json!({ "nod": 1, "source": { "instance": "personal-0001", "run": "0000000b", "host": "claude", "profile": "personal", "privacy": "completo" },
        "events": events })
}

fn store() -> Store {
    let mut st = Store::open_memory().unwrap();
    for env in [session_one(), session_two()] {
        let evs = parse_envelope(&env).expect("sobre válido");
        st.insert(&evs, 0).unwrap();
    }
    st
}

fn approx(a: Option<f64>, b: f64) {
    let a = a.expect("valor");
    assert!((a - b).abs() < 1e-9, "{a} != {b}");
}

#[test]
fn metricas_de_la_tarea_t1() {
    let st = store();
    let evs = st
        .events(&Filter {
            task: Some("T1".into()),
            ..Default::default()
        })
        .unwrap();
    let r = build(&evs, false);
    assert_eq!(r.groups.len(), 1);
    let g = &r.groups[0];
    assert_eq!(g.task.as_deref(), Some("T1"));
    let m = &g.metrics;
    assert_eq!(m.sessions, 1);
    assert_eq!(m.events, 33);

    // Tiempos
    assert_eq!(m.time.agent_ms, 13_000); // 10 000 + 3 000; los 4 000 del subagente no
    assert_eq!(m.time.waiting_ms, 8_500); // 2 000 + 1 500 (subagente) + 5 000
    assert_eq!(m.time.waiting_count, 3);
    assert_eq!(m.time.waiting_upper_bounds, 1);
    assert_eq!(m.time.blocked_by_mods_ms, 1_000); // 300 (request) + 700 (policy)

    // Turnos y permisos
    assert_eq!(m.turns.composer_prompts, 2);
    assert_eq!(m.turns.main_steps, 3);
    approx(m.turns.autonomy, 1.5);
    assert_eq!(m.turns.aborted, 1); // el aborted del subagente no cuenta
    assert_eq!(m.turns.revised_prompts, 1);
    assert_eq!(m.turns.recalled_prompts, 1);
    assert_eq!(
        m.permissions,
        vec![
            ToolPermissions {
                tool: "Bash".into(),
                asked: 1,
                denied: 0
            },
            ToolPermissions {
                tool: "Edit".into(),
                asked: 1,
                denied: 1
            },
            ToolPermissions {
                tool: "Write".into(),
                asked: 1,
                denied: 0
            },
        ]
    );
    assert_eq!(
        m.loops,
        vec![Loop {
            session: "s1".into(),
            agent: None,
            tool: "Bash".into(),
            failures: 3,
            first_ts: T0 + 19_000
        }]
    );

    // Tokens y costo: solo turn.step (el usage 9999 de turn.end no se suma)
    assert_eq!(
        m.tokens,
        Tokens {
            input: 116,
            output: 76,
            cache_read: 3500,
            cache_write: 300
        }
    );
    assert_eq!(m.tokens_total, 3992);
    assert_eq!(
        m.subagent_tokens,
        Tokens {
            input: 5,
            output: 5,
            cache_read: 500,
            cache_write: 100
        }
    );
    approx(m.cache_efficiency, 3500.0 / 3916.0);
    approx(m.context_max_percent, 45.0);
    approx(m.cost_usd, 0.9); // el último de la sesión, no la suma de los tres
    approx(m.five_hour_pace, 6.0);
    assert_eq!(m.five_hour_pace_pairs, 1);
}

#[test]
fn bucles_grupos_y_total() {
    let st = store();
    let r = build(&st.events(&Filter::default()).unwrap(), false);
    let tasks: Vec<_> = r.groups.iter().map(|g| g.task.as_deref()).collect();
    assert_eq!(tasks, vec![Some("T1"), Some("T2")]);

    let t2 = &r.groups[1].metrics;
    // Read, Read, Grep, Read no es un bucle; Bash ×4 sí.
    assert_eq!(t2.loops.len(), 1);
    assert_eq!(
        (t2.loops[0].tool.as_str(), t2.loops[0].failures),
        ("Bash", 4)
    );
    assert_eq!(t2.time.agent_ms, 0);
    assert_eq!(t2.turns.autonomy, None); // sin prompts del humano
    assert_eq!(t2.tokens_total, 10);
    approx(t2.cache_efficiency, 3.0 / 8.0);
    assert_eq!(t2.five_hour_pace, None);

    let total = &r.total;
    assert_eq!(total.sessions, 2);
    assert_eq!(total.loops.len(), 2);
    assert_eq!(total.tokens_total, 4002);
    approx(total.cost_usd, 1.15); // 0.9 (s1) + 0.25 (s2)
    approx(total.context_max_percent, 80.0);
    assert_eq!(total.turns.main_steps, 4);
}

#[test]
fn por_sesion_y_desde() {
    let st = store();
    let evs = st
        .events(&Filter {
            session: Some("s2".into()),
            ..Default::default()
        })
        .unwrap();
    let r = build(&evs, true);
    assert_eq!(r.groups.len(), 1);
    assert_eq!(r.groups[0].session.as_deref(), Some("s2"));
    assert_eq!(r.groups[0].metrics.events, 11);

    // Desde T0 + 60 min solo quedan el último usage de s1 y s2 entera.
    let evs = st
        .events(&Filter {
            since: Some(T0 + 60 * MIN),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(evs.len(), 12);
    let r = build(&evs, false);
    approx(r.groups[0].metrics.cost_usd, 0.9);
    assert_eq!(r.groups[0].metrics.five_hour_pace, None);
}

#[test]
fn json_estable() {
    let st = store();
    let r = build(
        &st.events(&Filter {
            task: Some("T2".into()),
            ..Default::default()
        })
        .unwrap(),
        false,
    );
    let v = serde_json::to_value(&r).unwrap();
    let keys: Vec<_> = v["groups"][0]["metrics"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    let mut sorted = keys.clone();
    sorted.sort();
    // serde_json ordena las claves; lo que importa es que estén todas y con estos nombres.
    assert_eq!(
        sorted,
        [
            "cache_efficiency",
            "context_max_percent",
            "cost_usd",
            "events",
            "first_ts",
            "five_hour_pace",
            "five_hour_pace_pairs",
            "last_ts",
            "loops",
            "permissions",
            "sessions",
            "subagent_tokens",
            "time",
            "tokens",
            "tokens_total",
            "turns",
        ]
    );
    assert_eq!(v["groups"][0]["metrics"]["time"]["waiting_upper_bounds"], 0);
    assert_eq!(v["groups"][0]["task"], "T2");
}
