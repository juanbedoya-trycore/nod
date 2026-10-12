# nod-collector

Recibe eventos [Nod v1](../docs/nod-v1.md), los guarda en SQLite, calcula métricas por tarea y da los límites de
uso para la barra de tmux.

## Comandos

```sh
nod-collector serve  [--listen 127.0.0.1:8787] [--db <ruta>] [--token-file <ruta>]
nod-collector import <fichero.jsonl>... [--db <ruta>]
nod-collector report [--task T] [--session S] [--since 7d|24h|<fecha>] [--json] [--db <ruta>]
nod-collector limits [--from-file <events.jsonl>] [--db <ruta>] [--instance I] [--format tmux|text|json]
```

La db por defecto es `$XDG_STATE_HOME/nod/nod.db`, o `~/.local/state/nod/nod.db`.

**serve.** `POST /v1/events` valida el sobre contra el esquema (`nod: 1`, campos requeridos, enums, y los
campos obligatorios de `data` según el tipo). Respuestas: 200 `{"accepted": n, "duplicates": d}`, 400 si el sobre
no es válido (no se guarda ningún evento del lote), 401 si hay `--token-file` y el `Authorization: Bearer` no
coincide (comparación en tiempo constante; se comprueba antes de leer el cuerpo), 413 si el cuerpo pasa de 5 MB,
500 si falla el disco (Nod reintenta). La clave primaria es (instance, run, seq): las entregas repetidas se
cuentan como duplicados. Los tipos de evento desconocidos se guardan. `GET /v1/limits`: por instancia, el último
`usage` que trae `limits`, con `limits`, `context`, `ts` y `session`. `GET /health`: `{"ok": true}`.

**import.** Carga el fichero del destino de tipo fichero (una línea = un sobre). Es idempotente. Las líneas
inválidas (una línea a medio escribir, un sobre de otra versión) se saltan y se listan, y el comando sale con 1.

**report.** Agrupa por tarea (`task` de cada evento; `(sin tarea)` si no tiene). Con `--session`, filtra esa
sesión y la muestra en el grupo. `--since` acepta `30m`, `24h`, `7d`, `2w`, `YYYY-MM-DD` o RFC 3339 (sin zona,
UTC). `--json` da la misma estructura que la tabla, con nombres de campo estables.

**limits.** Los límites de 5 h y 7 días del último `usage` con `limits`, de la db o leyendo el fichero de
eventos desde el final (sin collector). `tmux` da `5h 37% ↻2h10 · 7d 12%`: rojo (`#[fg=red]`) desde el 80 %,
amarillo desde el 50 % (sobre el porcentaje redondeado que se ve) y `↻` con lo que falta para el `resets_at`
del límite de 5 h. Un límite cuya renovación ya pasó no se muestra: su porcentaje es de la ventana anterior. Sin
datos, la salida queda vacía y sale con 0.

## Cómo se calcula cada métrica

"Principal" = eventos sin `agent`. Todo sale de los campos del contrato (§3 y §3.1).

| Métrica | Cálculo |
| --- | --- |
| Tiempo del agente | Σ `turn.end.duration_ms` del principal. Los turnos de subagentes corren dentro de los del principal: sumarlos contaría dos veces el mismo tiempo |
| Tiempo esperándote | Σ `permission.decision.wait_ms` con `by` = `user` o `remote` (principal y subagentes), con cuántas decisiones son y cuántas son cota superior (`exact: false`) |
| Bloqueado por otros mods | Σ `check_ms` de `permission.request` y `permission.decision` (Nod lo pone en uno de los dos, nunca en ambos) |
| Autonomía | `turn.step` del principal / `prompt.submit` con `origin: "composer"` |
| Permisos por tool | preguntados = `permission.request`; negados = `permission.decision` con `deny` y `by` = `user` o `remote` |
| Interrupciones | `turn.end` del principal con `outcome: "aborted"` (abortar el turno también corta sus subagentes: no se cuentan dos veces) |
| Prompts reescritos / del historial | `prompt.submit.edit.revised` / `prompt.submit.edit.recalled` |
| Bucles | rachas de ≥ 3 `tool.result` seguidos con `ok: false` de la misma tool, en la misma sesión y el mismo agente. Un resultado con `rejected: true` (lo negó el humano) no es un fallo y corta la racha |
| Tokens | Σ `turn.step.usage` (input, output, cache_read, cache_write), y aparte la parte de los pasos con `agent`. `turn.end.usage` y `agent.end.usage` son agregados y no se suman |
| Eficiencia de caché | `cache_read / (input + cache_read + cache_write)` |
| Presión de contexto | máximo de `usage.context.percent` |
| Costo | por sesión, el último `usage.cost_usd`; sumado entre sesiones |
| Ritmo del límite de 5 h | entre `usage` consecutivos de la misma instancia con el mismo `resets_at` del límite `five_hour`: Σ Δ`percent_used` / Σ Δhoras (media ponderada por tiempo, en puntos porcentuales por hora) |

## Desarrollo

```sh
cargo test                               # incluye un serve real, el fixture de ../test/fixtures y el binario
cargo clippy --all-targets -- -D warnings
cargo fmt --check
nix build .#collector                    # desde la raíz del repo
```

HTTP con tiny_http (síncrono): el collector es local, recibe lotes cada 250 ms como mucho y escribe en una
sola conexión SQLite; un runtime asíncrono no aportaría nada y alargaría la compilación.
