# Golden vectors de Orbit 0.2.0

Generado por `protocol/tools/gen-vectors.mjs`. No editar a mano. Regenerar: `node protocol/tools/gen-vectors.mjs`. Verificar: `node protocol/tools/gen-vectors.mjs --check`.

Cada vector tiene:
- `<nombre>.json`: forma lógica legible (bytes como `{"$hex": ...}`).
- `<nombre>.cbor`: bytes CBOR deterministas (RFC 8949 §4.2.1), codificados con cbor2 1.12.0 `cde` (SPEC §7).
- `<nombre>.hex`: los mismos bytes en hexadecimal minúscula.

Los negativos (`expect: reject`) solo tienen `.json`, `.cbor` y `.hex`. Un decodificador debe rechazarlos. Los de tipo `noncanonical` los rechaza también cbor2 con `cdeDecodeOptions`. Los de tipo `forbidden-type` son canónicos, pero 0.2.0 prohíbe ese tipo.

La ingesta (`ingest-evento-crudo`) es JSON en 0.2.0 (SPEC §1, §3), así que solo tiene `.json`.

| Vector | Tipo | Spec | Esperado | Bytes CBOR | Ficheros | Nota |
| --- | --- | --- | --- | --- | --- | --- |
| frame-hello | frame | §5.1 | aceptar | 15 | frame-hello.json, frame-hello.cbor, frame-hello.hex | hello al conectar: versión, epoch 3, seq 0 (ningún delta enviado todavía). |
| frame-req-snap | frame | §5.1, §5.3 | aceptar | 13 | frame-req-snap.json, frame-req-snap.cbor, frame-req-snap.hex | El reloj pide snap desde last_seq 41 en epoch 3. |
| frame-delta-add | frame | §5.1, §5.2 | aceptar | 30 | frame-delta-add.json, frame-delta-add.cbor, frame-delta-add.hex | Delta con una sola op add (tarea Bash bajo la sesión 7). |
| frame-delta-lote | frame | §5.4 | aceptar | 80 | frame-delta-lote.json, frame-delta-lote.cbor, frame-delta-lote.hex | Lote de 5 ops en una ventana: add, st, add con mcp, rm en cascada y meta. |
| frame-delta-snap-vacio | frame | §5.5, §10 | aceptar | 18 | frame-delta-snap-vacio.json, frame-delta-snap-vacio.cbor, frame-delta-snap-vacio.hex | Snap vacío: el servidor no tiene nodos vivos. Única op de la trama. |
| frame-delta-snap | frame | §5.5 | aceptar | 128 | frame-delta-snap.json, frame-delta-snap.cbor, frame-delta-snap.hex | Snap con 4 nodos ordenados por id ascendente (el padre antes que el hijo). Única op de la trama. |
| frame-delta-salto-seq | frame | §5.3 | aceptar | 22 | frame-delta-salto-seq.json, frame-delta-salto-seq.cbor, frame-delta-salto-seq.hex | Salto de seq: el cliente tenía last_seq 10 y recibe seq 12. Debe descartarla, dejar de aplicar y pedir snap con req. Sin seq 11 no hay forma de aplicarla. |
| frame-delta-ids-limite | frame | §2, §10 | aceptar | 48 | frame-delta-ids-limite.json, frame-delta-ids-limite.cbor, frame-delta-ids-limite.hex | Límites: epoch 2^32-1, seq 2^53-1 y id 2^32-1. Cada entero ocupa 5 u 9 bytes CBOR. |
| frame-delta-tamanos-id | frame | §2, §5.2 | aceptar | 145 | frame-delta-tamanos-id.json, frame-delta-tamanos-id.cbor, frame-delta-tamanos-id.hex | Ids que cambian la longitud del entero CBOR: 23 (1 B), 24 (2 B), 255, 256 (3 B), 65535, 65536 (5 B), 4294967295 (5 B). |
| frame-perm | frame | §6.2 | aceptar | 104 | frame-perm.json, frame-perm.cbor, frame-perm.hex | Solicitud de permiso con nonce de 16 bytes, wok=true e instance_id (9.º elemento, 0.2). Los tiempos son segundos Unix. Su ph está en perm-hash-entrada. |
| frame-perm-nunca-desde-reloj | frame | §6.4 | aceptar | 94 | frame-perm-nunca-desde-reloj.json, frame-perm-nunca-desde-reloj.cbor, frame-perm-nunca-desde-reloj.hex | Permiso de un comando prohibido (rm -rf): wok=false, el reloj solo puede denegar. |
| frame-pclose | frame | §6.2, §6.5 | aceptar | 40 | frame-pclose.json, frame-pclose.cbor, frame-pclose.hex | El terminal ganó la carrera con allow. |
| frame-dec | frame | §6.2, §6.3 | aceptar | 174 | frame-dec.json, frame-dec.cbor, frame-dec.hex | Decisión firmada del reloj: allow con kid de prueba, firma de prueba fija (no verificable criptográficamente) y el ph de frame-perm (8.º elemento, 0.2). |
| frame-text | frame | §8 | aceptar | 56 | frame-text.json, frame-text.cbor, frame-text.hex | Respuesta de GET /v0/text con comando en unicode (UTF-8 multibyte). Sin truncar, sin redacción. |
| frame-delta-label-truncada | frame | §2, §10 | aceptar | 59 | frame-delta-label-truncada.json, frame-delta-label-truncada.cbor, frame-delta-label-truncada.hex | Etiqueta multibyte cortada a <= 32 bytes en frontera de code point. |
| frame-add-mcp-nulo | frame | §4.1, §10 | aceptar | 30 | frame-add-mcp-nulo.json, frame-add-mcp-nulo.cbor, frame-add-mcp-nulo.hex | Tarea sin MCP en forma corta (5 elementos; m implícito 0). Ver INDEX: el emisor usa la forma corta. |
| node-session | node | §4.1, §5.5 | aceptar | 27 | node-session.json, node-session.cbor, node-session.hex | Nodo de sesión (p=0). En snap, m=0. |
| node-mcp | node | §4.2 | aceptar | 22 | node-mcp.json, node-mcp.cbor, node-mcp.hex | Nodo mcp de servidor "echo" bajo la sesión 7. |
| node-task-mcp | node | §4.1 | aceptar | 25 | node-task-mcp.json, node-task-mcp.cbor, node-task-mcp.hex | Tarea MCP con m=9 (id del nodo mcp). |
| node-task-mcp-nulo | node | §4.1, §10 | aceptar | 25 | node-task-mcp-nulo.json, node-task-mcp-nulo.cbor, node-task-mcp-nulo.hex | Tarea sin MCP: m=0 explícito. |
| op-snap-vacio | op | §5.2, §5.5 | aceptar | 7 | op-snap-vacio.json, op-snap-vacio.cbor, op-snap-vacio.hex | Snap del grafo vacío. |
| op-snap | op | §5.2 | aceptar | 59 | op-snap.json, op-snap.cbor, op-snap.hex | Snap con un nodo session y un task con mcp. |
| op-add | op | §5.2 | aceptar | 18 | op-add.json, op-add.cbor, op-add.hex | add sin m (5 elementos). Estado inicial run. |
| op-add-mcp | op | §5.2 | aceptar | 19 | op-add-mcp.json, op-add-mcp.cbor, op-add-mcp.hex | add con m=9 (6 elementos). |
| op-add-mcp-nulo | op | §5.2, §10 | aceptar | 18 | op-add-mcp-nulo.json, op-add-mcp-nulo.cbor, op-add-mcp-nulo.hex | add sin MCP en forma corta (5 elementos). Equivale a m=0. |
| neg-add-mcp-cero-explicito | negative | §5.2, §10 | rechazar (schema) | 19 | neg-add-mcp-cero-explicito.json, neg-add-mcp-cero-explicito.cbor, neg-add-mcp-cero-explicito.hex | add con m=0 explícito (6 elementos). El schema normativo (opAdd) exige m >= 1; la forma sin MCP es la de 5 elementos (op-add-mcp-nulo). Pendiente de confirmar en P1. |
| op-st | op | §5.2 | aceptar | 11 | op-st.json, op-st.cbor, op-st.hex | Cambio de estado a perm. |
| op-rm | op | §5.2, §4.4 | aceptar | 6 | op-rm.json, op-rm.cbor, op-rm.hex | rm en cascada del nodo 30. |
| op-meta | op | §5.2, §5.4 | aceptar | 14 | op-meta.json, op-meta.cbor, op-meta.hex | Totales acumulados de la sesión corta 7. |
| op-meta-limites | op | §2, §5.2 | aceptar | 26 | op-meta-limites.json, op-meta-limites.cbor, op-meta-limites.hex | Totales en el límite: in_tok 2^53-1 y turns 2^32-1. |
| op-stuck-bucle | op | §4.5 (0.2.3) | aceptar | 24 | op-stuck-bucle.json, op-stuck-bucle.cbor, op-stuck-bucle.hex | La sesión 7 repite Bash con la misma entrada: 6 veces seguidas desde 1791683940. |
| op-stuck-inactiva | op | §4.5 (0.2.3) | aceptar | 24 | op-stuck-inactiva.json, op-stuck-inactiva.cbor, op-stuck-inactiva.hex | La sesión 7 lleva sin eventos desde 1791683940 con una tarea Bash abierta (n=0). |
| op-stuck-ninguno | op | §4.5 (0.2.3) | aceptar | 16 | op-stuck-ninguno.json, op-stuck-ninguno.cbor, op-stuck-ninguno.hex | La sesión 7 ya no está atascada: since 0, k vacía, n 0. |
| label-cortada-emoji | op | §2, §10 | aceptar | 46 | label-cortada-emoji.json, label-cortada-emoji.cbor, label-cortada-emoji.hex | Entrada de 35 bytes (31 'a', un emoji de 4 bytes, 'bbb'). Resultado: 31 'a' (el emoji no cabe en 32). |
| label-multibyte | op | §2 | aceptar | 47 | label-multibyte.json, label-multibyte.cbor, label-multibyte.hex | Etiqueta unicode cortada a <= 32 bytes. Entrada original: "Ñandú 日本語 análisis de sesión larga con ñ y emoji 🚀". |
| perm-hash-entrada | perm-hash | §6.3, §7 | aceptar | 109 | perm-hash-entrada.json, perm-hash-entrada.cbor, perm-hash-entrada.hex | Entrada de ph (formato de firma 2): CBOR determinista de ["orbit-perm", 1, instance_id, nonce, tool_use_id, tool, sum, wok, exp] con los campos de frame-perm. ph = SHA-256 de estos bytes (campo ph). |
| dec-entrada-firmada | signing | §6.3, §7 | aceptar | 106 | dec-entrada-firmada.json, dec-entrada-firmada.cbor, dec-entrada-firmada.hex | Entrada firmada (formato de firma 2): CBOR determinista de ["orbit-dec", 2, nonce, tool_use_id, decision, ts, ph], con el ph de perm-hash-entrada. La firma se hace sobre estos bytes. |
| ingest-evento-crudo | ingest | §3.1, §3.3 | aceptar | — | ingest-evento-crudo.json | Sobre de ingesta JSON (src=mod, ctx=personal) con un evento PreToolUse. La ingesta es JSON en 0.2.0: no tiene .cbor. |
| neg-entero-no-minimo | negative | §7 | rechazar (noncanonical) | 6 | neg-entero-no-minimo.json, neg-entero-no-minimo.cbor, neg-entero-no-minimo.hex | Entero 5 codificado con 2 bytes (0x18 0x05) en vez de 1 byte. Debe rechazarse: no es el encoding más corto. |
| neg-array-indefinido | negative | §7 | rechazar (noncanonical) | 6 | neg-array-indefinido.json, neg-array-indefinido.cbor, neg-array-indefinido.hex | Array de longitud indefinida (0x9f ... 0xff). Solo se permiten longitudes definidas. |
| neg-mapa | negative | §7 | rechazar (forbidden-type) | 4 | neg-mapa.json, neg-mapa.cbor, neg-mapa.hex | Mapa {"a":1}. En 0.2.0 no se usan mapas. El bytestring es canónico; la regla es estructural. |
| neg-float | negative | §7 | rechazar (forbidden-type) | 9 | neg-float.json, neg-float.cbor, neg-float.hex | Float64 1.5. En 0.2.0 no hay floats. Canónico; la regla es estructural. |
| neg-null | negative | §7 | rechazar (forbidden-type) | 1 | neg-null.json, neg-null.cbor, neg-null.hex | null (0xf6). En 0.2.0 no se usa null. Canónico; la regla es estructural. |
| neg-tag | negative | §7 | rechazar (forbidden-type) | 2 | neg-tag.json, neg-tag.cbor, neg-tag.hex | Tag 1 (0xc1). En 0.2.0 no se usan tags. Canónico; la regla es estructural. |

Total: 44 vectores.
