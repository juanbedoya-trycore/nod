# Extender Nod

Nod tiene tres puntos de extensión estables. Ninguno obliga a tocar el mod: se construyen fuera, contra un
contrato versionado.

| Quiero… | Punto de extensión | Contrato | Ejemplos |
| --- | --- | --- | --- |
| hacer algo con lo que pasa en las sesiones (métricas, paneles, alertas, un índice) | **consumidor** de eventos | [Nod v1](nod-v1.md) | `collector/` (métricas y límites), la fuente `nod` de chrono, el servidor de Orbit |
| decidir permisos o hablar con la sesión desde otro sitio | **aprobador** / **controlador** | [Nod Control v1](control-v1.md) | el reloj de Orbit (aprobador) y su servidor (controlador) |
| que Nod funcione en otro agente de código | **adaptador** | `src/core/platform.ts` + `NodEngine` | `src/hosts/claude/`, `src/hosts/opencode/` |

## 1. Un consumidor

1. Elige cómo recibir: lee el fichero (`~/.local/state/nod/events.jsonl`, una línea por sobre) o sirve
   `POST /v1/events` y añade tu URL a `sinks` en `~/.config/nod/config.json`.
2. Valida con [`schema/nod-v1.schema.json`](../schema/nod-v1.schema.json) e **ignora lo que no conozcas**: los tipos
   y campos opcionales nuevos no cambian la versión.
3. Deduplica por (`source.instance`, `source.run`, `seq`) y respeta `source.privacy`: un evento `redactado` no
   trae texto, y los identificadores llegan como hash.
4. Para métricas, sigue las reglas de [§3.1](nod-v1.md#31-reglas-de-derivación) (tokens = Σ `turn.step.usage`;
   espera humana = Σ `wait_ms` con `by` `user`/`remote`; `exact`).

Fixtures reales para tus tests: `test/fixtures/nod-v1-sesion-real.jsonl` y `test/fixtures/nod-v1-commit-real.jsonl`.

## 2. Un aprobador o un controlador

Implementa la API de [control-v1.md §4](control-v1.md#4-api-del-controlador) (controlador) o firma con P-256 las
entradas de [§3](control-v1.md#3-criptografía) (aprobador). Compruébalo contra `vectors/control/`: cada caso dice
qué debe aceptar o rechazar Nod y por qué. El controlador nunca es de confianza: todo lo que importa va firmado
por el aprobador sobre datos que genera Nod.

## 3. Un adaptador para otro agente

1. Crea `src/hosts/<agente>/` y construye una `Platform` (`src/core/platform.ts`) con lo que te dé el agente: reloj,
   HTTP, almacén, ficheros y entropía.
2. Traduce sus eventos a los métodos de `NodEngine` (sesión, prompt, turno, paso, tool, permiso, subagente, fin).
   Lo que el agente no dé, se omite; no se inventa.
3. Antes de escribir el adaptador, captura una sesión real con una sonda (como `tools/probe` para Claude) y
   guárdala anonimizada como fixture; el test de reproducción (`test/claude-replay.test.ts`) es el modelo.
4. Añade su entrada a `scripts/bundle.mjs` y su instalación al módulo de Nix.

## Lo que no hay (todavía)

Una API para que **otro mod** se enganche a Nod dentro del mismo proceso (la idea de `$.ctel` del plan
original). La API de mods de Claude Code 2.1.296 no ofrece una forma comprobada de que un mod exponga funciones a
otro, y cargar código ajeno dentro de Nod rompería su garantía de no retrasar ni romper la sesión. Mientras tanto,
cualquier extensión cabe en los tres puntos de arriba, que funcionan fuera del proceso del agente.
