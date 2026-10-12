# Nod

Nod observa tus sesiones de Claude Code y de OpenCode y te da información de verdad sobre ellas: cuánto trabajó el agente,
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
| `programs.nod.opencode.enable` | `false` | Enlaza el plugin de OpenCode en `~/.config/opencode/plugins/nod.js` (no necesita `programs.nod.enable`) |
| `programs.nod.opencode.pluginDir` | `opencode/plugins` | Su carpeta de plugins, relativa a `~/.config` (si usas `OPENCODE_CONFIG_DIR`) |

### En OpenCode

OpenCode (1.18 o más reciente) carga al arrancar los plugins de `~/.config/opencode/plugins/` (los de todos los
proyectos) y de `<proyecto>/.opencode/plugins/` (solo ese). El plugin es un fichero, `bundle/opencode.js`:

```sh
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://raw.githubusercontent.com/juan52878911/nod/main/bundle/opencode.js -o ~/.config/opencode/plugins/nod.js
```

o, desde un clon, `cp bundle/opencode.js ~/.config/opencode/plugins/nod.js`. Con Nix,
`programs.nod.opencode.enable = true` lo enlaza en cada `switch`. La configuración (`NOD_*`,
`~/.config/nod/config.json`), la privacidad y Nod Control son los mismos; `source.host` es `opencode` y el
perfil, el nombre del directorio de `OPENCODE_CONFIG_DIR` (o `opencode`). La cola y el resto del estado van en
`~/.local/state/nod/opencode/<perfil>/`.

Lo que cambia respecto de Claude Code, por lo que da la API de plugins de OpenCode:

- **`/nod`**: un plugin de OpenCode no puede contestar un comando sin pasar por el modelo. Nod registra el
  comando `/nod` y sustituye su prompt por la respuesta, con la orden de mostrarla tal cual: gasta una llamada
  corta al modelo y cuenta como un prompt con `origin: "command"`.
- **Permisos**: la espera es exacta también al aprobar (OpenCode publica cada respuesta). Lo que resuelven las
  reglas `allow`/`deny` sin preguntar no se ve (OpenCode 1.18 no llama al hook `permission.ask`). En
  `opencode run`, que rechaza solo lo que pregunta (o lo aprueba con `--auto`), sale como `by: "policy"`.
- **Nod Control** funciona: mientras la TUI pregunta, un aprobador emparejado puede decidir y Nod contesta el
  permiso por la API de OpenCode; gana lo primero que llegue, el humano o el aprobador. No hay modo auto.
- **No hay**: edición del prompt (`recalled`, `revised`, `typing_ms`), límites de uso (`usage.limits`) ni
  esfuerzo del modelo. `usage.cost_usd` es la suma del costo de los pasos vistos en el proceso.
- **Subagentes**: los de la tool `task`, que en OpenCode son sesiones hijas; su `agent` es el id de esa sesión.
- **Fin de sesión**: al salir de la TUI o al acabar `opencode run`. Un `opencode serve` que se mata con una
  señal no avisa: lo que quede en la cola sale en la siguiente sesión.

## Qué mide

| Pregunta | De dónde sale |
| --- | --- |
| ¿Cuánto trabajó el agente y cuánto esperó por mí? | `turn.end.duration_ms`, `permission.decision.wait_ms` con `by: "user"` |
| ¿Qué permisos negué, de qué tools? | `permission.decision` (`deny`, `user`) y `tool.result.rejected` |
| ¿Cuántos turnos hace el agente por cada prompt mío? | `prompt.submit` con `origin: "composer"` frente a `turn.step` |
| ¿Interrumpí o reescribí? | `turn.end.outcome = "aborted"`, `prompt.submit.edit` (`revised`, `recalled`, `typing_ms`) |
| ¿Cuántos tokens y cuánta caché por tarea? | Σ `turn.step.usage` (incluye subagentes; `turn.end` y `agent.end` son agregados, no se suman), agrupado por `task` |
| ¿Qué commits salieron de cada tarea? | `vcs.commit` (sha, rama), con la tarea deducida de la rama o de `/nod tarea` |
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

Para no dejar el token en la configuración, un destino HTTP admite `"token_file": "~/.config/nod/collector.token"`
en lugar de `"token"`: Nod lo lee al arrancar.

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

## Aprobar desde fuera: Nod Control

Opcional. Con un **controlador** (un servidor que hace de buzón, p. ej. el de Orbit) y un **aprobador** emparejado
(el móvil, el reloj), un permiso que Claude Code te iba a preguntar en el terminal espera unos segundos a que lo
apruebes o lo niegues desde fuera, y el aprobador puede mandarle mensajes a la sesión. Sin configurarlo, Nod no
retiene ni cambia ninguna decisión. Especificación: [docs/control-v1.md](docs/control-v1.md).

```json
{ "control": { "url": "http://127.0.0.1:7878", "token_file": "~/.config/nod/control.token", "hold_ms": 20000 } }
```

`url` sin barra final; `token` o, mejor, `token_file` (el token no debe ir en un fichero versionado); `hold_ms`,
cuánto espera un permiso (1000…90000, 20000 por defecto). Variables: `NOD_CONTROL` (la URL, u `off` para apagarlo)
y `NOD_CONTROL_TOKEN`. Admite secciones por perfil como el resto.

| Comando | Para |
| --- | --- |
| `/nod emparejar` | Muestra un QR para el aprobador y espera su oferta 2 min (barra de estado). El QR vale 15 min y una sola vez |
| `/nod aprobadores` | Llaves emparejadas (de toda la máquina, en `~/.local/state/nod/approvers.json`) |
| `/nod aprobadores quitar <kid>` | Revoca una: deja de contar desde la siguiente decisión |
| `/nod lejos` / `/nod cerca` | Los permisos esperan 90 s o `hold_ms` (toda la máquina, `away.json`) |
| `/nod` | Además del resto: controlador, aprobadores, retención y el último permiso retenido |

Cómo funciona:

- Solo se retiene si el canal está activo, hay al menos un aprobador emparejado y la sesión no está en *auto
  mode* (lo que pregunta lo decide después el clasificador). El modo sale del hook `UserPromptSubmit` o, si la
  política de plugins no lo deja llegar, de la transcripción de la sesión; si no se sabe, se retiene.
- Gana lo primero que llegue: una decisión firmada por un aprobador emparejado, el plazo o tu Esc. Si gana la
  decisión, Claude Code la aplica sin preguntar (y sale `permission.decision` con `by: "remote"`); si no, el
  terminal pregunta como siempre.
- El controlador no es de confianza: Nod comprueba cada firma (P-256) sobre los datos que él mismo generó (qué
  tool, qué resumen, hasta cuándo), así que el controlador no puede aprobar nada ni cambiar lo que viste.
  Con el controlador caído o colgado, Nod suelta el permiso al terminal en 3 s como mucho.
- Lo que nunca se aprueba desde fuera (solo se puede negar): `rm -rf`, `git push --force`, despliegues
  (`kubectl apply`, `terraform apply`, `npm publish`…) y lo que añadas en `NOD_FORBIDDEN_ADD` (array JSON de
  regex). Tampoco un comando cuyo resumen no sea completo (cortado, con secretos ocultos o caracteres invisibles):
  no se aprueba lo que no se ha visto entero.
- Lo que ve el aprobador: con privacidad `completo`, el comando o la ruta (con los secretos ocultos); con
  `redactado` o `trabajo`, solo el verbo (`npm`, `git`). Con `trabajo`, el canal solo funciona con un
  controlador local.
- Mensajes: un texto con el agente libre entra como prompt; a mitad de turno se le pasa al modelo con el
  siguiente resultado de tool (y, si el turno acaba antes, como prompt). «Detente» corta el turno; «Detente y
  resume» lo corta y pide un resumen.

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
  platform.ts        lo que un agente tiene que dar (reloj, HTTP, almacén, ficheros, entropía)
  control/           Nod Control: firmas y CBOR, verificación, retención, mensajes, emparejamiento
src/hosts/claude/    el adaptador de Claude Code (API de mods)
src/hosts/opencode/  el adaptador de OpenCode (API de plugins): adapter.ts traduce, node.ts es su Platform
bundle/claude.js     el adaptador de Claude empaquetado en un fichero: lo que carga el plugin (versionado)
bundle/opencode.js   el de OpenCode: lo que se copia a su carpeta de plugins (versionado)
tools/probe/         sonda de la fase 0: registra todo lo que ve el motor (para validar nombres reales)
tools/probe-opencode/ la misma sonda para OpenCode, y el script que anonimiza sus capturas
nix/                 el módulo de home-manager
collector/           nod-collector (Rust): ingesta, SQLite, report y limits
```

Otro agente (Codex…) es otro adaptador en `src/hosts/<agente>/` sobre el mismo `NodEngine`.

## Desarrollo

```sh
npm ci
npm run build          # tsc + bundle/claude.js y bundle/opencode.js
npm test               # vitest; incluye la reproducción de sesiones reales de los dos agentes (test/fixtures)
npm run check          # que los bundles corresponden a src/, y los tests (lo que corre el CI)
claude plugin validate .
claude --plugin-dir .  # probar sin instalar
```

Los bundles se versionan: tras cambiar `src/`, `npm run build` y commit de los dos.

El collector: `cd collector && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`, y
`nix build .#collector`.

Para ver los eventos crudos de una versión nueva de Claude Code:
`NOD_PROBE_LOG=/tmp/probe.jsonl claude --plugin-dir tools/probe`. De OpenCode: copia
`tools/probe-opencode/probe.ts` a `<proyecto>/.opencode/plugins/` y lanza `NOD_PROBE_LOG=/tmp/probe.jsonl
opencode`; `node tools/probe-opencode/anonimiza.mjs /tmp/probe.jsonl <proyecto>` deja la captura lista para
`test/fixtures` (quita, entre otras cosas, la clave del proveedor que lleva `chat.params`).

## Licencia

MIT. Ver `LICENSE`.
