# Orbit: contrato del protocolo, versión 0.2.4

Estado: **0.2.4** (flota: varios servidores en el teléfono con el origen en la ruta del Data Layer, §5.7; tokens revocables, §3.2.1; sesiones duplicadas, §4.6; ver "Cambios 0.2.3 → 0.2.4"). **0.2.3** (atascos, "detente y resume" y respuestas rápidas configurables: §4.5, §6.6, §6.6.1; ver "Cambios 0.2.2 → 0.2.3"). **0.2.2** (formato de say 2: la firma de las respuestas del reloj cubre la sesión, §6.6; ver "Cambios 0.2.1 → 0.2.2"). **0.2.1**: emparejamiento por QR, §6.3.1 (ver "Cambios 0.2.0 → 0.2.1"). **0.2.0 tras G2** (formato de firma 2: cambia lo que viaja por la red, ver "Cambios 0.1 → 0.2"). La 0.1.0 se aprobó en G0 y tuvo una revisión tras G1 (aclaraciones de §3.1, §3.2, §5.4 y §11). Basado en los payloads reales de `fixtures/raw/` (Claude Code 2.1.296, spikes S1 y S2), no en la documentación. Los schemas en `schema/` son normativos; si este texto y un schema discrepan, gana el schema y el texto se corrige.

Palabras clave: DEBE, NO DEBE, PUEDE (en el sentido de RFC 2119).

## Cambios 0.2.3 → 0.2.4

Compatible (§9: misma MAJOR.MINOR; las tramas no cambian ni un byte y `hello` sigue anunciando `0.2.0`):

- **Flota** (§5.7): el teléfono habla con varios servidores a la vez, una conexión por servidor. Lo que pasa entre teléfono y reloj lleva el **origen** (el servidor) en la ruta del Data Layer: `/orbit/o/<origen>/frame`, `…/snap`, `…/perm/<nonce>`, `…/text` (teléfono → reloj) y `…/dec`, `…/req`, `…/text-req`, `…/say`, `…/open` (reloj → teléfono). La lista de servidores va en el dato `/orbit/origins`. Las rutas sin prefijo siguen valiendo y son el servidor principal: un reloj anterior a la flota sigue funcionando con el primer servidor, y un teléfono anterior con un reloj nuevo también. Cada origen conserva su propia numeración de `epoch`, `seq` e ids (§5.3 se aplica por origen).
- **Tokens revocables** (§3.2.1): varios tokens por instancia (`tokens` en la configuración del servidor, con id, alta y revocación); `orbit-server token list|add|revoke`. El servidor relee los tokens sin reiniciar y cierra con **4401** el WebSocket abierto con un token revocado. `client.json` gana `phone_token` y `phone_token_id` (opcionales): el QR de `orbit-server setup` lleva un token propio del teléfono.
- **Sesiones duplicadas** (§4.6): el mismo `session_id` por dos instancias del mismo `ctx` es un solo nodo; la conversación y el lugar no repiten lo que llegó por hooks y por el mod.
- **Texto bajo demanda** (§8): el texto, el lugar y la conversación de una sesión duplicada se dan a cualquiera de las instancias que la ven, no solo a la dueña.

## Cambios 0.2.2 → 0.2.3

Compatible (§9: misma MAJOR.MINOR; las piezas siguen enviando `orbit: "0.2.0"` y `hello` sigue anunciando `0.2.0`):

- **Op `stuck`** (§4.5, §5.2): `["stuck", session, why, since, k, n]`, la sesión está atascada (`idle`: sin eventos demasiado tiempo; `loop`: la misma herramienta con la misma entrada varias veces seguidas) o deja de estarlo (`none`). Es **informativa**: no cambia nodos ni estados, así que un cliente 0.2.2 la ignora como op desconocida (§5.3) sin perder la consistencia del grafo; solo no ve el atasco. §9 se aclara: añadir una op informativa es un cambio de patch. Un cliente que la entiende la trata como `meta` a efectos de huecos (id desconocido = hueco).
- **Kind `recap`** en `say` (§6.6, sobre el formato 2): "detente y resume". Corta el turno y, al quedar libre la sesión, pide a Claude que resuma dónde está y qué le bloquea. La entrada firmada no cambia de forma (el kind ya va firmado). Un mod 0.2.2 rechaza el kind desconocido (`malformed`): falla de forma segura, no hace nada.
- **Respuestas rápidas configurables** (§6.6.1): el mod manda `orbit_replies` (campo propio, solo `ctx=personal`) y `GET /v0/session` gana un 7.º elemento opcional con la lista. Solo aparece si el mod la mandó; un reloj 0.2.2 que lea una respuesta de 7 elementos la rechaza (su lector exige 6), así que reloj y servidor se actualizan juntos.
- Configuración del servidor: `stuck_idle_minutes` (10) y `stuck_loop_repeats` (5).

## Cambios 0.2.1 → 0.2.2

**Formato de say 2** (§6.6). Hallazgo: la firma de las respuestas del reloj (formato 1) no cubría la sesión, así que un servidor malicioso podía llevar un texto firmado a otra sesión de la misma instancia. Ahora:

- el servidor añade a `info` de `GET /v0/transcript` (§8) un 7.º elemento, `sid`: los 16 primeros bytes de SHA-256 del CBOR determinista de `["orbit-sid", 1, instance_id, session_id]`;
- el reloj lo firma: `say` lleva `sid` como 5.º elemento y la entrada firmada pasa a `["orbit-say", 2, nonce, ts, instance_id, sid, kind, text]`;
- el mod recalcula el `sid` desde **su** `session_id` y rechaza (`session`) uno que no coincida. El formato 1 (8 elementos, sin `sid`) **ya no se acepta** (`malformed`);
- `POST /v0/say` responde **409** si el `sid` no es el de la sesión del nodo, y 400 a un say de formato 1.

Alcance (§9): rompe solo el canal de respuestas, que va de extremo a extremo entre reloj y mod (el servidor lleva los bytes sin poder leerlos ni fabricarlos). Una mezcla de versiones falla de forma segura: un reloj 0.2.1 no ve el `sid` (su lector de `info` acepta 5 o 6 elementos y descarta la `info` de 7) y no ofrece responder; un reloj 0.2.2 ante un servidor 0.2.1 tampoco (sin `sid` no firma); un mod 0.2.1 rechaza el say de 9 elementos por forma, y un mod 0.2.2 rechaza el de 8. Ni el grafo, ni los permisos, ni el emparejamiento cambian, así que las piezas siguen enviando `orbit: "0.2.0"` y no hay 426.

Los permisos (`dec`, §6.3) no necesitan lo mismo: el `nonce` lo genera el mod de la sesión y solo lo acepta ese mod (paso 1 de §6.3), y `tool_use_id` (paso 2) también es de esa sesión, así que una `dec` llevada a otra sesión se rechaza por `nonce`.

## Cambios 0.2.0 → 0.2.1

Compatible (§9: misma MAJOR.MINOR; las piezas pueden seguir enviando `orbit: "0.2.0"`):

- `pairOffer` y `offer` aceptan un campo opcional `tag` (32 bytes, base64url): la etiqueta del **emparejamiento por QR** (§6.3.1). Un servidor 0.2.0 lo rechaza con 400 (campo desconocido); un mod 0.2.0 lo ignora y la oferta sigue el flujo manual por huella.
- El servidor sin `ORBIT_CONFIG` crea su configuración y `client.json` para el mod (`pairing.schema.json#/$defs/clientConfig`) y sirve `GET /setup` solo en loopback. No cambia nada de lo que viaja entre piezas.

## Cambios 0.1 → 0.2

0.2 rompe con 0.1 (§9): la ingesta, `permPending` y `pairOffer` con `orbit: "0.1.x"` reciben 426, y un cliente 0.1 del WebSocket recibe `hello` con `0.2.0` y deja de aplicar tramas ("actualiza Orbit", como con el cierre 4426).

- **Formato de firma 2** (§6.3). Hallazgo de G2: la firma de formato 1 no cubría lo que el usuario ve en el reloj, así que un servidor malicioso podía enseñar `ls` y usar la aprobación para otro permiso pendiente. Ahora:
  - la trama `perm` lleva `instance_id` (9.º elemento) y el reloj lo muestra junto a `tool` y `sum`;
  - el reloj firma `ph`, el SHA-256 de los campos que muestra (`instance_id`, `nonce`, `tool_use_id`, `tool`, `sum`, `wok`, `exp`), y la `dec` lleva `ph` como 8.º elemento;
  - el mod recalcula `ph` desde **su** pendiente y verifica la firma sobre ese `ph`; si el recibido difiere, rechaza con `ph`;
  - el servidor NO DEBE cambiar `tool`, `sum`, `wok`, `exp` ni `instance_id` entre `/v0/perm/pending` y la trama `perm` (si tendría que cambiarlos, responde 422);
  - la firma de formato 1 deja de aceptarse.
- **Motivos** (`http-api.schema.json`): `permResolved.reject` gana `malformed`, `tool_use_id` y `ph`; `permResolved.by` gana `error` (§6.1).
- **Deriva de reloj** (§6.3): el mod acepta `ts ≤ exp + 30 s`. La condición `ahora ≤ exp` en el Mac no cambia.
- **Varias `dec` por nonce** (§6.5): el servidor guarda hasta 8 distintas y las entrega por turnos (antes el texto decía que guardaba solo la primera).
- **Estado tras cerrar sin decisión** (§6.1, §6.5): con `by` = `timeout`, `abort` o `error` y `decision = none` la tarea vuelve a `run`.
- **Emparejamiento** (§6.3, `docs/pairing.md`): `POST /v0/pair/offer` sigue sin autenticación; se documentan el riesgo y sus límites, y `/orbit pair` muestra la hora de cada oferta y avisa si hay más de una.
- **Transporte** (§1, §3.2): el token de instancia DEBE viajar por Tailscale o HTTPS; el servidor avisa al arrancar si escucha fuera de loopback.

---

## 1. Topología

```
Claude Code ──(mod: POST/long-poll JSON)────────┐
            └─(hooks type:"http": POST JSON)────┤
                                                ▼
                                     servidor (homelab, Rust)
                                                │  WebSocket, tramas CBOR (§5, §6)
                                                ▼
                                      teléfono (Pixel) ── MessageClient/DataClient, mismas tramas ──▶ reloj
```

| Tramo | Formato | Schema |
| --- | --- | --- |
| Colector → servidor (ingesta) | JSON | `ingest.schema.json`, `hook-payload.schema.json` |
| Mod ↔ servidor (permisos) | JSON por HTTP; el mod es **siempre cliente** (no puede abrir servidor, S1) | `http-api.schema.json` |
| Servidor → teléfono → reloj, y vuelta | CBOR determinista (§7) | `frame.schema.json` (forma JSON de cada trama) |
| Texto bajo demanda | CBOR, petición HTTP aparte (§8) | `frame.schema.json#/$defs/text` |

**Transporte**: el token de instancia (`Authorization: Bearer`) DEBE viajar por Tailscale o por HTTPS, nunca en claro por una red compartida (la Wi-Fi de casa incluida). El servidor registra un aviso (`warn`) al arrancar si `bind` no es una dirección de loopback; la forma recomendada de exponerlo es `tailscale serve` o escuchar en la IP de Tailscale.

El teléfono reenvía las tramas **byte a byte**: no las decodifica para reenviarlas, aunque PUEDE decodificarlas para mantener su copia del grafo (§5.6).

## 2. Convenciones

- **Tiempo**: en la ingesta, milisegundos Unix (`rx`). En tramas CBOR, **segundos** Unix (uint). No hay floats en 0.2.0.
- **Ids de nodo**: uint, `1..2^32-1`, asignados por el servidor, únicos dentro de un `epoch` en todo el grafo vivo (todas las instancias y sesiones). `0` significa "ninguno" (padre de una sesión, MCP ausente). Crecen de 1 en 1 y no se reutilizan dentro del epoch, así que los ids habituales caben en 1–3 bytes.
- **epoch**: uint32 que el servidor persiste e incrementa en cada arranque, y también cuando el contador de ids o de `seq` se agotaría. Cambiar de epoch obliga a pedir un snap.
- **Etiquetas** (`k`, `tool`): ≤ 32 bytes UTF-8, cortadas en frontera de code point.
- **Bytes en JSON**: base64url sin relleno (API HTTP); `{"$hex": "..."}` en la forma JSON de las tramas (schemas y golden vectors).

## 3. Evento crudo (colector → servidor)

### 3.1 Sobre

```json
{ "orbit": "0.2.0", "instance_id": "mac-personal", "ctx": "personal", "src": "mod",
  "events": [ { "n": 17, "rx": 1791683886699, "ev": { /* hook-payload */ } } ] }
```

| Campo | Regla |
| --- | --- |
| `orbit` | Versión del protocolo del colector (§9). |
| `instance_id` | `^[a-z0-9][a-z0-9-]{0,31}$`. Una por instalación de Claude Code (p. ej. `mac-personal`, `mac-work`). |
| `ctx` | `personal` \| `work`. Lo fija la instancia, no cada evento. |
| `src` | `hook` \| `mod`. |
| `n` | Entero **estrictamente creciente y único** por (`instance_id`, `src`), persistente. **Puede tener huecos**: el mod arranca en `max(reserva guardada, ahora_ms × 1024)` para que varios procesos, perfiles o un almacén vaciado no repitan `n`. El servidor descarta los (`instance_id`, `src`, `n`) ya vistos (reenvío de la cola offline), ordena por `n` y **no** trata un hueco como pérdida. La respuesta informa `duplicates`; el colector DEBE contarlos. |
| `rx` | Milisegundos en que el colector vio el evento. |
| `ev` | Payload con la forma de hook de Claude Code (`hook-payload.schema.json`). Se aceptan campos desconocidos y se guardan. |

Lote: 1–500 eventos. El servidor guarda cada evento en el log crudo (SQLite) **después** de aplicar §3.4.

### 3.2 Transporte

- **Mod**: `POST /v0/ingest` con el sobre completo y `Authorization: Bearer <token de instancia>`. El servidor DEBE comprobar que `instance_id` y `ctx` coinciden con los del token. Como todo lo que lleva el token, DEBE ir por Tailscale o HTTPS (§1).
- **Hooks HTTP** (plan B, o para eventos que el mod no ve): Claude Code envía el payload sin sobre a `POST /v0/ingest/hook/<instance_id>`. El servidor construye el sobre (`src=hook`, `n` asignado por el servidor, `ctx` del token o de la configuración de la instancia). Configuración comprobada (S2 y V1, claude 2.1.296): `"matcher": ""` en cada entrada; `"timeout"` es opcional y va en **segundos** (entero positivo): con `0` o un string el hook se descarta en silencio. Autenticación: `"headers": {"Authorization": "Bearer $ORBIT_TOKEN"}` con `"allowedEnvVars": ["ORBIT_TOKEN"]`; sin `allowedEnvVars` la variable se sustituye por vacío. El servidor exige por defecto el token de esa instancia (401 sin token, 403 si es de otra).
- Campos que siempre trae un hook (S2): `session_id`, `cwd`, `hook_event_name`, `transcript_path`; `prompt_id` en casi todos.

### 3.2.1 Tokens revocables (0.2.4)

- Cada instancia tiene su token `inicial` (`token_sha256`) y, opcionalmente, más en `tokens`: `{id, sha256, label?, created_ms, revoked_ms?}` (`id` = `[a-z0-9][a-z0-9-]{0,31}`, único en el fichero). Solo se guarda el SHA-256; el token en claro se enseña una vez al crearlo. Una instancia puede quedarse con todos sus tokens revocados (no autentica nada).
- Todo lo que pide token (ingesta, hooks, permisos, texto, lugar, respuestas, emparejamiento, OTel, WebSocket con `perm`) acepta cualquier token **vigente** de la instancia, en tiempo constante. Un token revocado recibe 401 como uno desconocido.
- `orbit-server token list|add <instancia> [--label X]|revoke <id> [--instance X]` edita el fichero de configuración (el de `ORBIT_CONFIG` o el `config.json` automático) con escritura atómica y 0600. El servidor en marcha mira la fecha y el tamaño del fichero como mucho cada segundo y relee los tokens: alta y revocación sin reiniciar. Las instancias nuevas o los cambios de `ctx` siguen pidiendo reinicio.
- Un WebSocket abierto con un token que deja de valer se cierra con el código **4401** en la siguiente comprobación (cada 2 s). El cliente lo muestra como "token revocado"; reconectar sin token válido solo da el grafo, no los `perm` (§5).
- `orbit-server setup` y `GET /setup` ponen en el QR un token propio del teléfono (`phone_token` de `client.json`, etiqueta "teléfono"), no el del mod: revocarlo no corta las sesiones. Si se revoca, el siguiente QR crea otro.

### 3.3 Traducción mod → forma canónica

El mod no recibe los payloads de hook (`classic.*` está desviado por `cc-plugin-sec-default` en la org `team`, S1). Traduce los eventos del motor así:

| Evento del motor (S1) | `hook_event_name` | Campos canónicos |
| --- | --- | --- |
| `session.start` | `SessionStart` | `session_id` (= `await $.session.id()`), `cwd`, `source:"mod"` |
| `turn.start` | `UserPromptSubmit` | `prompt` (= `text`), `turn_id` (= `turnId`) |
| `tool.call` (tool ≠ `Agent`) | `PreToolUse` | `tool_name` (= `tool`), `tool_use_id`, `tool_input` (= args aplanados sin `tool`, `tool_use_id`, `agentId`), `agent_id` (= `agentId`), `agent_type` (de `$.agent.list()`) |
| `tool.call` (tool = `Agent`) | `PreToolUse` | igual; crea el nodo agente pendiente (§4.2) |
| `tool.check` con veredicto `ask` | `PermissionRequest` | `tool_name`, `tool_input` (= `input`), `tool_use_id`, `agent_id`, `permission_reason` (= `verdict.reason`) |
| `tool.check` con `allow`/`deny` | — (no se emite) | — |
| resultado de `tool.call` (`next(e)`) | `PostToolUse` | `tool_name`, `tool_use_id`, `agent_id`, `is_error` (= `isError ?? false`). El texto NO se copia a `tool_response` (va al log de texto local, §8). |
| `agent.spawn` + primer `agentId` conocido | `SubagentStart` | `agent_id`, `agent_type` (= `subagentType`), `parent_tool_use_id` (= `tool_use_id` de `agent.spawn`), `background` |
| `turn.complete` con `agentId` | `SubagentStop` | `agent_id`, `is_aborted` |
| `turn.complete` sin `agentId` | `Stop` | `turn_id`, `is_aborted`, `last_assistant_message` (= `answer`) |
| `session.end` | `SessionEnd` | `reason` |
| `prompt.submit`, `turn.step`, `session.append`, `prompt.attachment`, `ui.*`, `$`-calls de `on('*')` | — (no se emiten) | — |

`agent.spawn` no trae `agentId`. El mod lo obtiene de lo primero que llegue: el `agentId` de un `tool.call` posterior, la línea `agentId: <id>` del resultado del tool `Agent`, o `$.agent.list()`. Hasta entonces NO emite `SubagentStart`.

`turn.complete.usage` (`input_tokens`, `output_tokens`, `cache_*`) alimenta `meta` (§5.4); se envía como campo extra `usage` en `Stop`/`SubagentStop` cuando `ctx=personal`.

### 3.4 `ctx=work`: lista blanca

Con `ctx=work` el evento solo puede contener estos campos (`ingest.schema.json#/$defs/workAllowlist`):

`session_id, hook_event_name, prompt_id, turn_id, permission_mode, effort, agent_id, agent_type, tool_name, tool_use_id, parent_tool_use_id, background, duration_ms, is_error, is_aborted, stop_hook_active, reason (≤ 32, solo SessionEnd), source`

Todo lo demás se elimina, también los campos que añada una versión futura de Claude Code: `prompt`, `tool_input`, `tool_response`, `last_assistant_message`, `cwd`, `transcript_path`, `agent_transcript_path`, `permission_suggestions`, `permission_reason`, `usage`, etc.

- Con `src=mod`, el mod elimina estos campos **antes** de enviar: no salen de la máquina.
- Con `src=hook`, Claude Code los envía al servidor (por Tailscale) y el servidor los elimina **antes de persistir**. No salen del servidor ni se guardan.
- En `ctx=work`, la etiqueta `k` de una sesión es el `instance_id` y no el nombre del proyecto, y `sum` de un permiso es solo el verbo (§6.2).

## 4. Grafo vivo

### 4.1 Nodo

| Campo | Tipo | Significado |
| --- | --- | --- |
| `id` | uint ≥ 1 | Id corto (§2). |
| `t` | `session` \| `agent` \| `task` \| `mcp` | Tipo. |
| `p` | uint | Padre (`0` solo en `session`). |
| `s` | `run` \| `perm` \| `done` \| `err` | Estado. |
| `k` | etiqueta | `session`: basename de `cwd` (o `instance_id` en work). `agent`: `agent_type`. `task`: nombre del tool; en MCP, la parte `<tool>`. `mcp`: nombre del servidor. |
| `m` | uint | Solo en `task`: id del nodo `mcp` que la ejecuta; `0` = no es MCP. |
| `ts` | uint s | Último cambio de estado. |

Claves internas del servidor (no viajan): sesión ↔ `(instance_id, session_id)`; agente ↔ `agent_id` y, antes de conocerlo, `tool_use_id` del tool `Agent`; tarea ↔ `tool_use_id`; mcp ↔ `(session, srv)`.

### 4.2 Derivación

| Evento canónico | Efecto |
| --- | --- |
| cualquiera con `session_id` desconocido | `add session`, `p=0`. `SessionStart` no llega en `-p` (S2), así que no se depende de él. |
| `UserPromptSubmit` | sesión → `run` (cancela su `rm` pendiente). |
| `PreToolUse`, `tool_name = Agent` | `add agent`, `k = tool_input.subagent_type`, padre = emisor (ver abajo). Queda **sin vincular** (sin `agent_id`). |
| `PreToolUse`, `tool_name = mcp__<srv>__<tool>` | si no existe, `add mcp (session, srv)` con `p = session`; después `add task`, `k = <tool>`, `m = id del mcp`. |
| `PreToolUse`, otro tool | `add task`, `k = tool_name`, padre = emisor. |
| `PermissionRequest` | tarea → `perm` (emparejamiento en §4.3) y mensaje `perm` (§6). |
| `PostToolUse` sin error | tarea → `done`. Si es el tool `Agent`: vincula `tool_response.agentId` (hook) o el texto `agentId:` (mod) y no cambia el estado del agente. |
| `PostToolUse` con `is_error:true`, `PostToolUseFailure`, o permiso denegado | tarea → `err`. |
| `SubagentStart` | vincula `agent_id` a un nodo agente sin vincular (§4.3); si no hay ninguno, `add agent` con `p = session`. |
| `SubagentStop` | agente → `done` (`err` si `is_aborted`). Las tareas abiertas del agente → `err`. |
| `Stop` | sesión → `done` (inactiva, NO se borra). Las tareas abiertas del hilo principal (sin `agent_id`) → `err`. |
| `SessionEnd` | sesión y todos sus descendientes abiertos → `done`; `rm` de la sesión a los 10 s. |
| `TaskCreated`/`TaskCompleted`/`Notification` | sin efecto en 0.2.0 (sin payload real, §11). |

**Emisor**: el agente con ese `agent_id` si el evento lo trae (los tools de un subagente llegan con `agent_id`, tanto en hook como en mod); si no, la sesión.

**MCP**: `tool_name` se parte por `__`: el segmento 0 es `mcp`, el 1 es `srv` y el resto unido con `__` es `<tool>`. Ejemplo: `mcp__plugin_engram_engram__mem_context` → srv `plugin_engram_engram`, tool `mem_context`. El nodo `mcp` pasa a `done` con su sesión.

### 4.3 Emparejamientos

- **Permiso → tarea**. Con mod: `tool_use_id` directo. Con hook: `PermissionRequest` **no trae `tool_use_id`** (fixture `PermissionRequest-1`). Se empareja con la tarea en `run` más reciente de la misma sesión, con el mismo `agent_id` (o ninguno), el mismo `tool_name` y un `tool_input` igual en profundidad. Si no aparece ninguna, no hay cambio de estado (el mensaje `perm` sale igual, con `id=0`).
- **SubagentStart → nodo agente**. Con mod: `parent_tool_use_id`. Con hook: no trae enlace al tool `Agent`, así que se elige el agente sin vincular más antiguo de la sesión con el mismo `agent_type` (FIFO). Lo corrige después `PostToolUse(Agent).tool_response.agentId`: si no coincide, el servidor reasigna las claves internas sin emitir ops (el `p` ya emitido no cambia).

### 4.4 Fin de vida

- Un `task` o `agent` en `done`/`err` recibe `rm` **10 s** después de entrar en ese estado.
- Una `session` solo recibe `rm` 10 s después de `SessionEnd`, o tras **6 h** sin eventos.
- Un `mcp` recibe `rm` con su sesión.
- `rm` es **en cascada**: el cliente borra el nodo y todos sus descendientes. El servidor no emite `rm` de los hijos.

### 4.5 Atascos (0.2.3)

El servidor marca una **sesión** atascada con la op `stuck` (§5.2). Dos motivos:

- `idle`: la sesión está en `run` y no llega ningún evento suyo (incluidos los de sus subagentes) durante `stuck_idle_minutes` (configuración del servidor, 10 por defecto, `0` lo apaga). `since` = el último evento; `k` = la etiqueta de la última tarea abierta de la sesión (`""` si no hay).
- `loop`: un hilo (el principal, o un subagente por su `agent_id`) llama a la misma herramienta con el mismo `tool_input` (JSON igual) `stuck_loop_repeats` veces seguidas (5 por defecto, `0` lo apaga, si no al menos 2). `since` = la primera de la racha; `k` = la herramienta; `n` = las repeticiones. Cada repetición más reenvía la op con el `n` nuevo. La racha se rompe con otra llamada en ese hilo, un `UserPromptSubmit`, el `Stop` de la sesión o el `SubagentStop` del subagente.

**No es un atasco** (sin falsos positivos con esperas del usuario):
- una sesión en `done` (terminó su turno: espera un prompt) o cerrándose (`SessionEnd`);
- una sesión con un nodo en `perm`, o con una tarea abierta de `AskUserQuestion` o `ExitPlanMode`;
- una sesión cuyo último evento es un `PermissionRequest` (también de hook, sin tarea emparejada) o cuyo permiso se cerró sin decisión (`by` = `timeout`/`abort`/`error`: decide el diálogo del terminal, §6.5), hasta el siguiente evento de la sesión;
- para `loop`: llamadas sin `tool_input` (ctx=work, la lista blanca lo quita: no se puede saber si se repite) y las que consultan algo en segundo plano (`BashOutput`, `TaskOutput`). Un bucle sí se marca aunque después pida permiso.

El servidor solo emite cuando cambia lo que tiene el cliente: un `stuck` al entrar, otro si cambia el motivo o la racha, y `["stuck", id, "none", 0, "", 0]` al salir. Como `meta`, **no viaja en el snap**: tras responder a un `req` el servidor repite los atascos vigentes en el siguiente delta. Un snap construido por el teléfono (§5.6) tampoco los lleva: el cliente conserva los de las sesiones que siguen vivas. El `rm` de una sesión borra su atasco (cascada).

### 4.6 Sesiones duplicadas (0.2.4)

La misma sesión de Claude Code puede llegar dos veces: hooks HTTP configurados con una instancia y el mod con otra, un segundo colector, o hooks y mod con la misma instancia. El `session_id` es un UUID de Claude Code, así que:

- **Misma instancia por dos vías** (`src=hook` y `src=mod`): ya era un solo nodo (la clave es `(instance_id, session_id)`), y las tareas no se repiten (`PreToolUse` con un `tool_use_id` ya visto se ignora). Lo nuevo: el texto bajo demanda, la conversación y el lugar (§8) solo usan los eventos del mod si la sesión tiene alguno; si no, los de los hooks. Así no salen dos veces el prompt, la respuesta y cada tool.
- **Otra instancia del mismo `ctx`**: si ya hay una sesión viva con ese `session_id` en otra instancia, el evento va a esa sesión y su clave queda como **alias** (no se crea otro nodo). Nunca se mezclan `personal` y `work`. La **dueña** es la primera que llegó, salvo que solo haya visto hooks y llegue el mod por un alias: entonces la dueña pasa a ser la instancia del mod (las respuestas del reloj, §6.6, van a su cola y el reloj firma su instancia y su `sid`). El nodo y su id no cambian.
- El texto, la conversación y el lugar se dan al token de **cualquiera** de las instancias que ven la sesión; `info` de la conversación lleva la dueña.
- Un `SessionEnd` por cualquiera de las dos vías cierra la sesión; la lápida (§10) cubre también los alias, así que lo viejo de cualquiera de los dos colectores no la resucita.
- **Sesión retomada** (`claude --resume` con el mismo `session_id`): reutiliza el nodo si sigue vivo y levanta la lápida si ya se cerró (`n` posterior, §10). Una sesión retomada con un `session_id` nuevo (`--fork-session`) es otra sesión: Claude Code no da ningún dato fiable que las una.

## 5. Deltas (servidor → teléfono → reloj)

### 5.1 Tramas

| Trama | Forma | Dirección |
| --- | --- | --- |
| hello | `["hello", "0.2.0", epoch, seq]` | servidor → teléfono, al conectar |
| delta | `["d", epoch, seq, ts, [op, …]]` | servidor → teléfono → reloj |
| req | `["req", "snap", epoch, last_seq]` | reloj → teléfono → servidor |

### 5.2 Ops

| Op | Forma | Ejemplo |
| --- | --- | --- |
| snap | `["snap", [[id, t, p, s, k, m, ts], …]]` | `["snap", [[7,"session",0,"run","Orbit",0,1791683936]]]` |
| add | `["add", id, t, p, k]` o `["add", id, t, p, k, m]`; estado inicial `run` | `["add",41,"task",7,"Bash"]` |
| st | `["st", id, s]` | `["st",41,"perm"]` |
| rm | `["rm", id]` (cascada) | `["rm",30]` |
| meta | `["meta", session_id_corto, in_tok, out_tok, turns]` (totales acumulados) | `["meta",7,43292,286,2]` |
| stuck (0.2.3) | `["stuck", session_id_corto, why, since, k, n]`; `why` = `idle` \| `loop` \| `none` (§4.5) | `["stuck",7,"loop",1791683940,"Bash",6]` |

Tamaños medidos con `cbor2@1.12.0` (`cde:true`): add 18 B, add con m 19 B, st 11 B, rm 6 B, meta 14 B. Una trama con 1 add ocupa 30 B; con 5 ops, 80 B (16 B por op). La cabecera de la trama son unos 12 B.

### 5.3 Secuencia y huecos

- `seq` (uint) crece de 1 en 1 por trama delta, **por servidor y epoch**. No hay `seq` por cliente: todas las suscripciones ven el mismo flujo.
- Una trama con `snap` lleva el `seq` desde el que continúan los deltas. `snap`, si aparece, es la **única** op de su trama.
- El cliente aplica una trama si `epoch == epoch_actual` y `seq == last_seq + 1`. Si no, la descarta, deja de aplicar y envía `["req","snap",epoch_actual,last_seq]`. Mientras espera el snap descarta todo lo que no sea snap.
- Una op sobre un id desconocido (st/rm/meta/stuck), o un `add` con id ya existente, se trata como hueco.
- Un `op` con nombre desconocido se ignora (compatibilidad dentro de la misma versión menor, §9).

### 5.4 Ventana, colapso y ritmo

- Ventana del servidor **W = 1000 ms** (configurable de 250 a 5000 ms). Todo lo que ocurre dentro de una ventana sale en una sola trama, o en ninguna si no hay cambios. Por separado, el mod agrupa la ingesta en lotes de 250 ms (M2).
- **Colapso**, dentro de una ventana y por nodo:
  - `add` seguido de `done` en la misma ventana: **no se envía nada** (tampoco su `rm`).
  - Varios `st` del mismo nodo: solo el último.
  - `add` y después `perm` o `err` en la misma ventana: se envían `add`, el `st` `perm`/`err` y, si cambió después, el `st` final. Los permisos y los errores **nunca** se colapsan, tampoco de forma indirecta.
  - Un nodo colapsado nunca aparece en un snap posterior.
  - Si se colapsa el padre (`add`+`done`), los hijos también se colapsan, **salvo** que el subárbol contenga un nodo abierto, en `perm` o en `err`: entonces no se colapsa ni ese nodo ni ninguno de sus ancestros. Colapsar una sesión no borra sus totales de `meta`; si el `session_id` reaparece, se retoman.
- `rm` a los 10 s (§4.4).
- `meta`: como máximo **una cada 30 s por sesión**, y solo si los valores cambiaron. Se calcula con `usage` del mod o con métricas OTel cuando `src=hook` (los hooks no traen tokens).
- Los `perm`/`pclose` (§6) salen **en cuanto ocurren**, fuera de la ventana.

### 5.5 Snap

El servidor responde a `req` con un snap del grafo vivo completo. El grafo vacío es `["snap", []]`. El orden de los nodos es por `id` ascendente, de modo que el padre aparece antes que el hijo. Un snap de más de 400 nodos es un caso límite (§10).

### 5.6 Teléfono como relevo

El teléfono mantiene su propia copia aplicando las tramas. Ante un `req` del reloj PUEDE responder con un snap construido desde esa copia si la tiene consistente (sin huecos pendientes). Si no, reenvía el `req` al servidor. Por `DataClient` guarda el último snap y por `MessageClient` envía los deltas.

### 5.7 Flota: varios servidores en el teléfono (0.2.4)

El teléfono puede tener varios servidores (el Mac de casa, el homelab…), cada uno con su URL, su token y sus instancias, y abre **una conexión por servidor**. Cada servidor numera su `epoch`, su `seq` y sus ids por su cuenta: las tramas no cambian y el reloj tiene que saber de qué servidor es cada una. El origen va en la **ruta** del Data Layer, no en la trama (que sigue viajando byte a byte, §1):

```
/orbit/o/<origen>/<ruta>     p. ej. /orbit/o/s2/frame, /orbit/o/s2/snap, /orbit/o/s2/perm/<nonce hex>
/orbit/<ruta>                sin prefijo: el servidor principal (el primero del teléfono)
```

- `<origen>` = `[a-z0-9]{1,16}`. Lo asigna el teléfono al añadir el servidor (`s1`, `s2`…, el menor libre) y no cambia mientras el servidor siga configurado.
- Con origen: `frame`, `snap`, `perm/<nonce>` y `text` (teléfono → reloj); `dec`, `req`, `text-req`, `say` y `open` (reloj → teléfono). La respuesta a un `text-req` vuelve con el mismo origen.
- Sin origen (globales): `origins`, `wake`, `pair-request`, `pair-offer` (el teléfono la publica en cada instancia de cada servidor) y `open-url`.
- `/orbit/origins` (DataItem, clave `frame`): CBOR `["origins", 1, [[origen, nombre, [instance_id, …]], …]]` (como mucho 16). El reloj nombra así cada servidor y olvida el grafo y los permisos de los orígenes que ya no están.
- Lo que el reloj manda sin origen (reloj anterior a la flota) va al servidor principal; una `dec` sin origen va al servidor que tenga abierto su nonce. Un push FCM `perm` va al servidor que tiene esa instancia y un `pclose`, al que tiene el nonce.
- El reloj aplica §5.3 **por origen** (un hueco en un servidor solo pide snap a ese servidor). Para la UI combina todos los grafos en uno con ids `ranura << 32 | id` (la ranura, por origen, empieza en 0) y traduce cada consulta de texto, respuesta y apertura al servidor dueño con su epoch y su id antes de mandarla.
- Texto bajo demanda, lugar, archivos y respuestas van al servidor dueño del nodo, con el token de la instancia dueña: el teléfono guarda el token de cada instancia que llegó por QR y prueba en orden ante un 401/403. Cada máquina sirve sus propios archivos (§8.3) si corre su propio servidor.
- Un QR `orbit://setup` **añade** el servidor (o lo actualiza si es la misma URL, o la misma instancia con otra URL: la IP cambió). Ya no reemplaza al anterior.

## 6. Permisos

### 6.1 Flujo (mecanismo verificado en S1)

1. El mod, en `on('tool.check')`, hace `v = await next(e)`. Si `v.decision !== 'ask'`, devuelve `v`.
2. El mod calcula `wok` (§6.4), `sum` (§6.2, ya truncado a 200 B) y `tool` (≤ 32 B), genera `nonce` (16 bytes aleatorios) y `exp = ahora + 90 s`, guarda todo eso como su pendiente y hace `POST /v0/perm/pending` (`http-api#/$defs/permPending`).
3. El servidor pone la tarea en `perm` y envía la trama `perm` al teléfono, por WebSocket y por FCM de alta prioridad (F1). La trama lleva `instance_id`, `tool`, `sum`, `wok` y `exp` **exactamente** como llegaron en el pending (§6.3); si el servidor tendría que cambiar alguno, responde 422 y no crea el permiso (el mod vuelve al flujo normal).
4. El reloj muestra `instance_id`, `tool` y `sum` completos, calcula `ph` desde esa trama, firma y envía `dec`. El teléfono la reenvía tal cual a `POST /v0/perm/decision`.
5. El mod hace long-poll `GET /v0/perm/decision?tool_use_id=…&wait=2000` en bucle. Recibe 200 `{"dec": base64url(bytes CBOR exactos)}` o 204.
6. El mod verifica (§6.3). Si la verificación pasa, devuelve `{decision, reason}`. Si falla, la descarta y sigue esperando.
7. El mod hace `POST /v0/perm/resolved` (`permResolved`). El servidor emite `st` y la trama `pclose` para que el reloj retire la solicitud. El `st` es `err` si `decision = deny` y `run` en cualquier otro caso: `allow`, y también `decision = none` con `by` = `timeout`, `abort` o `error`, porque entonces decide el diálogo del terminal y la tarea sigue viva.

Fallos: si el POST inicial falla (red, 4xx, 5xx, 422), el mod devuelve el veredicto `ask` original al instante (fail-open al flujo normal). Envuelve todo en `.catch(($,e,next)=>next(e))`. Si salta `next.signal.aborted`, el resultado es `by=abort`. Si el mod abandona la espera por un error interno (por ejemplo, falla su bucle de long-poll), informa `by=error, decision=none` y devuelve el `ask` original; el servidor lo cierra como cualquier otro (`pclose` con `by=abort`, porque `pclose.by` no cambia en 0.2) y el reloj retira la solicitud.

### 6.2 Mensajes

```
perm   = ["perm",  nonce:bstr16, tool_use_id:tstr, id:uint, exp:uint, tool:tstr, sum:tstr(≤200 B), wok:bool, instance_id:tstr]
dec    = ["dec",   nonce:bstr16, tool_use_id:tstr, decision:"allow"|"deny", ts:uint, kid:bstr8, sig:bstr64, ph:bstr32]
pclose = ["pclose", nonce:bstr16, by:"watch"|"terminal"|"timeout"|"rule"|"abort", decision:"allow"|"deny"|"none"]
```

`sum`, el resumen redactado (filtro de secretos de G3e), lo genera el mod:
- `ctx=personal`: `Bash` → `command`; `Edit`/`Write`/`Read` → `file_path`; otro tool → `tool_input` en JSON compacto. Siempre truncado a 200 B.
- `ctx=work`: solo el verbo, que es el primer token del comando (`git`, `rm`), o el nombre del tool. Es el único texto que sale de una instancia work.

En `ctx=personal`, si `sum` no es exactamente el texto que resume (el filtro de secretos cambió algo, se truncó a 200 B, o el texto lleva caracteres que no se ven o reordenan lo que se ve: formato Unicode `Cf` como U+200B o los de bidi, y de control salvo tabulador y salto de línea), el mod pone `wok=false` (§6.4). Así una aprobación desde el reloj nunca cubre texto que el usuario no ha visto; esos permisos solo se pueden denegar desde el reloj o resolver en el terminal.

El servidor reenvía `tool` y `sum` tal cual (§6.3). Como defensa, con `ctx=work` comprueba que `sum` ya es el verbo (o el nombre del tool); si su regla lo cambiaría, responde 422 en vez de reescribirlo.

`instance_id` es el de la instancia dueña del token (`[a-z0-9][a-z0-9-]{0,31}`). `id` es el nodo de la tarea (0 si no hay) y no entra en `ph`: es solo para dibujar.

### 6.3 Firma

- Algoritmo: **ECDSA P-256 (secp256r1) con SHA-256**. La llave vive en el Android Keystore del reloj (StrongBox si existe) y nunca sale de él.
- **Formato de firma 2.** La firma cubre lo que el usuario ve:
  - `ph` = SHA-256 (32 bytes) del CBOR determinista de `["orbit-perm", 1, instance_id, nonce, tool_use_id, tool, sum, wok, exp]`.
  - Entrada firmada: CBOR determinista de `["orbit-dec", 2, nonce, tool_use_id, decision, ts, ph]`. El `2` es la versión del formato de firma. El formato 1 (`["orbit-dec", 1, nonce, tool_use_id, decision, ts]`, sin `ph`) **ya no se acepta**.
- **Reloj**: calcula `ph` EXCLUSIVAMENTE a partir de los campos de la trama `perm` que muestra en pantalla, y muestra `instance_id`, `tool` y `sum` completos (`sum` ya viene truncado a 200 B por el mod). Copia `ph` en la `dec`.
- **Servidor**: NO DEBE alterar `tool`, `sum`, `wok`, `exp` ni `instance_id` entre `/v0/perm/pending` y la trama `perm`. Cualquier cambio rompe la firma (fallo seguro: el permiso acaba en el terminal). Si su defensa (`work_verb` en `ctx=work`, recorte de etiqueta) cambiaría un campo, DEBE rechazar el pending con 422 en vez de reescribirlo.
- `sig`: 64 bytes `r‖s` (big-endian, 32+32). Android produce DER y el reloj DEBE convertirlo.
- `kid`: primeros 8 bytes de SHA-256 del SubjectPublicKeyInfo DER de la llave pública. El emparejamiento está en `docs/pairing.md`.
- **Mod**: `ph` viaja en la `dec` para diagnóstico, pero el mod **no se fía de él**: recalcula `ph` desde **su** pendiente (el `instance_id`, `tool`, `sum`, `wok` y `exp` que él mismo envió en `/v0/perm/pending`) y verifica la firma sobre ese `ph` recalculado. Acepta una `dec` solo si se cumple todo esto, en este orden (el primero que falla da el motivo, `permResolved.reject`):
  0. Los bytes son una trama `dec` en CBOR determinista con la forma del schema (`malformed`).
  1. `nonce` corresponde a un permiso pendiente de este mod (`nonce`) y no se ha usado (`replay`).
  2. `tool_use_id` coincide con el del pendiente (`tool_use_id`).
  3. El `ph` recibido es igual al recalculado (`ph`).
  4. `kid` es una llave emparejada (`kid`).
  5. `sig` es válida sobre `["orbit-dec", 2, nonce, tool_use_id, decision, ts, ph recalculado]` (`sig`).
  6. `ts ≤ exp + 30` y `ahora ≤ exp` (`expired`). Los 30 s son margen para un reloj adelantado; la ventana la limita de verdad `ahora ≤ exp`, medido con el reloj del Mac.
  7. Si `decision = allow`, `wok = true` (`forbidden`).

  El servidor PUEDE prevalidar para descartar pronto (nonce conocido, `tool_use_id`, `ts ≤ exp + 30`, `ahora ≤ exp`), pero la verificación que cuenta es la del mod: el servidor no es de confianza para aprobar.
- **Emparejamiento sin autenticar**: `POST /v0/pair/offer` no lleva token (el teléfono no tiene uno propio en 0.2). Quien llegue al servidor puede publicar ofertas, pero nunca emparejar una llave: hace falta que el usuario confirme en el terminal la huella que ve en el reloj. Límites: solo instancias configuradas, SPKI con la forma exacta, como mucho 4 ofertas vigentes por instancia, caducidad de 10 minutos y confirmación humana por huella; `/orbit pair` enseña la hora de cada oferta y avisa si hay más de una pendiente. Detalle en `docs/pairing.md`. La alternativa sin huella es el emparejamiento por QR (§6.3.1): la oferta lleva un `tag` que solo puede calcular quien leyó el QR del Mac.

### 6.3.1 Emparejamiento por QR (0.2.1)

Para que baste con escanear un QR (sin teclear URL ni token y sin comparar huellas) sin romper la regla de §6.3 de que **ni el servidor ni el teléfono pueden meter una llave por sí solos**:

1. **Mac**: genera `K`, 32 bytes de un CSPRNG, **de un solo uso** y válidos **15 minutos**, y lo guarda localmente: el mod en `$.store` (`/orbit setup`), o el servidor en `setup.json` de su directorio de estado (0600) si el QR lo pide `orbit-server setup` o la página `GET /setup` (solo loopback); el mod lee ese fichero del disco. **`K` NO DEBE viajar por la red hacia el servidor.**
2. **QR**: `orbit://setup?v=1&u=<url>&i=<instance_id>&t=<token>&k=<K base64url>` (`u`, `i`, `t` con codificación de URL). `u` es la dirección del servidor vista desde el teléfono (Tailscale si existe, si no la Wi-Fi).
3. **Teléfono**: lee el QR con la cámara (o recibe ese enlace), guarda `u`, `t` e `i`, abre la conexión (§5.6) y pide la llave al reloj por Data Layer (`/orbit/pair-request`, sin cuerpo). El reloj responde con su SPKI (`/orbit/pair-offer`) sin intervención del usuario. El teléfono publica `POST /v0/pair/offer` con `tag` = HMAC-SHA256(`K`, CBOR determinista de `["orbit-pair", 1, instance_id, spki]`) y olvida `K`.
4. **Mod**: empareja **sin pedir la huella** una oferta de su instancia cuyo `tag` verifica (comparación en tiempo constante) con un `K` vigente y no usado, y **consume** ese `K` antes de guardar la llave. Las ofertas sin `tag`, o con uno que no verifica, siguen el flujo manual (`/orbit pair confirm <huella>`). Lo comprueba al empezar la sesión, tras `/orbit setup` (cada 2 s durante 2 min), en `/orbit` y en cada `tool.check` mientras haya un `K` vigente.

Modelo de amenazas:
- El **servidor** ve el SPKI y el `tag`, nunca `K`: no puede calcular un `tag` válido para otra llave (HMAC con clave de 256 bits) ni reutilizar el de la oferta legítima con otro SPKI (el `tag` cubre el SPKI y la instancia). Puede tirar o retrasar la oferta (denegación de servicio: se repite el QR o se usa el flujo manual).
- **Quien publica ofertas sin autenticar** (§6.3) tampoco conoce `K`. Repetir la oferta legítima con su mismo `tag` no le sirve: empareja la llave del reloj, y `K` ya se habrá gastado.
- El **teléfono** conoce `K` (lo leyó del QR): está en el mismo nivel que el usuario que escanea. Un teléfono comprometido podría emparejar una llave suya durante esos 15 minutos; es el precio de no comparar huellas. Quien no lo acepte usa el flujo manual.
- **El QR lleva el token de la instancia**: quien lo fotografíe puede hablar con el servidor como esa instancia y, mientras `K` siga vigente y sin usar, emparejar una llave suya. Por eso `K` caduca a los 15 minutos y sirve una vez, y el QR solo se muestra en el terminal o en `http://127.0.0.1:7878/setup` (la página comprueba la dirección de origen y la cabecera `Host`, para que una web con DNS rebinding no la lea).
- Un enlace `orbit://setup` que llega de fuera de la app (otra app, `adb`) no cambia en silencio un servidor ya configurado: si es otro, la app pregunta. El filtro del manifest no es `BROWSABLE`: una web no puede abrirlo.

Vectores: `protocol/vectors/sig/pair-tag.json` (los comprueban Kotlin, el mod y `check.mjs`). Detalle en `docs/pairing.md` §2.2.

### 6.4 Lista "nunca desde el reloj"

Se configura en el mod, como lista de expresiones regulares sobre el comando o el `tool_input` serializado. Valores por defecto: `rm -rf`, `git push --force`/`-f`, despliegues. El mod también pone `wok=false` si el `sum` no es fiel al comando (§6.2). En ambos casos, `wok=false`: el reloj muestra la solicitud pero solo permite denegar, y el mod rechaza cualquier `allow` de ese nonce (`reject:"forbidden"`), aunque la firma sea válida.

### 6.5 Carrera y expiración

- **Gana el primero**: reloj (`dec` válida), terminal (el usuario responde en el diálogo), timeout, abort o error. El mod resuelve una sola vez por `tool_use_id`; lo que llegue después se ignora y se informa como `pclose`.
- **Varias `dec` por nonce**: el servidor no puede saber qué firma es válida, así que no se queda solo con la primera. Guarda hasta **8** `dec` distintas por nonce (bytes exactos) y el long-poll las entrega **por turnos**, en orden de llegada, para que una basura que llegue antes no tape la buena. Una `dec` con los mismos bytes que una guardada es un duplicado (200, sin efecto). La novena distinta recibe **429**.
- Expiración: **90 s**. Al vencer, el mod hace `POST /v0/perm/resolved {by:"timeout", decision:"none"}` y devuelve el veredicto `ask` original (en `-p` eso es denegar con "needs approval"; S1 midió 3035 ms con un timeout de 3000).
- Tras `resolved` con `by` = `timeout`, `abort` o `error` y `decision = none`, la tarea vuelve a `run`: decide el diálogo del terminal.
- El reloj NO DEBE enviar una `dec` de un `perm` vencido. Las decisiones que esperan en la cola offline del reloj más de 120 s se descartan.
- El presupuesto de hook (10 s de CPU propia) no limita la espera: las esperas en `$.http.fetch` no cuentan (S1 probó 13 067 ms).

### 6.6 Respuestas desde el reloj (voz y respuestas rápidas)

El reloj puede escribir en una sesión: dictado por voz o una respuesta rápida ("Continúa", "Sí", "No"…, §6.6.1), "Detente", que corta el turno en curso, y "Detente y resume" (`recap`, 0.2.3), que lo corta y pide a Claude un resumen. Como un permiso, solo cuenta si lo firma una llave del reloj emparejada (§6.3): ni el servidor ni el teléfono pueden escribir en una sesión.

```
say = ["say", nonce:bstr16, ts:uint, instance_id:tstr, sid:bstr16, kind:"text"|"stop"|"recap", text:tstr(≤1000 B), kid:bstr8, sig:bstr64]
sid = SHA-256(CBOR determinista de ["orbit-sid", 1, instance_id, session_id])[0..16]
entrada firmada = CBOR determinista de ["orbit-say", 2, nonce, ts, instance_id, sid, kind, text]
```

**Formato de say 2** (0.2.2). El `2` es la versión del formato; el formato 1 (`["orbit-say", 1, nonce, ts, instance_id, kind, text]`, `say` de 8 elementos sin `sid`) **ya no se acepta**.

0. El reloj saca `instance_id` y `sid` de `info` de `GET /v0/transcript` (§8), que el servidor calcula desde las claves internas del nodo (`instance_id`, `session_id`). Sin `sid` (servidor anterior a 0.2.2) el reloj no ofrece responder. El `sid` es un resumen y no el `session_id` en claro: mide siempre 16 bytes y no saca del servidor el identificador de Claude Code (que nombra la transcripción en el Mac).
1. El reloj firma y manda `say` al teléfono junto con el epoch y el id del nodo de la sesión; el teléfono hace `POST /v0/say` `{"epoch", "id", "say": base64url}` (sin token: autentica la firma).
2. El servidor resuelve el nodo a su sesión (`instance_id`, `session_id`) y deja los bytes EXACTOS en la cola de esa sesión (máximo 8, se descartan a los 120 s). 202; 404 si el nodo no existe; 400 si no es un `say` de formato 2; 409 si su `sid` no es el de esa sesión (el mod lo rechazaría igual: así no ocupa la cola).
3. El mod de esa sesión hace long-poll `GET /v0/say?session_id=…&wait=…` con su token (solo mientras haya llaves emparejadas) y recibe `{"say": [base64url, …]}` o 204.
4. El mod acepta un `say` solo si se cumple todo esto, en este orden (el primero que falla da el motivo, que el mod anota en su log): forma de formato 2 en CBOR determinista (`malformed`); `instance_id` es el suyo (`instance`); `sid` es el que él calcula desde **su** `instance_id` y `session_id` (`session`); `kid` emparejado (`kid`); firma válida (`sig`); `ahora − 120 s ≤ ts ≤ ahora + 30 s` (`expired`); `nonce` no visto antes en esta sesión (`replay`). Entonces `text` → `$.prompt.submit` (un turno propio en cuanto la sesión queda libre; con un turno en curso, contexto del siguiente resultado de tool, §8.3); `stop` → corta el turno en curso (su `text` se ignora); `recap` → corta el turno en curso y, cuando termina, envía como prompt (`asUser`) el `text` o, si está vacío, el prompt de resumen del mod ("Detente aquí. Resume en pocas líneas en qué estabas, qué has hecho hasta ahora y qué te bloquea…"); sin turno en curso lo envía ya. El prompt por defecto lo pone el mod, no el servidor, así que el servidor no puede cambiar lo que se pide.

Modelo de amenazas: el servidor no puede inventar un `say` (no tiene la llave), ni repetirlo (`nonce`, ventana de 120 s), ni llevarlo a otra instancia (`instance_id` firmado) ni a otra sesión de la misma instancia (`sid` firmado). Si da al reloj un `sid` falso, el reloj firma una respuesta que ningún mod acepta: fallo seguro. Puede tirar o retrasar respuestas (denegación de servicio), como en §6.3.

Vectores: `protocol/vectors/sig/say.json` (los firma Kotlin; los comprueban el mod, el servidor y `check.mjs`). Schema: `frame.schema.json#/$defs/say`.

### 6.6.1 Respuestas rápidas configurables (0.2.3)

La lista de respuestas rápidas se configura en el mod: `/orbit respuestas` (lista), `/orbit respuestas añadir <texto>`, `/orbit respuestas quitar <n>`, `/orbit respuestas restablecer`. Se guarda en `replies.json` del directorio de estado (compartido por los perfiles de Claude Code, como `away.json`) o, sin él, en `$.store`. Por defecto: "Continúa", "Sí", "No", "Resume en qué estás", "Prueba otra forma". "Detente" y "Detente y resume" son acciones fijas del reloj y no están en la lista.

- El mod añade `orbit_replies: [texto, …]` a `SessionStart` y a cada `Stop` de la sesión principal (solo `ctx=personal`; en work la lista blanca lo quita y el reloj usa la suya). Un cambio llega al reloj al acabar el siguiente turno.
- `GET /v0/session` (§8.3) añade un 7.º elemento `[texto, …]` con la lista del último evento que la trajo, **solo si existe**. Límites (servidor y reloj): como mucho 8, de 1 a 64 bytes UTF-8, sin caracteres de control y sin repetidas; lo demás se descarta.
- El reloj ofrece esa lista (o la suya por defecto, la misma) y cada respuesta sale como un `say` de kind `text` firmado: la lista solo dice qué botones enseñar, no autoriza nada.

## 7. CBOR determinista

Todas las tramas siguen RFC 8949 §4.2.1:
- Enteros y longitudes con la codificación más corta.
- Solo longitudes definidas (nada de arrays o strings indefinidos).
- Sin tags.
- **0.2.0 no usa mapas**, solo arrays. Si una versión futura los añade, sus claves DEBEN ordenarse por orden bytewise de su codificación.
- Sin floats. Ningún campo de 0.2.0 los declara.
- Booleanos `0xf4`/`0xf5`. No se usa `null`.

Un decodificador DEBE rechazar CBOR no determinista (golden vectors negativos en P2), lo que permite comparar byte a byte en los tres lenguajes.

| Lenguaje | Librería recomendada | Nota |
| --- | --- | --- |
| TypeScript (mod, tools) | `cbor2` (hildjj), opción `cde: true` | Usada para medir §5.2 (v1.12.0). |
| Rust (servidor) | `ciborium` con `ciborium::Value` para los arrays heterogéneos | Ya elegida en D1. Codifica enteros con longitud mínima; sin mapas, el orden no influye. |
| Kotlin (android/shared) | `com.upokecenter:cbor` (PeterO), `CBOREncodeOptions("ctap2canonical=true")` | Maneja bien arrays heterogéneos con `CBORObject`. Alternativa: codificador propio mínimo (solo uint, tstr, bstr, bool y array). |

Que `ciborium` y PeterO den bytes idénticos está **sin verificar**: lo demuestra P2 o lo tumba (§11).

## 8. Texto bajo demanda (forma fijada aquí, implementación en fase 3)

El texto (comandos completos, prompts, respuestas, resultados) **nunca** viaja en deltas.

`GET /v0/text?epoch=<e>&id=<id>&f=<cmd|prompt|answer|result|reason>` → `200 application/cbor`:

```
["text", epoch, id, f, text:tstr(≤4096 B), trunc:bool, red:bool]
```

- `red=true` si el filtro de secretos cambió algo.
- 404 si el nodo no existe en la retención del servidor (24 h). 403 si la instancia es `ctx=work`, porque no hay texto que dar.
- El reloj guarda el texto con un TTL de 24 h.

Además (0.2, implementado en la fase 3):

- `f=cmd` en una tarea: el comando (Bash), la ruta (Read/Edit/Write), el patrón (Grep/Glob), la URL (WebFetch) o el `tool_input` en JSON compacto. `f=prompt` / `f=answer` en una sesión: el último prompt / la última respuesta.
- `GET /v0/transcript?epoch=<e>&id=<sesión>` → `200 application/cbor`, la conversación para la vista de texto del reloj:

```
["transcript", epoch, id, [[kind, text(≤1200 B), trunc, red], ...(≤60)], info]
kind = "prompt" | "answer" | "tool" | "perm" | "err"
info = [contexto_%, contexto_tokens, ventana, inicio_ms, coste_milésimas_usd, instance_id, sid]   (null donde no hay dato)
```

  Las cifras de `info` las añade el mod al `Stop` (`context`, `session_started_ms`, `cost_usd`; solo con `ctx=personal`). `instance_id` y `sid` (bstr de 16 bytes, 0.2.2) los pone el servidor: son lo que el reloj firma en sus respuestas (§6.6).
- El teléfono hace estas peticiones con su token en nombre del reloj, que se las pide por Data Layer; solo acepta exactamente esas dos formas de consulta.
- Todo el texto pasa por el filtro de secretos del servidor (tokens con forma conocida, credenciales en URL, `Authorization`, `clave=valor`) antes de salir.

### 8.3 Dónde corre una sesión y lo que produce

El mod añade campos propios a los eventos (solo con ctx=personal; la lista blanca de §3.4 los quita en work):

- `orbit_where: {profile, host}` en `SessionStart` y en cada `Stop` de la sesión principal: perfil de Claude Code
  (último componente de `CLAUDE_CONFIG_DIR`, `claude` sin él) y máquina (`hostname -s`).
- `orbit_remote`: el id de la sesión de Remote Control (`CLAUDE_CODE_BRIDGE_SESSION_ID`) si está conectada; la URL
  es `https://claude.ai/code/<orbit_remote>`. Sin el campo en el último `Stop`, la sesión no tiene Remote Control.
- `orbit_links: [{kind, name, url?, path?}]` en `PostToolUse`: `file` para lo que escribe `Write` y, si es un documento (html, md, pdf, imagen, csv, mp4), lo que toca `Edit` o lo que Bash saca con `>`, `-o` o `--output` (ruta absoluta; las relativas, contra el cwd de la sesión), `link`
  para artifacts de claude.ai y PRs/issues de GitHub que aparecen en el resultado. Como mucho 3 por resultado.

`GET /v0/session?epoch&id` (token de la instancia, work → 403; solo nodos de sesión; 7.º elemento opcional `replies` desde 0.2.3, §6.6.1) devuelve en CBOR
`["session", epoch, id, [instance_id, profile|null, host|null], remote|null, [[kind, name, url|null, by], ...]]`:
los 12 últimos enlaces sin repetidos, `by` = tipo del agente que lo produjo o `sesión`. Un archivo lleva una URL
temporal `GET /v0/file/{id}` (id aleatorio de 128 bits, 1 h, sin token, solo archivos regulares de ≤ 50 MB que existen
en la máquina del servidor; un HTML se sirve con CSP `sandbox`). `url = null`: el archivo solo está en otra máquina. Con la flota (§5.7) cada máquina corre su propio servidor y sirve los suyos; `null` queda para una máquina que envía a un servidor ajeno.
Las URL que no son `https://` o `http://` se descartan en el servidor y en el cliente.

El reloj pide `session?epoch&id` por el mismo canal que el texto (§8, `TextQuery`). Lo producido se dibuja como el
único nodo cuadrado; "Abrir en el teléfono" usa `RemoteActivityHelper` (el sistema abre la URL en el teléfono
emparejado: la app de Claude para claude.ai/code, el navegador o el visor para lo demás). Si falla (teléfono sin la
app Wear OS, emuladores), el reloj manda la URL por Data Layer (`/orbit/open-url`, cuerpo UTF-8, ≤ 2048 B); la app
del teléfono solo acepta `http(s)://` y la ofrece en una notificación que la abre al tocarla. El contenido nunca se
muestra en el reloj.

**Permisos en auto mode.** El mod no recibe el modo de permisos por ninguna API: `tool.check` trae lo mismo en
default que en auto, y los hooks `classic.*` (incluido `PermissionRequest`) están cerrados a los mods de usuario por
`cc-plugin-sec-default` ("bypassed by", comprobado con Claude Code 2.1.296). El modo se lee de la transcripción de la
sesión (`<config>/projects/<ruta real con [^A-Za-z0-9] → ->/<session_id>.jsonl`): la última aparición de
`"permissionMode":"…"` (cada mensaje del usuario la lleva y cada cambio de modo añade una entrada). En `auto`, un `ask`
de las reglas no se retiene ni se anuncia (el clasificador decide después); en cualquier otro modo, o sin transcripción,
se retiene como en §6.1.

**Respuestas a mitad de turno (§6.6).** Un `text` que llega con un turno en curso no espera: entra como `context`
del siguiente resultado de tool de la sesión principal ("Mensaje del usuario desde su reloj…"). Lo que no haya
salido al terminar el turno se envía como prompt con `asUser: true`.

## 9. Versionado

- El colector anuncia la versión en `orbit` (ingesta y `permPending`). El servidor la anuncia en `hello`.
- Mientras sea 0.x, la clave de compatibilidad es **MAJOR.MINOR**: `0.2.*` es compatible entre sí, y `0.1` y `0.2` no lo son (426 en HTTP; en el WebSocket, `hello` incompatible o cierre 4426). A partir de 1.0, la clave pasa a ser MAJOR.
- Ante una versión incompatible: la ingesta responde 426 con la versión del servidor, y en el WebSocket el servidor cierra con código 4426. El teléfono o el reloj muestran "actualiza Orbit" y no aplican nada más.
- **Cambio de patch** (compatible): campos nuevos opcionales en JSON, nuevas razones en enums informativos (`by`, `reject`) y nuevas entradas en `hook_event_name`. Los receptores ignoran lo desconocido.
- **Op informativa nueva** (patch, desde 0.2.3): una op que no cambia nodos ni estados (como `meta` o `stuck`) y que un cliente puede ignorar sin perder la consistencia del grafo; los clientes anteriores la ignoran por §5.3.
- **Rompe** (sube MINOR en 0.x): cambiar la posición o el significado de un elemento de una trama; añadir o quitar ops que cambian el grafo o tipos de nodo (`t`) o estados (`s`); cambiar la entrada firmada (§6.3); cambiar la codificación (§7); ampliar la lista blanca de work; cambiar las unidades de tiempo o los tiempos de §4.4/§5.4 que el cliente asume (10 s, 30 s).
- **Excepción, el canal de respuestas (§6.6)**: el `say` va de extremo a extremo entre reloj y mod, con su propio número de formato en la entrada firmada, y el servidor solo lo lleva. Cambiar su formato sube PATCH (0.2.1 → 0.2.2) siempre que una mezcla de versiones falle de forma segura (la respuesta se rechaza o no se ofrece) y no afecte al grafo, los permisos ni el emparejamiento.
- Después de G0 el contrato solo cambia con versión nueva y golden vectors nuevos.

## 10. Casos límite

| Caso | Regla |
| --- | --- |
| Llega `PreToolUse` sin `UserPromptSubmit` ni `SessionStart` | La sesión se crea al vuelo (§4.2). |
| Nunca llega `PostToolUse` (interrupción) | La tarea pasa a `err` con el `Stop` de su hilo, el `SubagentStop` de su agente o el `SessionEnd`. |
| Subagente `background:true` | El tool `Agent` termina enseguida ("Async agent launched"). Su `PostToolUse` no cierra el agente; lo cierra `SubagentStop` o `turn.complete` con `agentId`. |
| Varios `Agent` del mismo tipo a la vez (hooks) | FIFO, corregido con `tool_response.agentId` (§4.3). |
| Subagente dentro de un subagente | `p` es el agente emisor, si el `PreToolUse(Agent)` trae `agent_id`. Sin verificar (§11). |
| Dos permisos en el mismo turno | Cada uno con su nonce. En S1, `tool.check` los evaluó **en serie** (~1,4 s de diferencia): el segundo no llega al reloj hasta que se resuelve el primero. |
| Permiso hook sin tarea emparejable | Se envía `perm` con `id=0`; el reloj lo muestra igual. |
| `dec` duplicada o reenviada | Mismos bytes: el servidor la cuenta como duplicado. Si llega al mod con el nonce ya usado, se descarta (`reject:"replay"`). |
| Varias `dec` distintas para un nonce | El servidor guarda hasta 8 y las entrega por turnos; la novena recibe 429 (§6.5). |
| Servidor que cambia `tool`, `sum`, `wok`, `exp` o `instance_id` en la trama `perm` | El reloj firma lo que ve; el `ph` no coincide con el que recalcula el mod y la `dec` se rechaza (`ph`). Nada se ejecuta. |
| Reloj con la hora adelantada | `ts` hasta `exp + 30` se acepta; más allá, `expired`. `ahora ≤ exp` se mide en el Mac. |
| `dec` tras la expiración, o tras ganar el terminal | Se ignora; el reloj recibe `pclose` con quién ganó. |
| Comando prohibido aprobado desde el reloj | Se rechaza (`forbidden`). El permiso sigue pendiente hasta que se deniegue, gane el terminal o venza. |
| Servidor caído al pedir permiso | El mod devuelve `ask` al instante: el flujo normal del terminal. La sesión nunca se bloquea por Orbit. |
| Reinicio del servidor | Nuevo epoch: todos los clientes ven el epoch distinto y piden snap. |
| Ráfaga (p. ej. 50 `ToolSearch` de 10 ms) | Colapsada: no sale nada. |
| Snap enorme (> 400 nodos) | Se envía igual. El reloj agrupa al dibujar (G3a). Un snap no se trocea en 0.2.0. |
| Ids o `seq` cerca de su límite (2^32-1 y 2^53-1) | Antes de desbordar, el servidor abre un epoch nuevo. Hay golden vector de ids grandes. |
| Nombre MCP con `__` dentro del servidor | Ambiguo: se toma el segmento 1 como servidor (§4.2). |
| Args aplanados de `tool.call` que se llaman `tool` o `tool_use_id` | Colisión en el motor: el mod usa `tool.check.input` cuando lo tiene. |
| Campo nuevo en un hook | Se guarda con `ctx=personal` y se elimina con `ctx=work` (lista blanca). |
| Cola offline del mod con eventos viejos | Se reenvían en orden de `n`. El servidor deduplica, y los eventos de sesiones ya cerradas solo van al log crudo. |

## 11. Pendiente de decidir

| # | Tema | Qué falta | Quién / cuándo |
| --- | --- | --- | --- |
| U1 | Sesión **interactiva** | Si el diálogo del terminal aparece mientras el mod retiene en `tool.check` (probablemente espera al timeout), y si responder en el terminal aborta la espera (`next.signal`). Afecta a "gana el primero". | 👤 prueba manual con trust concedido; K2 |
| U2 | `classic.*` en otras orgs | En la org `team` el mod no recibe `classic.*`. No se sabe qué pasa en otras orgs. Si los recibiera, `PermissionRequest`/`SubagentStart` del mod serían más directos. | Fase 1 (M1) |
| U3 | `prompt_id` vs `turnId` | ✅ Resuelto en fase 1: **no** coinciden. Son campos distintos y no sirven para deduplicar hooks y mod; con ambos activos el servidor recibe el mismo evento por las dos vías. | — |
| U4 | `SessionStart`, `TaskCreated`, `TaskCompleted`, `Notification`, `PostToolUseFailure` | Sin payload real. En el schema solo se exigen los campos comunes y están marcados `x-unverified`. | T1 / fase 1 en interactivo |
| U5 | Respuesta de un hook HTTP `PermissionRequest` (allow/deny) | No probada: el plan B de permisos sin mod no está demostrado. | Fase 4 o si cae el mod |
| U6 | Autenticación de hooks HTTP | ✅ Resuelto en fase 1: funcionan con `allowedEnvVars` (§3.2). | — |
| U7 | `"timeout"` en un hook HTTP | ✅ Resuelto en fase 1: segundos, entero positivo; `0` o string anulan el hook (§3.2). | — |
| U8 | CSPRNG y ECDSA dentro del sandbox del mod | No se comprobó si existe `crypto.getRandomValues`/`crypto.subtle` sin Node ni DOM. Plan: `@noble/curves` (JS puro) para verificar, y como entropía `$.process.run(['openssl','rand','16'])` si no hay CSPRNG. Falta validarlo en Windows. | K1 |
| U9 | Subagentes anidados | Sin captura. La regla del emisor (§4.2) es una suposición. | T1 |
| U10 | Igualdad byte a byte de `cbor2`, `ciborium` y PeterO | Sin probar. | P2 / G0 |
| U11 | Ventana W = 1000 ms y umbral de snap de 400 nodos | Tamaño ✅ en G1: el criterio "≤ 30 B por delta" se mide **por op** CBOR, sin la cabecera de la trama (medido: 16–17 B por op; ~70 B por trama). Batería sin medir. | G3f |
| U12 | Errores de tool con hooks | El fixture de `PostToolUse` no trae un campo de error claro. Falta capturar `PostToolUseFailure` o un `tool_response` de error. | T1 |

## 12. Ficheros

| Fichero | Contenido |
| --- | --- |
| `schema/hook-payload.schema.json` | Payload canónico de evento (forma de hook). |
| `schema/ingest.schema.json` | Sobre y lote de ingesta, con la lista blanca de `ctx=work`. |
| `schema/frame.schema.json` | Tramas CBOR (hello, d, req, perm, pclose, dec, text) en forma JSON. |
| `schema/http-api.schema.json` | `permPending`, `permDecision`, `permResolved`. |
| `schema/pairing.schema.json` | Rutas de emparejamiento (`docs/pairing.md`), `client.json` y los K del QR (§6.3.1). |
| `schema/mod-engine-event.schema.json` | No normativo: lo que ve el mod (entrada de §3.3), validado contra `fixtures/raw/mod`. |
| `schema/examples/{valid,invalid}/` | Ejemplos que deben pasar o fallar. No son golden vectors (los hace P2). |
| `schema/validate.mjs` | Valida fixtures reales y ejemplos. `npm --prefix protocol ci && node protocol/schema/validate.mjs`. |

Los fixtures crudos tienen las rutas locales anonimizadas (`/Users/dev/...`).
