# Nod v1: el flujo de eventos

Nod observa una sesión de un agente de código (hoy Claude Code) y emite **eventos Nod v1**: un flujo
normalizado, independiente del agente y de quien lo consuma. Un consumidor (un collector de métricas, el
servidor de Orbit, un fichero) no necesita saber nada del agente: solo este documento.

Esquema JSON: [`schema/nod-v1.schema.json`](../schema/nod-v1.schema.json). Los nombres de este documento son
normativos; lo marcado *opc.* puede faltar.

## 1. Transporte

### 1.1 HTTP

`POST <url>/v1/events` con `Content-Type: application/json` y, si el destino tiene token,
`Authorization: Bearer <token>`. Cuerpo: un **sobre** (§2). Respuestas:

| Estado | Significado | Nod hace |
| --- | --- | --- |
| 2xx | aceptado. *Opc.*: `{"accepted": n, "duplicates": d}` | quita el lote de la cola |
| 401, 403 | token rechazado (se comprueba antes que el contenido) | conserva la cola, reintenta con espera |
| 400, 413, 422 | lote inválido para siempre | parte el lote por la mitad hasta aislar el evento culpable y lo descarta (contado) |
| otro, red o sin respuesta en 10 s | fallo temporal | conserva la cola, reintenta con espera exponencial (máx. 30 s) |

Los eventos se agrupan en lotes (ventana de 250 ms, máx. 500). Los de fin de turno, fin de sesión, fin de
subagente y permiso preguntado salen sin esperar a la ventana. La cola se guarda en el almacén del agente
(como mucho cada 2 s mientras crece, y tras cada entrega o fallo) y sobrevive a reinicios y a caídas del
destino. Al cerrar la sesión Nod intenta entregar todo durante 3 s; lo que no salga se entrega en una sesión
posterior.

### 1.2 Fichero

Una línea JSON por **sobre** (mismo formato que HTTP), añadida al final del fichero. Para uso local, el perfil
de trabajo y depuración.

### 1.3 Identidad y entrega

Al menos una vez. Cada proceso del agente es una **ejecución** con un id aleatorio (`source.run`); dentro de
ella `seq` empieza en 1 y crece de uno en uno. La identidad de un evento es (`source.instance`, `source.run`,
`seq`): un consumidor que la vea dos veces debe ignorar la segunda. Varias ejecuciones de la misma instancia
(dos terminales con el mismo perfil) conviven: no se puede deduplicar con una marca de agua por instancia.

## 2. Sobre

```json
{
  "nod": 1,
  "source": { "instance": "personal-3fa9c2d1", "run": "9b1e44a0", "host": "claude", "host_version": "2.1.296",
              "machine": "mbp", "profile": "personal", "privacy": "completo" },
  "events": [ { "seq": 1, "ts": 1791838903681, "type": "session.start", "session": "6d4b…", "data": { } } ]
}
```

| Campo | Qué es |
| --- | --- |
| `nod` | versión del formato: `1` |
| `source.instance` | identidad estable del emisor: por defecto `<perfil>-<id aleatorio del perfil en esta máquina>` (no lleva el nombre del equipo). `NOD_INSTANCE` la fija |
| `source.run` | ejecución (proceso) del agente, 8 hex |
| `source.host` | agente: `claude` (después `opencode`, `codex`…) |
| `source.host_version` | versión del agente, *opc.* |
| `source.machine` | nombre corto de la máquina, *opc.*; solo con privacidad `completo` |
| `source.profile` | perfil del agente (el nombre de su directorio de configuración) |
| `source.privacy` | perfil de privacidad aplicado a estos eventos (§4) |

## 3. Eventos

Campos comunes:

| Campo | Qué es |
| --- | --- |
| `seq` | entero ≥ 1, creciente dentro de la ejecución |
| `ts` | milisegundos Unix en que ocurrió (para una decisión de permiso, el instante de la respuesta) |
| `type` | uno de la tabla de abajo; un consumidor ignora los que no conozca |
| `session` | id de sesión del agente |
| `turn` | id del turno, *opc.* (en `agent.spawn`, el turno principal que lanzó el subagente) |
| `agent` | id del subagente; ausente = sesión principal |
| `task` | tarea asociada (§5), *opc.* |
| `data` | lo propio de cada tipo |

Tiempos en `*_ms`; tokens en `usage` = `{ "input", "output", "cache_read", "cache_write", "model" opc. }`.

| `type` | Cuándo | `data` |
| --- | --- | --- |
| `session.start` | empieza la sesión | `interactive`; *opc.*: `cwd`, `repo` {`root`, `remote`, `name`, `branch`}, `model`, `surface` (`terminal`, `ide`…), `continued` (`true`: el agente cambió de sesión sin anunciarlo, p. ej. tras `/clear`) |
| `session.end` | termina | `reason` (`exit`, `clear`…), `duration_ms` |
| `prompt.submit` | se envía un prompt | `origin` (`composer` = el humano; `task-notification`, `queue`… = otros), `chars`; *opc.*: `text`, `edit` {`events`, `typing_ms`, `recalled`, `revised`} (solo en `composer`) |
| `turn.start` | empieza un turno de la sesión principal (los subagentes no lo tienen) | — |
| `turn.step` | termina una llamada al modelo | `index`, `tools` (nombres), `usage`; *opc.*: `model`, `effort`, `stop_reason`, `partial` (`true`: sin motivo de parada, la llamada se cortó y `usage` puede quedarse corto) |
| `turn.end` | termina el turno | `outcome` (`answer`, `aborted`…), `usage` (suma de sus pasos), `steps`, `answer_chars`; *opc.*: `duration_ms` (lo da el agente; si falta, un consumidor puede usar `ts` de `turn.end` menos el de `turn.start`), `answer` |
| `tool.call` | el agente va a usar una tool | `tool_use_id`, `tool`; *opc.*: `verb` (programa de un comando de shell), `input` |
| `tool.result` | la tool terminó | `tool_use_id`, `tool`, `duration_ms` (ejecución), `ok`, `rejected` (el humano la negó), `output_chars` |
| `permission.request` | el agente pregunta al humano | `tool_use_id`, `tool`; *opc.*: `reason`, `check_ms` (lo que tardó en decidir preguntar: crece si otro mod retuvo el permiso) |
| `permission.decision` | se decidió un permiso | `tool_use_id`, `tool`, `decision` (`allow`/`deny`), `by` (`policy`, `user`, `remote`), `wait_ms`, `exact`; *opc.*: `check_ms` (solo con `by: "policy"`: un permiso lleva `check_ms` en su `permission.request` o en su decisión, nunca en los dos) |
| `agent.spawn` | arranca un subagente | `agent`, `type`, `background`; *opc.*: `fork`, `permission_mode`, `description`, `model`, `tool_use_id` |
| `agent.end` | acaba un turno del subagente | `agent`, `duration_ms`, `usage` (acumulado desde su arranque; si hay varios, vale el último) |
| `usage` | instantánea de consumo, al final de cada turno principal | al menos uno de: `context` {`tokens`, `window`, `percent`}, `limits` [{`kind` (`five_hour`, `seven_day`; otros posibles), `percent_used` (0–100), `resets_at` opc. (ISO 8601)}], `cost_usd` (acumulado de la sesión **en este proceso**: al reanudarla en otro proceso vuelve a empezar) |
| `command` | el humano ejecuta un comando de barra | `name` (sin argumentos) |
| `task.set` | cambia la tarea | `task` (`null` = tarea cerrada), `source` (`command`, `env`, `branch`); *opc.*: `title` |
| `vcs.commit` | un comando de la sesión creó un commit (p. ej. `git commit` desde Bash) | `sha` (completo o abreviado, como lo dio git), *opc.*: `branch`, `repo` (nombre), `tool_use_id`, `files` (número de ficheros cambiados) |

### 3.1 Reglas de derivación

- **Permisos.** `by: "policy"`: el agente lo resolvió sin preguntar (reglas, modo, clasificador). `by: "user"`:
  hubo `permission.request` y el humano contestó; `wait_ms` va de la pregunta a la respuesta. `by: "remote"`:
  lo decidió un aprobador externo a través del canal de control de Nod (aún no existe en v1.0; se reserva).
- **Respuesta exacta.** El agente no avisa cuando el humano aprueba: Nod lo calcula como el fin de la tool menos
  su ejecución (en Claude, la duración del hook clásico `PostToolUse`). Si el agente no la da, `wait_ms` es una
  cota superior y `exact: false`. Las negativas siempre son exactas.
- Un permiso preguntado que sigue sin respuesta al cerrar su turno (Esc en el diálogo) cuenta como `deny` por
  `user`.
- **Tiempo bloqueado esperando al humano** = Σ `wait_ms` con `by: "user"` (y `remote`). El tiempo de un mod que
  retiene el permiso antes de preguntar está en `check_ms`.
- **Tokens.** El total de una sesión o tarea es Σ `turn.step.usage` (incluye subagentes). `turn.end.usage` y
  `agent.end.usage` son agregados de esos mismos pasos: no se suman encima.
- `prompt.submit.edit.recalled`: el prompt partió de uno anterior (historial); `revised`: se sustituyó o borró
  texto antes de enviarlo. Son señales humanas: no existen en los hooks clásicos.

## 4. Privacidad

| Perfil | Qué sale | Destinos |
| --- | --- | --- |
| `completo` | todo, también `text`, `answer`, `input`, rutas y `machine` | cualquiera |
| `redactado` | sin `text`, `answer`, `input`, `description`, `title`, `cwd`, `repo.root`, `repo.remote`, el `reason` del permiso ni `machine`. Los identificadores que escribe el usuario (tarea, comandos propios, tipos de subagente propios, servidores MCP) van como hash `h-xxxxxxxx`: se puede agrupar, no leer. Quedan tipos, tiempos, tokens, nombres de tool, `verb`, `repo.name` y longitudes | cualquiera |
| `trabajo` | como `redactado`, pero con los identificadores legibles (no salen de la máquina) | solo locales: ficheros y URLs de `localhost`, `127.0.0.1` o `::1` |

- El perfil se aplica **antes** de encolar. Si se endurece (por `/nod privacidad` o al arrancar con otro
  perfil), lo que ya estaba en cola se vuelve a filtrar, y la cola de un destino que ya no lo admite se vacía.
- `NOD_PRIVACY` manda. Si no, la del fichero de configuración; `/nod privacidad` solo puede **endurecerla**.
- `verb` solo sale si es un nombre de programa limpio (sin comillas, variables ni subshell, y no un script
  propio como `deploy-cliente.sh`).

## 5. Tareas y git

Una sesión puede asociarse a una tarea (historia de usuario, ticket) para medir su costo, por orden de
preferencia: `/nod tarea <id> [título]`, la variable `NOD_TASK`, o la rama de git si su nombre lleva un id de
ticket (`feature/ABC-123-login` → `ABC-123`, patrón `[A-Z][A-Z0-9]+-[0-9]+`). Todos los eventos posteriores
llevan `task`.

**Proceso y resultado.** Nod mide el proceso (cómo se trabajó); el resultado (qué se entregó, si aguantó) sale
del historial de git, por ejemplo con chrono. Los une `vcs.commit`: cada commit que crea una sesión queda con
su `sha`, su sesión y su tarea. Claude Code ya añade a sus commits el trailer `Claude-Session`; con `vcs.commit`
no hace falta tocar el mensaje del commit para saber de qué sesión y tarea salió.

## 6. Versionado

Campos nuevos *opcionales* o tipos nuevos no cambian `nod`: un consumidor debe ignorar lo que no conoce.
Quitar o cambiar el sentido de un campo sube `nod` a 2.
