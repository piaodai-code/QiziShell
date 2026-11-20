'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ICON_FILES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

function writeIcon(programDir, resourcesDir) {
  const source = path.join(programDir, 'shell-icon.png');
  if (!fs.existsSync(source)) return '';
  const iconset = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qizi-keepalive-icon-')), 'Icon.iconset');
  fs.mkdirSync(iconset);
  try {
    for (const [name, size] of ICON_FILES) {
      const made = spawnSync('sips', ['-z', String(size), String(size), source, '--out', path.join(iconset, name)], { timeout: 10000 });
      if (made.status !== 0) return '';
    }
    const icns = path.join(resourcesDir, 'icon.icns');
    const built = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', icns], { timeout: 10000 });
    return built.status === 0 && fs.existsSync(icns) ? 'icon.icns' : '';
  } finally {
    fs.rmSync(iconset, { recursive: true, force: true });
  }
}

/**
 * Puts 保活.app next to server.js. Double-click shows the window, or starts the
 * service when it is not running. Regenerating keeps the script pointed at this directory.
 */
function installLauncher({ programDir, port, dataDir }) {
  const appDir = path.join(programDir, '保活.app');
  const contents = path.join(appDir, 'Contents');
  const macOs = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  fs.mkdirSync(macOs, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  const icon = writeIcon(programDir, resources);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>CFBundleIdentifier</key>
  <string>local.qizi.keepalive</string>
  <key>CFBundleName</key>
  <string>保活</string>
  <key>CFBundleDisplayName</key>
  <string>保活</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleIconFile</key>
  <string>${icon || 'icon'}</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`;
  fs.writeFileSync(path.join(contents, 'Info.plist'), plist);
  const launcher = `#!/bin/bash
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
PORT=${Number(port) || 18990}
DATA=${JSON.stringify(dataDir)}
if curl -sf -m 3 -o /dev/null "http://127.0.0.1:$PORT/api/state"; then
  curl -sf -m 30 -X POST "http://127.0.0.1:$PORT/api/window/show" >/dev/null
  exit 0
fi
cd "$ROOT" || exit 1
mkdir -p "$DATA"
nohup node server.js --port "$PORT" --data-dir "$DATA" >> "$DATA/keepalive.log" 2>&1 &
`;
  const launcherPath = path.join(macOs, 'launcher');
  fs.writeFileSync(launcherPath, launcher, { mode: 0o755 });
  fs.chmodSync(launcherPath, 0o755);
  return appDir;
}

module.exports = { installLauncher };
