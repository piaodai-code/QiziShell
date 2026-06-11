#!/usr/bin/env bash
# 本地打包并上传到 GitHub Releases（可选；推荐用 GitHub Actions 自动发版）。
#
# 自动发版（推荐）：
#   1. 修改 package.json 的 version
#   2. git commit && git push
#   3. git tag v0.1.4 && git push origin v0.1.4
#   → Actions 会自动 build 并上传到 Releases
#
# 本地手动上传（需 gh）：
#   brew install gh && gh auth login
#   npm run release
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v gh >/dev/null 2>&1; then
  echo "未找到 gh。请先安装 GitHub CLI：" >&2
  echo "  brew install gh" >&2
  echo "  gh auth login" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI 未登录。请运行： gh auth login" >&2
  exit 1
fi

echo "==> 打包 QiziShell…"
npm run build

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"
DMG="${ROOT}/dist/QiziShell-${VERSION}-arm64.dmg"

if [[ ! -f "$DMG" ]]; then
  echo "未找到安装包: ${DMG}" >&2
  exit 1
fi

NOTES_FILE="$(mktemp)"
trap 'rm -f "$NOTES_FILE"' EXIT
cat >"$NOTES_FILE" <<EOF
Apple Silicon (arm64) macOS 安装包。

- 下载 \`QiziShell-${VERSION}-arm64.dmg\`，打开后将 QiziShell 拖入「应用程序」。
- 若提示无法验证开发者，请在「系统设置 → 隐私与安全性」中允许打开。
- 本地语音识别需 Apple Silicon Mac。
EOF

echo "==> 上传到 GitHub Release ${TAG}…"

if gh release view "$TAG" >/dev/null 2>&1; then
  gh release upload "$TAG" "$DMG" --clobber
  echo "已更新 Release ${TAG} 中的 DMG。"
else
  gh release create "$TAG" "$DMG" \
    --title "QiziShell ${VERSION}" \
    --notes-file "$NOTES_FILE"
  echo "已创建 Release ${TAG}。"
fi

RELEASE_URL="$(gh release view "$TAG" --json url -q .url)"
echo "下载页: ${RELEASE_URL}"
