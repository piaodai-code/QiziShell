const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');

const GITHUB_REPO = 'piaodai-code/QiziShell';
const GITHUB_RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=30`;
const USER_AGENT = 'QiziShell-Updater';

function parseVersion(raw) {
  const cleaned = String(raw || '').replace(/^v/i, '').trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(cleaned);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || '',
    label: cleaned,
  };
}

function compareVersions(currentRaw, latestRaw) {
  const current = parseVersion(currentRaw);
  const latest = parseVersion(latestRaw);
  if (!current || !latest) return 0;
  if (current.major !== latest.major) return current.major - latest.major;
  if (current.minor !== latest.minor) return current.minor - latest.minor;
  if (current.patch !== latest.patch) return current.patch - latest.patch;
  if (!current.prerelease && latest.prerelease) return -1;
  if (current.prerelease && !latest.prerelease) return 1;
  if (!current.prerelease && !latest.prerelease) return 0;
  return current.prerelease.localeCompare(latest.prerelease, undefined, { numeric: true });
}

function isNewerVersion(currentRaw, latestRaw) {
  return compareVersions(currentRaw, latestRaw) < 0;
}

function httpsJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': USER_AGENT,
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpsJson(res.headers.location).then(resolve).catch(reject);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`GitHub 请求失败 (${res.statusCode || 'unknown'})`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('GitHub 返回格式无效'));
          }
        });
      },
    );
    req.on('error', (err) => reject(new Error(err.message || '网络连接失败')));
    req.setTimeout(20000, () => {
      req.destroy(new Error('连接 GitHub 超时'));
    });
  });
}

function pickDmgAsset(release, versionLabel) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const expected = `QiziShell-${versionLabel}-arm64.dmg`;
  const exact = assets.find((asset) => asset?.name === expected);
  if (exact?.browser_download_url) return exact;
  return assets.find(
    (asset) => typeof asset?.name === 'string'
      && /^QiziShell-.+-arm64\.dmg$/i.test(asset.name)
      && asset.browser_download_url,
  ) || null;
}

/** ship.sh 自动写入的安装说明，不适合在应用内更新窗展示 */
function sanitizeReleaseNotes(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.includes('Apple Silicon (arm64) macOS 安装包')
    && text.includes('拖入「应用程序」')) {
    return '';
  }
  return text;
}

function pickLatestRelease(releases) {
  if (!Array.isArray(releases) || releases.length === 0) {
    throw new Error('未找到 Release');
  }
  let best = null;
  for (const release of releases) {
    const latestVersion = String(release?.tag_name || '').replace(/^v/i, '').trim();
    if (!latestVersion) continue;
    const asset = pickDmgAsset(release, latestVersion);
    if (!asset) continue;
    if (!best || compareVersions(best.latestVersion, latestVersion) < 0) {
      best = { release, latestVersion, asset };
    }
  }
  if (!best) {
    throw new Error('Release 中未找到 macOS 安装包');
  }
  return best;
}

async function checkForUpdate(currentVersion) {
  const releases = await httpsJson(GITHUB_RELEASES_API);
  const { release, latestVersion, asset } = pickLatestRelease(releases);
  const tagName = String(release?.tag_name || '').trim();
  const updateAvailable = isNewerVersion(currentVersion, latestVersion);
  return {
    ok: true,
    currentVersion,
    latestVersion,
    updateAvailable,
    releaseName: release?.name || tagName,
    releaseNotes: sanitizeReleaseNotes(release?.body),
    downloadUrl: asset.browser_download_url,
    assetName: asset.name,
    htmlUrl: release?.html_url || `https://github.com/${GITHUB_REPO}/releases/tag/${tagName}`,
  };
}

function resolveInstallTargetAppBundle() {
  if (process.platform !== 'darwin') {
    throw new Error('当前仅支持 macOS 自动升级');
  }
  if (app.isPackaged) {
    const marker = '.app/Contents/';
    const exe = process.execPath;
    const idx = exe.indexOf(marker);
    if (idx >= 0) return exe.slice(0, idx + 4);
  }
  return '/Applications/QiziShell.app';
}

function getUpdateInstallLogPath() {
  return path.join(app.getPath('userData'), 'update-install.log');
}

function validateDownloadedDmg(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size < 1024 * 1024) {
    throw new Error('下载的安装包体积异常，可能未成功下载');
  }
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const request = (targetUrl, redirectsLeft = 5) => {
      https.get(
        targetUrl,
        {
          headers: {
            Accept: 'application/octet-stream',
            'User-Agent': USER_AGENT,
          },
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirectsLeft <= 0) {
              reject(new Error('下载重定向过多'));
              return;
            }
            request(res.headers.location, redirectsLeft - 1);
            return;
          }
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`下载失败 (${res.statusCode || 'unknown'})`));
            return;
          }
          const total = Number(res.headers['content-length']) || 0;
          let received = 0;
          res.on('data', (chunk) => {
            received += chunk.length;
            if (typeof onProgress === 'function') {
              onProgress({ received, total });
            }
          });
          res.pipe(file);
          file.on('finish', () => {
            file.close(() => resolve(destPath));
          });
        },
      ).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(new Error(err.message || '下载失败'));
      });
    };
    file.on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(new Error(err.message || '无法写入临时文件'));
    });
    request(url);
  });
}

function spawnDetachedInstallScript(dmgPath, updaterPid) {
  const scriptPath = path.join(os.tmpdir(), `qizi-install-${Date.now()}.sh`);
  const appPath = resolveInstallTargetAppBundle();
  const logPath = getUpdateInstallLogPath();
  const script = `#!/bin/bash
set -euo pipefail
DMG=${JSON.stringify(dmgPath)}
APP=${JSON.stringify(appPath)}
LOG=${JSON.stringify(logPath)}
UPDATER_PID=${Number(updaterPid) || 0}
exec >>"$LOG" 2>&1
echo "== QiziShell update $(date) =="
echo "DMG=$DMG"
echo "APP=$APP"
echo "UPDATER_PID=$UPDATER_PID"

if [[ "$UPDATER_PID" -gt 0 ]]; then
  for _ in $(seq 1 40); do
    if ! kill -0 "$UPDATER_PID" 2>/dev/null; then break; fi
    sleep 0.25
  done
fi
sleep 1

if pgrep -x QiziShell >/dev/null 2>&1; then
  pkill -x QiziShell 2>/dev/null || true
  sleep 2
fi

ATTACH="$(hdiutil attach "$DMG" -nobrowse -readonly 2>&1)" || {
  echo "hdiutil attach failed: $ATTACH"
  exit 1
}
MOUNT="$(echo "$ATTACH" | tail -1 | awk '{$1=$2=""; sub(/^  */, ""); print}')"
echo "MOUNT=$MOUNT"

if [[ -z "$MOUNT" || ! -d "$MOUNT/QiziShell.app" ]]; then
  echo "QiziShell.app not found in mount: $MOUNT"
  [[ -n "$MOUNT" ]] && hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
  exit 1
fi

mkdir -p "$(dirname "$APP")"
rm -rf "$APP"
ditto "$MOUNT/QiziShell.app" "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
hdiutil detach "$MOUNT" -quiet 2>/dev/null || hdiutil detach "$MOUNT" -force -quiet 2>/dev/null || true

open "$APP"
echo "install done"
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  const child = spawn('/bin/bash', [scriptPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function downloadAndInstallUpdate({ downloadUrl, assetName }, onProgress, { updaterPid } = {}) {
  if (!downloadUrl) {
    throw new Error('缺少下载地址');
  }
  if (!app.isPackaged) {
    throw new Error('开发模式无法自动升级，请下载 DMG 手动安装到「应用程序」');
  }
  const safeName = String(assetName || 'QiziShell-update.dmg').replace(/[^\w.-]+/g, '_');
  const destPath = path.join(os.tmpdir(), safeName);
  await downloadFile(downloadUrl, destPath, onProgress);
  validateDownloadedDmg(destPath);
  spawnDetachedInstallScript(destPath, updaterPid || process.pid);
  return { ok: true, dmgPath: destPath, appPath: resolveInstallTargetAppBundle() };
}

module.exports = {
  checkForUpdate,
  downloadAndInstallUpdate,
  compareVersions,
  isNewerVersion,
  parseVersion,
};
