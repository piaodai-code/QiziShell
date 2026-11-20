#!/usr/bin/env bash
# Packs keepalive-server/ into one archive to copy onto the OpenClaw host.
# The server posts to the Maintainer through the shell's Hermes client, so that
# client travels with it in vendor/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./keepalive-server/package.json').version")"
NAME="qizi-keepalive-server"
OUT="${ROOT}/dist/${NAME}-${VERSION}.tgz"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "${STAGE}/${NAME}/vendor" "${ROOT}/dist"
cp keepalive-server/package.json keepalive-server/package-lock.json keepalive-server/server.js \
  keepalive-server/shell.js keepalive-server/shell-icon.png \
  keepalive-server/服务端安装.md keepalive-server/保活维护.md keepalive-server/日常发布.md "${STAGE}/${NAME}/"
cp -R keepalive-server/lib "${STAGE}/${NAME}/lib"
cp hermes-client.js tls-policy.js "${STAGE}/${NAME}/vendor/"

tar -czf "$OUT" -C "$STAGE" "$NAME"

# The installed app copies this bundle out when the user downloads the server program.
BUNDLE="${ROOT}/keepalive-bundle"
mkdir -p "$BUNDLE"
cp "$OUT" "${BUNDLE}/qizi-keepalive-server.tgz"
printf '%s\n' "$VERSION" > "${BUNDLE}/version"

cat <<EOF
Packed ${OUT}
App bundle ${BUNDLE}/qizi-keepalive-server.tgz

On the server (needs Node 18+ and Google Chrome):
  tar -xzf ${NAME}-${VERSION}.tgz
  cd ${NAME}
  npm install --omit=dev
  node server.js
EOF
