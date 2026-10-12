# Nod Control v1: aprobar y hablar con la sesión desde fuera

Nod v1 ([nod-v1.md](nod-v1.md)) es de solo lectura. **Nod Control v1** es la parte opcional que deja a un
**aprobador** externo (un reloj, un móvil, otra herramienta) decidir los permisos que el agente pregunta y
mandar mensajes a la sesión. Sin configurarla, Nod no retiene nada ni cambia ninguna decisión.

## 1. Papeles y confianza

| Papel | Qué es | Confianza |
| --- | --- | --- |
| **Nod** | el mod, dentro del agente | decide qué acepta: verifica todo |
| **Controlador** | servidor HTTP que hace de buzón entre Nod y los aprobadores (p. ej. el servidor de Orbit) | **ninguna**: puede leer y reordenar, no puede aprobar |
| **Aprobador** | dispositivo con una llave P-256 propia (p. ej. el reloj) | solo sus firmas cuentan, y solo si su llave está emparejada |

Nod nunca acepta una decisión o un mensaje sin una firma válida de una llave emparejada sobre datos que el
propio Nod generó. Ante cualquier fallo (controlador caído, lento, respuesta rara) Nod sigue como si el canal
no existiera: el agente pregunta en su terminal como siempre.

## 2. Configuración

```json
{ "control": { "url": "http://127.0.0.1:7878", "token_file": "~/.config/nod/control.token", "hold_ms": 20000 } }
```

`url` (sin barra final), `token` o `token_file` (el token no debe ir en un fichero versionado), `hold_ms`
(cuánto se retiene un permiso: 1000…90000, por defecto 20000). Variables: `NOD_CONTROL`,
`NOD_CONTROL_TOKEN`. Admite secciones por perfil como el resto de la configuración.

- Con privacidad `trabajo` y un controlador que no es local, el canal se desactiva.
- Con privacidad `redactado` o `trabajo`, el resumen de un permiso (§3.1) es solo el verbo del comando.
- `/nod lejos` sube la retención a 90 s en toda la máquina (`$XDG_STATE_HOME/nod/away.json`); `/nod cerca` la
  devuelve a `hold_ms`.

Las llaves emparejadas son de la máquina, no del perfil: `$XDG_STATE_HOME/nod/approvers.json`
(`~/.local/state/nod/approvers.json`), `{"v":1,"keys":[{"kid","spki","added_ms","name"?}]}`. `/nod aprobadores`
las lista; `/nod aprobadores quitar <kid>` revoca una (cuenta desde la siguiente decisión).

## 3. Criptografía

- Curva P-256, ECDSA con SHA-256, firma compacta de 64 bytes (r‖s) con s bajo. Llave pública: SPKI DER de
  91 bytes (punto sin comprimir). `kid` = primeros 8 bytes de SHA-256(SPKI).
- Las entradas firmadas son **CBOR determinista** (RFC 8949 §4.2.1) de un array que empieza por un dominio y
  una versión. Binarios (`bstr`) en CBOR; en JSON van en base64url sin relleno.
- Las llaves de prueba de `vectors/control/key.json` (su escalar es público) nunca cuentan como emparejadas.

### 3.1 Permiso

```
ah    = SHA-256( CBOR ["nod-approval", 1, instance, id, tool_use_id, tool, summary, wok, exp] )
firma sobre        CBOR ["nod-decision", 1, id, tool_use_id, decision, ts, ah]
```

`id`: 16 bytes aleatorios, de un solo uso. `instance`: `source.instance` de Nod. `summary`: texto que verá el
aprobador (≤ 1000 bytes UTF-8): el comando, la ruta o lo esencial de la entrada; con privacidad `redactado` o
`trabajo`, solo el verbo. `wok` (*watch ok*): `false` si la tool está en la lista prohibida (`rm -rf`,
`git push --force`, despliegues… y `NOD_FORBIDDEN_ADD`), y entonces un `allow` remoto no vale (un `deny`
sí). `exp`: segundos Unix en que vence la retención. `decision`: `"allow"` o `"deny"`. `ts`: segundos Unix
de la firma.

### 3.2 Mensaje

```
sid   = SHA-256( CBOR ["nod-session", 1, instance, session] )[0..16]
firma sobre        CBOR ["nod-message", 1, id, ts, instance, sid, kind, text]
```

`kind`: `"text"` (texto de hasta 1000 bytes), `"stop"` (corta el turno en curso) o `"recap"` (lo corta y, al
terminar, pide un resumen; `text` puede ir vacío). El `sid` ata el mensaje a una sesión sin revelar su id al
aprobador.

### 3.3 Emparejamiento

```
tag   = HMAC-SHA256( K, CBOR ["nod-pair", 1, instance, spki] )
```

`K`: 32 bytes aleatorios, de un solo uso, válidos 15 minutos, que solo ven Nod y el aprobador (van en el QR;
el controlador no los conoce).

## 4. API del controlador

Todas las peticiones de Nod llevan `Authorization: Bearer <token>` si hay token. Respuestas JSON. Nod pone un
plazo a cada llamada (3 s; el long-poll, `wait` + 3 s).

### 4.1 Permisos

| Llamada | Cuerpo / respuesta |
| --- | --- |
| `POST /v1/control/approvals` | `{"id", "instance", "session", "sid", "tool_use_id", "tool", "summary", "wok", "exp", "agent"?}` → 2xx. 409 si el `id` ya existe. Cualquier otra cosa: Nod no retiene |
| `GET /v1/control/approvals/<id>?wait=<ms>` | 200 `{"decision": {"decision", "ts", "kid", "sig"}}` · 204 aún nada · 404/410 ya no existe (Nod deja de esperar) |
| `POST /v1/control/approvals/<id>/resolved` | `{"by": "remote"\|"timeout"\|"abort"\|"error", "decision": "allow"\|"deny"\|"none", "reject"?}` → 2xx. Para que el aprobador deje de mostrarlo |

Nod comprueba cada decisión en este orden y, si falla, la descarta y sigue esperando: `malformed` (campos o
tamaños), `replay` (el permiso ya se resolvió), `kid` (llave no emparejada o de prueba), `sig` (firma sobre
la entrada que Nod reconstruye con **sus** datos), `expired` (`ts > exp + 30` o ya pasó `exp`), `forbidden`
(`allow` con `wok: false`). Gana lo primero que llegue entre: una decisión válida, el plazo `exp` o la
cancelación del agente. Con una decisión válida, el agente recibe `allow`/`deny` sin preguntar en el
terminal; en los demás casos, el veredicto original (el terminal pregunta como siempre).

En Nod v1 la decisión remota sale como `permission.decision` con `by: "remote"`.

No se retiene: si el agente está en un modo que decide solo (auto mode), si no hay llaves emparejadas, o si
el canal está desactivado.

### 4.2 Mensajes

`GET /v1/control/messages?session=<session>&wait=<ms>` → 200 `{"messages": [{"id", "ts", "sid", "kind",
"text", "kid", "sig"}]}` · 204. Nod lo pide en bucle mientras dure la sesión y haya llaves. Acepta un mensaje
si la llave está emparejada, la firma vale, `sid` es el de esta sesión, `|ahora − ts| ≤ 120 s` y el `id` no se
vio antes. `text` con el agente libre entra como prompt; con un turno en curso, se añade como contexto al
siguiente resultado de tool y, si el turno acaba antes, sale como prompt al terminar. `stop` y `recap` cortan
el turno en curso.

### 4.3 Emparejamiento

| Llamada | Cuerpo / respuesta |
| --- | --- |
| `GET /v1/control/info` | `{"name", "pair_url"}`. `pair_url` es una plantilla con `{instance}`, `{token}` y `{k}` (K en base64url) que Nod rellena y muestra como QR con `/nod emparejar` |
| `GET /v1/control/pair-offers?instance=<instance>` | `{"offers": [{"id", "spki", "tag", "name"?}]}` |
| `DELETE /v1/control/pair-offers/<id>` | la oferta ya se usó (o era inválida) |

El aprobador lee el QR, calcula `tag` con su SPKI y publica la oferta en el controlador. Nod la busca cada
2 s durante 2 minutos tras `/nod emparejar`, al empezar cada sesión y antes de cada retención; una oferta
cuyo `tag` verifica con un K vigente empareja la llave y consume el K. Un instalador puede dejar K's en
`$XDG_STATE_HOME/nod/pairing.json` (`{"v":1,"keys":[{"k","instance","expires_ms"}]}`) para un QR mostrado
fuera de Nod; Nod los usa igual y los borra al consumirlos.

## 5. Vectores

`vectors/control/` tiene llaves de prueba, entradas firmadas, `ah`, `sid`, `tag` y casos que deben fallar,
para comprobar cualquier implementación (Nod, un controlador o un aprobador) contra la misma referencia.
