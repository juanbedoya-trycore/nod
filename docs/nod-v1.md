# Nod v1: el flujo de eventos

Nod observa una sesión de un agente de código (hoy Claude Code) y emite **eventos Nod v1**: un flujo
normalizado, independiente del agente y de quien lo consuma. Un consumidor (un collector de métricas, el
servidor de Orbit, un fichero) no necesita saber nada del agente: solo este documento.

Esquema JSON: [`schema/nod-v1.schema.json`](../schema/nod-v1.schema.json). Los nombres de este documento
son normativos; los campos marcados *opcional* pueden faltar.

## 1. Transporte

### 1.1 HTTP

`POST <url>/v1/events` con `Content-Type: application/json` y, si el destino tiene token,
`Authorization: Bearer <token>`. Cuerpo: un **sobre** (§2). Respuestas:

| Estado | Significado | Nod hace |
| --- | --- | --- |
| 2xx | aceptado. Opcional: `{"accepted": n, "duplicates": d}` | quita el lote de la cola |
| 400, 413, 422 | lote inválido para siempre | parte el lote por la mitad hasta aislar el evento culpable y lo descarta (contado) |
| 401, 403 | token rechazado | conserva la cola, reintenta con espera |
| otro / red | fallo temporal | conserva la cola, reintenta con espera exponencial (máx. 30 s) |

Los eventos se agrupan en lotes (ventana de 250 ms, máx. 500 eventos). Los de fin de turno, fin de sesión y
permiso pendiente salen sin esperar a la ventana. La cola sobrevive a reinicios y a caídas del destino.

### 1.2 Fichero

Una línea JSON por **sobre** (mismo formato que HTTP), añadida al final del fichero. Pensado para uso local,
el perfil de trabajo y depuración.

### 1.3 Entrega

Al menos una vez. El par (`source.instance`, `seq`) identifica un evento: un consumidor que lo vea dos veces
debe ignorar la segunda. `seq` crece estrictamente por instancia (puede tener huecos, nunca repetidos).

## 2. Sobre

```json
{
  "nod": 1,
  "source": { "instance": "mbp-personal", "host": "claude", "host_version": "2.1.296",
              "machine": "mbp", "profile": "personal", "privacy": "completo" },
  "events": [ { "seq": 1, "ts": 1791838903681, "type": "session.start", "session": "6d4b…", "data": { } } ]
}
```

| Campo | Qué es |
| --- | --- |
| `nod` | versión del formato: `1` |
| `source.instance` | identidad estable del emisor (máquina + perfil). Ver `NOD_INSTANCE` |
| `source.host` | agente: `claude` (después `opencode`, `codex`…) |
| `source.host_version` | versión del agente, *opcional* |
| `source.machine` | nombre corto de la máquina, *opcional* (no sale con privacidad `trabajo`) |
| `source.profile` | perfil del agente (`personal`, `trabajo`… el nombre del directorio de configuración) |
| `source.privacy` | perfil de privacidad aplicado a estos eventos (§4) |

## 3. Eventos

Campos comunes:

| Campo | Qué es |
| --- | --- |
| `seq` | entero > 0, creciente por instancia |
| `ts` | milisegundos Unix en que ocurrió |
| `type` | uno de la tabla de abajo |
| `session` | id de sesión del agente |
| `turn` | id del turno, *opcional* |
| `agent` | id del subagente; ausente = sesión principal |
| `task` | tarea asociada (§5), *opcional* |
| `data` | lo propio de cada tipo |

Tiempos en `*_ms`, tokens en `usage` = `{ "input", "output", "cache_read", "cache_write", "model" }`.

| `type` | Cuándo | `data` |
| --- | --- | --- |
| `session.start` | empieza la sesión | `cwd`, `repo` {`root`, `remote`, `name`} *opc.*, `model` *opc.*, `interactive`, `surface` (`terminal`, `ide`…) |
| `session.end` | termina | `reason`, `duration_ms` |
| `prompt.submit` | se envía un prompt | `origin` (`composer` = el humano; `task-notification`, `queue`, `mod`… = otros), `chars`, `text` *opc.*, `edit` {`events`, `typing_ms`, `recalled`, `revised`} *opc.* |
| `turn.start` | empieza un turno de la sesión principal | — |
| `turn.step` | termina una llamada al modelo | `index`, `model`, `effort` *opc.*, `stop_reason`, `tools` (nombres), `usage` |
| `turn.end` | termina el turno | `duration_ms`, `outcome` (`answer`, `aborted`, `error`…), `usage`, `steps`, `answer_chars`, `answer` *opc.* |
| `tool.call` | el agente va a usar una tool | `tool_use_id`, `tool`, `verb` *opc.* (primera palabra de un comando), `input` *opc.* |
| `tool.result` | la tool terminó | `tool_use_id`, `tool`, `duration_ms`, `ok`, `rejected` (el humano la negó), `output_chars` |
| `permission.request` | el agente pide permiso al humano | `tool_use_id`, `tool`, `reason` *opc.* |
| `permission.decision` | se decidió un permiso | `tool_use_id`, `tool`, `decision` (`allow`/`deny`), `by` (`policy`, `user`, `remote`, `timeout`), `wait_ms` |
| `agent.spawn` | arranca un subagente | `agent`, `type`, `description` *opc.*, `background`, `model` *opc.*, `tool_use_id` |
| `agent.end` | acaba un turno del subagente (lleva el acumulado desde su arranque; si hay varios, vale el último) | `agent`, `duration_ms`, `usage` |
| `usage` | instantánea de consumo, al final de cada turno principal | `context` {`tokens`, `window`, `percent`}, `limits` [{`kind`, `percent_used`, `resets_at`}], `cost_usd` *opc.* |
| `command` | el humano ejecuta un comando de barra | `name` (sin argumentos) |
| `task.set` | cambia la tarea de la sesión | `task`, `title` *opc.*, `source` (`command`, `env`, `branch`) |

Reglas de derivación (para quien implemente un adaptador):

- Un permiso preguntado que sigue sin respuesta al cerrar su turno (Esc en el diálogo) cuenta como `deny` por `user`.
- `permission.decision` con `by: "policy"`: el agente lo resolvió sin preguntar (reglas, modo, clasificador).
  `by: "user"`: hubo `permission.request` y el humano contestó; `wait_ms` es el tiempo hasta su respuesta.
- El tiempo bloqueado esperando al humano es la suma de `wait_ms` con `by: "user"` (o `remote`).
- `prompt.submit.data.edit.recalled`: el prompt partió de uno anterior (historial); `revised`: se borró o se
  reescribió texto antes de enviarlo. Son señales humanas: no existen en los hooks clásicos.

## 4. Privacidad

| Perfil | Qué sale | Destinos |
| --- | --- | --- |
| `completo` | todo, también `text`, `answer`, `input` y rutas | cualquiera |
| `redactado` | sin `text`, `answer`, `input`, `description`, `title`, `cwd`, `repo.root`, `repo.remote`, el `reason` del permiso ni `machine`. Quedan tipos, tiempos, tokens, nombres de tool, `verb`, `repo.name` y longitudes | cualquiera |
| `trabajo` | como `redactado` | solo locales: ficheros y URLs de `localhost`/`127.0.0.1` |

El perfil se aplica **antes** de encolar: lo que no debe salir nunca toca la cola ni el disco.

## 5. Tareas

Una sesión puede asociarse a una tarea (historia de usuario, ticket) para medir su costo:
`/nod tarea <id> [título]`, la variable `NOD_TASK`, o (fase 2) la rama de git. Todos los eventos posteriores
llevan `task`. Los commits podrán llevar los trailers `Claude-Session: <session>` y `Task: <id>`, que unen el
proceso (Nod) con el resultado (chrono).

## 6. Versionado

Campos nuevos *opcionales* o tipos nuevos no cambian `nod`: un consumidor debe ignorar lo que no conoce.
Quitar o cambiar el sentido de un campo sube `nod` a 2.
