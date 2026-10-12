//! El servidor HTTP: `POST /v1/events`, `GET /v1/limits` y `GET /health`.
//!
//! Pila: tiny_http, síncrono. El collector es local y de un solo usuario: recibe lotes de Nod cada 250 ms como
//! mucho y cada escritura pasa por una única conexión SQLite (también síncrona) tras un mutex. Un runtime
//! asíncrono (axum + tokio) no aportaría concurrencia útil aquí y multiplicaría las dependencias y el tiempo de
//! compilación del paquete de Nix. Unos pocos hilos que comparten el `Server` bastan para que una petición lenta
//! no bloquee a las demás.

use crate::envelope::parse_envelope;
use crate::store::Store;
use crate::time::now_ms;
use serde_json::{json, Value};
use std::io::Read;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tiny_http::{Header, Method, Request, Response, Server};

/// Tope del cuerpo. Un lote de Nod tiene como mucho 500 eventos; 5 MB deja margen para prompts y respuestas
/// largas con privacidad `completo` sin dejar que un cliente llene la memoria.
pub const MAX_BODY: usize = 5 * 1024 * 1024;

const WORKERS: usize = 4;

pub struct Collector {
    server: Arc<Server>,
    store: Arc<Mutex<Store>>,
    token: Option<Vec<u8>>,
}

/// Compara sin salir antes en el primer byte distinto: el tiempo de respuesta no dice cuánto del token se
/// acertó. Solo depende de la longitud del más largo, que no revela el contenido del token.
pub fn same_token(a: &[u8], b: &[u8]) -> bool {
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= usize::from(x ^ y);
    }
    std::hint::black_box(diff) == 0
}

fn json_response(status: u16, body: &Value) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(body.to_string().into_bytes())
        .with_status_code(status)
        .with_header(
            Header::from_bytes("Content-Type", "application/json").expect("cabecera válida"),
        )
}

/// Los errores van también al log: un lote rechazado lo descarta Nod, y aquí queda el porqué.
fn error(status: u16, msg: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    if status != 404 {
        eprintln!("nod-collector: {status} {msg}");
    }
    json_response(status, &json!({ "error": msg }))
}

impl Collector {
    pub fn bind(listen: &str, store: Store, token: Option<String>) -> Result<Collector, String> {
        let server =
            Server::http(listen).map_err(|e| format!("no puedo escuchar en {listen}: {e}"))?;
        Ok(Collector {
            server: Arc::new(server),
            store: Arc::new(Mutex::new(store)),
            token: token.map(String::into_bytes),
        })
    }

    pub fn addr(&self) -> Option<SocketAddr> {
        self.server.server_addr().to_ip()
    }

    /// Atiende peticiones en `WORKERS` hilos. Si `block`, no vuelve nunca; si no, deja los hilos corriendo
    /// (para los tests).
    pub fn run(self, block: bool) {
        let this = Arc::new(self);
        let mut handles = Vec::new();
        for _ in 0..WORKERS {
            let c = Arc::clone(&this);
            handles.push(std::thread::spawn(move || {
                while let Ok(rq) = c.server.recv() {
                    c.handle(rq);
                }
            }));
        }
        if block {
            for h in handles {
                let _ = h.join();
            }
        }
    }

    fn handle(&self, mut rq: Request) {
        let path = rq.url().split('?').next().unwrap_or("").to_string();
        let resp = match (rq.method(), path.as_str()) {
            (Method::Post, "/v1/events") => self.post_events(&mut rq),
            (Method::Get, "/v1/limits") => self.get_limits(),
            (Method::Get, "/health") => json_response(200, &json!({ "ok": true })),
            (_, "/v1/events" | "/v1/limits" | "/health") => error(405, "método no permitido"),
            _ => error(404, "no existe"),
        };
        let _ = rq.respond(resp);
    }

    fn authorized(&self, rq: &Request) -> bool {
        let Some(want) = &self.token else { return true };
        let got = rq
            .headers()
            .iter()
            .find(|h| h.field.equiv("Authorization"))
            .map(|h| h.value.as_str().trim())
            .and_then(|v| {
                v.split_once(' ')
                    .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
                    .map(|(_, t)| t.trim())
            })
            .unwrap_or("");
        same_token(got.as_bytes(), want)
    }

    fn post_events(&self, rq: &mut Request) -> Response<std::io::Cursor<Vec<u8>>> {
        // El token va antes que el cuerpo: sin él no se lee ni se valida nada.
        if !self.authorized(rq) {
            return error(401, "token no válido");
        }
        if rq.body_length().is_some_and(|n| n > MAX_BODY) {
            return error(413, "el cuerpo pasa de 5 MB");
        }
        // Sin Content-Length (chunked) el tope se aplica leyendo: un byte de más basta para rechazarlo.
        let mut body = Vec::new();
        if let Err(e) = rq
            .as_reader()
            .take(MAX_BODY as u64 + 1)
            .read_to_end(&mut body)
        {
            return error(400, &format!("no pude leer el cuerpo: {e}"));
        }
        if body.len() > MAX_BODY {
            return error(413, "el cuerpo pasa de 5 MB");
        }
        let events = match serde_json::from_slice::<Value>(&body)
            .map_err(|e| format!("JSON inválido: {e}"))
            .and_then(|v| parse_envelope(&v))
        {
            Ok(evs) => evs,
            Err(e) => return error(400, &e),
        };
        let mut store = self.store.lock().unwrap_or_else(|p| p.into_inner());
        match store.insert(&events, now_ms()) {
            Ok((accepted, duplicates)) => json_response(
                200,
                &json!({ "accepted": accepted, "duplicates": duplicates }),
            ),
            // 500: Nod conserva el lote y reintenta; un fallo del disco no es culpa del lote.
            Err(e) => error(500, &e),
        }
    }

    fn get_limits(&self) -> Response<std::io::Cursor<Vec<u8>>> {
        let store = self.store.lock().unwrap_or_else(|p| p.into_inner());
        match store.latest_limits() {
            Ok(snaps) => json_response(200, &json!({ "instances": snaps })),
            Err(e) => error(500, &e),
        }
    }
}
