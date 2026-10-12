# Nod

Nod observa tus sesiones de Claude Code y te da información de verdad sobre ellas: cuánto trabajó el agente,
cuánto tiempo estuvo esperándote, qué permisos negaste, cuántos tokens costó cada tarea, cuándo interrumpiste
o reescribiste un prompt y cuánto te queda del límite de uso. Lo entrega como un flujo de eventos normalizado,
**Nod v1** ([especificación](docs/nod-v1.md), [esquema](schema/nod-v1.schema.json)), a los destinos que elijas:
un fichero local, un collector de métricas, el servidor de [Orbit](#quién-lo-usa)…

Nod no depende de ningún consumidor: sin configurar nada escribe en `~/.local/state/nod/events.jsonl` y nada
sale de tu máquina.

## Instalar

En Claude Code (2.1.296 o más reciente):

```
/plugin install nod --marketplace juan52878911/nod
```

o desde la terminal, en el perfil que quieras:

```sh
claude plugin marketplace add juan52878911/nod
claude plugin install nod@nod --scope user
```

Abre una sesión nueva y escribe `/nod`.

### Con Nix (home-manager)

```nix
# flake.nix
inputs.nod.url = "github:juan52878911/nod";

# módulo de home-manager
imports = [ inputs.nod.homeManagerModules.default ];
programs.nod.enable = true;
```

En cada `switch` el plugin se instala o se actualiza en **todos** los perfiles de Claude Code (`~/.claude` y
los de [ws](https://github.com/juan52878911/tmux-ws), `~/.local/state/ws/claude/*`), y un agente de launchd lo
instala en los perfiles nuevos en cuanto aparecen. Si encuentra una versión anterior (`orbit@orbit-local`,
`orbit@orbit`), la quita. A mano: `nod-sync` (`--force` reinstala).

| Opción | Por defecto | Qué hace |
| --- | --- | --- |
| `programs.nod.claude` | `~/.local/bin/claude` | El binario con el que se instala el plugin |
| `programs.nod.profiles` | `[]` (todos) | Lista fija de directorios de configuración de Claude Code |
| `programs.nod.watchProfiles` | `true` en macOS | Instalar también en los perfiles de ws que se creen después |
| `programs.nod.settings` | `{}` | El `~/.config/nod/config.json` (ver [Configuración](#configuración)); si no está vacío, manda |
| `programs.nod.collector.enable` | `false` | [nod-collector](#collector-y-panel-de-límites) como servicio, y Nod entregándole los eventos |
| `programs.nod.collector.listen` | `127.0.0.1:8787` | Dónde escucha el collector |
| `programs.nod.collector.tmux` | `false` | `nod-collector` en el PATH para la barra de tmux (la línea de tmux la pones tú) |

## Qué mide

| Pregunta | De dónde sale |
| --- | --- |
| ¿Cuánto trabajó el agente y cuánto esperó por mí? | `turn.end.duration_ms`, `permission.decision.wait_ms` con `by: "user"` |
| ¿Qué permisos negué, de qué tools? | `permission.decision` (`deny`, `user`) y `tool.result.rejected` |
| ¿Cuántos turnos hace el agente por cada prompt mío? | `prompt.submit` con `origin: "composer"` frente a `turn.step` |
| ¿Interrumpí o reescribí? | `turn.end.outcome = "aborted"`, `prompt.submit.edit` (`revised`, `recalled`, `typing_ms`) |
| ¿Cuántos tokens y cuánta caché por tarea? | Σ `turn.step.usage` (incluye subagentes; `turn.end` y `agent.end` son agregados, no se suman), agrupado por `task` |
| ¿Cuánto me queda del límite de 5 h? | `usage.limits` (5 h y 7 días, con su renovación), `usage.context`, `usage.cost_usd` |

Las señales humanas (aprobar o negar, interrumpir, reescribir un prompt) solo las ve un mod: no existen en los
hooks clásicos ni en la exportación OpenTelemetry de Claude Code.

## Uso

| Comando | Para |
| --- | --- |
| `/nod` | Estado: destinos, cola y cifras de esta sesión (turnos, tokens, esperas, límites, costo) |
| `/nod tarea <id> [título]` | Asociar lo que sigue a una tarea (historia de usuario, ticket); `/nod tarea fin` la cierra |
| `/nod privacidad completo\|redactado\|trabajo` | Qué sale de este perfil (ver abajo) |
| `/nod pausa` / `/nod reanuda` | Dejar de entregar (los eventos esperan en la cola) y volver a entregar |

### Privacidad

| Nivel | Qué sale | Adónde |
| --- | --- | --- |
| `completo` | todo: prompts, respuestas, comandos, rutas | cualquier destino |
| `redactado` | sin texto ni rutas: tipos, tiempos, tokens, nombres de tool y el verbo del comando | cualquier destino |
| `trabajo` | como `redactado` | solo destinos locales (ficheros y `localhost`) |

La privacidad se aplica antes de encolar: lo que no debe salir no toca ni la cola ni el disco.

### Configuración

Variables (mandan sobre el fichero): `NOD_SINKS` (destinos separados por espacios o comas: `http(s)://…` o una
ruta), `NOD_TOKEN`, `NOD_PRIVACY`, `NOD_INSTANCE`, `NOD_TASK`, `NOD_CONFIG`, `NOD_OFF=1`.

Fichero `~/.config/nod/config.json` (o `$XDG_CONFIG_HOME/nod/config.json`), con secciones por perfil:

```json
{
  "sinks": [{ "file": "~/.local/state/nod/events.jsonl" }, { "url": "http://homelab:8787", "token": "…" }],
  "privacy": "completo",
  "profiles": {
    "trycore": { "privacy": "trabajo", "sinks": [{ "file": "~/.local/state/nod/trycore.jsonl" }] }
  }
}
```

Un destino HTTP recibe `POST <url>/v1/events` con lotes de eventos; si no responde, Nod guarda la cola y la
entrega cuando vuelve. Ver [la especificación](docs/nod-v1.md).

## Collector y panel de límites

[`collector/`](collector/README.md) es `nod-collector`, un binario de Rust que recibe los eventos de Nod, los guarda
en SQLite y responde con métricas por tarea. También da el panel de límites de uso para tmux, con o sin
collector en marcha.

```sh
nod-collector serve                    # POST /v1/events, GET /v1/limits, GET /health en 127.0.0.1:8787
nod-collector import ~/.local/state/nod/events.jsonl   # carga lo que ya escribió el destino fichero
nod-collector report --since 7d        # por tarea: tiempos, autonomía, permisos, bucles, tokens, caché, costo
nod-collector limits --format tmux     # 5h 37% ↻2h10 · 7d 12%
```

Con home-manager, `programs.nod.collector.enable = true;` lo deja corriendo (agente de launchd, con el log en
`~/Library/Logs/nod-collector.log`; en Linux, un servicio de systemd de usuario) y escribe `~/.config/nod/config.json` con dos destinos: el fichero
`~/.local/state/nod/events.jsonl` y `http://<listen>`. Si ya tienes un `config.json` propio, pásalo a
`programs.nod.settings`, que manda sobre eso.

Para la barra de tmux (`programs.nod.collector.tmux = true;` pone el binario en el PATH), añade a tu
configuración de tmux:

```tmux
set -g status-interval 15
set -g status-right '#(nod-collector limits --format tmux) %H:%M'
```

Sin collector, que lea directamente el fichero del destino:
`#(nod-collector limits --format tmux --from-file ~/.local/state/nod/events.jsonl)`. Rojo desde el 80 %,
amarillo desde el 50 %; sin datos, la línea queda vacía.

## Quién lo usa

- **Orbit** (las sesiones en el reloj) se alimenta de Nod.
- El [**collector**](#collector-y-panel-de-límites) de este repo guarda los eventos y calcula las métricas por
  tarea.
- Cualquiera que lea Nod v1: el formato no sabe de quién lo consume.

## Cómo está hecho

```
src/core/            el núcleo, sin agente
  normalize.ts       eventos del agente → Nod v1 (deriva quién decidió cada permiso, esperas, ediciones)
  privacy.ts         perfiles de privacidad
  outbox.ts          entrega por destino: cola persistente, lotes, reintentos, aislamiento de rechazos
  engine.ts          NodEngine: une todo sobre una Platform; comandos /nod
  platform.ts        lo que un agente tiene que dar (reloj, HTTP, almacén, ficheros)
src/hosts/claude/    el adaptador de Claude Code (API de mods)
bundle/claude.js     el adaptador empaquetado en un fichero: lo que carga el plugin (versionado)
tools/probe/         sonda de la fase 0: registra todo lo que ve el motor (para validar nombres reales)
nix/                 el módulo de home-manager
collector/           nod-collector (Rust): ingesta, SQLite, report y limits
```

Otro agente (OpenCode, Codex…) es otro adaptador en `src/hosts/<agente>/` sobre el mismo `NodEngine`.

## Desarrollo

```sh
npm ci
npm run build          # tsc + bundle/claude.js
npm test               # vitest; incluye la reproducción de una sesión real (test/fixtures)
npm run check          # que bundle/claude.js corresponde a src/, y los tests (lo que corre el CI)
claude plugin validate .
claude --plugin-dir .  # probar sin instalar
```

`bundle/claude.js` se versiona: tras cambiar `src/`, `npm run build` y commit del bundle.

El collector: `cd collector && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`, y
`nix build .#collector`.

Para ver los eventos crudos de una versión nueva de Claude Code:
`NOD_PROBE_LOG=/tmp/probe.jsonl claude --plugin-dir tools/probe`.

## Licencia

MIT. Ver `LICENSE`.
