#!/bin/sh
# Copia la SPEC, los vectores, los schemas y los fixtures del mod desde un checkout del repo Orbit.
# Uso: scripts/sync-protocol.sh ../Orbit
set -eu
src=${1:?uso: scripts/sync-protocol.sh <ruta del repo Orbit>}/protocol
dst=$(dirname "$0")/../protocol
[ -f "$src/SPEC.md" ] || { echo "no encuentro $src/SPEC.md" >&2; exit 1; }
rm -rf "$dst/vectors" "$dst/schema" "$dst/fixtures"
mkdir -p "$dst/fixtures/raw"
cp -R "$src/vectors" "$src/schema" "$dst/"
cp -R "$src/fixtures/raw/mod" "$dst/fixtures/raw/"
cp "$src/SPEC.md" "$dst/SPEC.md"
echo "protocolo copiado de $src"
