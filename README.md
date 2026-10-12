# Nod

Aprueba los permisos de Claude Code desde el reloj. Nod es el plugin que lleva tus sesiones de Claude Code
al reloj y hace que cada permiso espere tu ✓ o ✕ en la muñeca, sin volver al ordenador.

Funciona con **Orbit** (el servidor en el Mac y las apps del teléfono y el reloj; el servidor lo instala
`tools/install/install-mac.sh` del repo Orbit). Sin servidor Nod no hace nada y `/nod` te dice cómo instalarlo.

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

Abre una sesión nueva y escribe `/nod`: debe decir `conectado`.

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
instala en los perfiles nuevos en cuanto aparecen. Si encuentra una versión anterior del mod (`orbit@orbit-local`
o `orbit@orbit`), la quita: con dos, cada evento saldría dos veces. A mano: `nod-sync` (`--force` reinstala).

| Opción | Por defecto | Qué hace |
| --- | --- | --- |
| `programs.nod.claude` | `~/.local/bin/claude` | El binario con el que se instala el plugin |
| `programs.nod.profiles` | `[]` (todos) | Lista fija de directorios de configuración de Claude Code |
| `programs.nod.watchProfiles` | `true` en macOS | Instalar también en los perfiles de ws que se creen después |

## Qué hace

Cada evento de la sesión (inicio, turnos, subagentes, tools, fin) va por lotes al servidor de Orbit, que lo
reenvía al teléfono y al reloj. Cuando Claude Code te pide permiso, Nod lo retiene 20 s (90 s con
`/nod away`) para que decidas en el reloj; si no contestas, la pregunta sale en el terminal como siempre.
Las decisiones van firmadas por una llave que solo tiene el reloj. Cualquier fallo de Nod deja la sesión
como si no estuviera.

| Comando | Para |
| --- | --- |
| `/nod` | Estado: conexión, cola, privacidad y llaves del reloj |
| `/nod setup` | QR para configurar el teléfono |
| `/nod away` / `/nod back` | 90 s / 20 s para decidir en el reloj |
| `/nod privacidad metadatos` / `completa` | En este perfil, solo estructura o todo |
| `/nod respuestas …` | Respuestas rápidas del reloj |
| `/nod pause` / `/nod resume` | Dejar de enviar y reanudar |
| `/nod pair keys` / `/nod unpair <huella>` | Ver o revocar las llaves del reloj |

Variables (`ORBIT_URL`, `ORBIT_TOKEN`, `ORBIT_PERM_HOLD_MS`…): `docs/install-mod.md` del repo Orbit.

## Cómo está hecho

```
src/core/           el núcleo, sin agente: traducción de eventos, cola, envío, retención de permisos,
                    respuestas del reloj y emparejamiento. engine.ts los une sobre una Platform.
src/core/platform.ts  lo que un agente tiene que dar: reloj, HTTP, almacén, ficheros, registro…
src/hosts/claude/   el adaptador de Claude Code (API de mods): eventos del motor → NodEngine
src/protocol/       CBOR y tipos del protocolo (SPEC en protocol/SPEC.md)
bundle/claude.js    el adaptador empaquetado en un fichero: lo que carga el plugin (versionado)
nix/                el módulo de home-manager
protocol/           copia de la SPEC, vectores y schemas del repo Orbit (para los tests)
```

Otro agente (OpenCode, Codex…) es otro adaptador en `src/hosts/<agente>/` sobre el mismo `NodEngine`.

## Desarrollo

```sh
npm ci
npm run build          # tsc + bundle/claude.js
npm test               # vitest
npm run check          # que bundle/claude.js corresponde a src/, y los tests (lo que corre el CI)
claude plugin validate .
claude --plugin-dir .  # probar sin instalar
```

`bundle/claude.js` se versiona: tras cambiar `src/`, `npm run build` y commit del bundle. Los vectores de
`protocol/` vienen del repo Orbit: `scripts/sync-protocol.sh ../Orbit` los actualiza.

## Licencia

MIT. Ver `LICENSE`.
