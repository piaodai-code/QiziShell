#!/usr/bin/env bash
# 一键发版：commit → push main → 本地打包 → 打 tag → 上传 Release
#
#   npm run ship              # 用 package.json 现有版本
#   npm run ship -- 0.1.4     # 先改版本再发
#   npm run ship -- 0.1.4 -m "Add foo feature"
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

usage() {
  cat <<'EOF'
Usage: npm run ship [-- NEW_VERSION] [-m "commit message"]

  NEW_VERSION  可选，发版前写入 package.json（如 0.1.4）
  -m "msg"     可选，提交说明（默认 Release vX.Y.Z）

会依次执行：
  1. 提交并 push 到 main
  2. npm run build（本地 dist/QiziShell-*-arm64.dmg）
  3. git tag vX.Y.Z && push tag（触发 GitHub Actions 上传）
  4. 若已安装 gh 且已登录，立即上传到 GitHub Release
EOF
}

NEW_VERSION=""
COMMIT_MSG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--message)
      COMMIT_MSG="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$NEW_VERSION" && "$1" != "" ]]; then
        NEW_VERSION="$1"
      elif [[ -n "$NEW_VERSION" ]]; then
        echo "未知参数: $1" >&2
        usage
        exit 1
      fi
      shift
      ;;
  esac
done

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "错误：请在 main 分支执行（当前: ${BRANCH}）" >&2
  exit 1
fi

if [[ -n "$NEW_VERSION" ]]; then
  node -e "
    const fs = require('fs');
    const p = require('./package.json');
    p.version = process.argv[1];
    fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
  " "$NEW_VERSION"
  echo "==> 版本已设为 ${NEW_VERSION}"
fi

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"
[[ -z "$COMMIT_MSG" ]] && COMMIT_MSG="Release ${TAG}"

if ! git diff --quiet || ! git diff --cached --quiet; then
  UNTRACKED="$(git ls-files --others --exclude-standard | wc -l | tr -d ' ')"
  if [[ "$UNTRACKED" != "0" ]]; then
    echo "提示：有 ${UNTRACKED} 个未跟踪文件不会纳入本次提交（需先 git add）"
  fi
  git add -u
  git add package.json 2>/dev/null || true
  git commit -m "$COMMIT_MSG"
  echo "==> 已提交"
elif [[ -n "$NEW_VERSION" ]]; then
  git add package.json
  git commit -m "$COMMIT_MSG"
  echo "==> 已提交版本号"
else
  echo "==> 工作区干净，跳过提交"
fi

echo "==> Push main"
git push origin main

echo "==> 本地打包"
# 若 DMG 仍挂载会导致 hdiutil 失败，先卸载
while IFS= read -r vol; do
  [[ -n "$vol" ]] && hdiutil detach "$vol" -force 2>/dev/null || true
done < <(hdiutil info 2>/dev/null | awk '/\/Volumes\/QiziShell/ {print $NF}')

npm run build

DMG="${ROOT}/dist/QiziShell-${VERSION}-arm64.dmg"
if [[ ! -f "$DMG" ]]; then
  echo "打包失败，未找到: ${DMG}" >&2
  exit 1
fi
echo "本地安装包: ${DMG}"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  git tag -f "$TAG"
  echo "==> 更新本地 tag ${TAG}"
else
  git tag "$TAG"
  echo "==> 创建 tag ${TAG}"
fi

echo "==> Push tag ${TAG}"
git push origin "$TAG" --force

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  echo "==> 上传到 GitHub Release（gh）"
  NOTES_FILE="$(mktemp)"
  trap 'rm -f "$NOTES_FILE"' EXIT
  cat >"$NOTES_FILE" <<EOF
Apple Silicon (arm64) macOS 安装包。

- 下载 \`QiziShell-${VERSION}-arm64.dmg\`，打开后将 QiziShell 拖入「应用程序」。
- 若提示无法验证开发者，请在「系统设置 → 隐私与安全性」中允许打开。
- 本地语音识别需 Apple Silicon Mac。
EOF
  if gh release view "$TAG" >/dev/null 2>&1; then
    gh release upload "$TAG" "$DMG" --clobber
  else
    gh release create "$TAG" "$DMG" \
      --title "QiziShell ${VERSION}" \
      --notes-file "$NOTES_FILE"
  fi
  RELEASE_URL="$(gh release view "$TAG" --json url -q .url)"
  echo "Release: ${RELEASE_URL}"
else
  echo "==> 未检测到 gh，Release 由 GitHub Actions 在 push tag 后自动上传"
  echo "    https://github.com/piaodai-code/QiziShell/actions"
fi

echo ""
echo "完成 ${TAG} · 本地 DMG 已就绪"
