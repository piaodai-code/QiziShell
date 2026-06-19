const currentVersionEl = document.getElementById('update-current-version');
const statusEl = document.getElementById('update-status');
const spinnerEl = document.getElementById('update-spinner');
const notesEl = document.getElementById('update-notes');
const progressWrapEl = document.getElementById('update-progress');
const progressFillEl = document.getElementById('update-progress-fill');
const progressTextEl = document.getElementById('update-progress-text');
const installBtnEl = document.getElementById('update-install-btn');
const recheckBtnEl = document.getElementById('update-recheck-btn');

let latestCheckResult = null;
let installing = false;

function setSpinner(visible) {
  if (spinnerEl) spinnerEl.hidden = !visible;
}

function setStatus(text, kind) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = `update-status ${kind || 'checking'}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function showNotes(text) {
  if (!notesEl) return;
  if (text) {
    notesEl.textContent = text;
    notesEl.hidden = false;
  } else {
    notesEl.textContent = '';
    notesEl.hidden = true;
  }
}

function resetProgress() {
  if (progressWrapEl) progressWrapEl.hidden = true;
  if (progressFillEl) progressFillEl.style.width = '0%';
  if (progressTextEl) progressTextEl.textContent = '准备下载…';
}

async function runUpdateCheck() {
  if (!window.qiziUpdate?.checkForUpdate) {
    setSpinner(false);
    setStatus('更新模块不可用', 'error');
    return;
  }
  installing = false;
  resetProgress();
  if (installBtnEl) installBtnEl.hidden = true;
  if (recheckBtnEl) recheckBtnEl.hidden = true;
  showNotes('');
  setSpinner(true);
  setStatus('正在连接 GitHub…', 'checking');

  try {
    const result = await window.qiziUpdate.checkForUpdate();
    latestCheckResult = result;
    setSpinner(false);

    if (!result?.ok) {
      setStatus(result?.error || '检查更新失败', 'error');
      if (recheckBtnEl) recheckBtnEl.hidden = false;
      return;
    }

    if (result.updateAvailable) {
      setStatus(`是否升级到最新版本（${result.latestVersion}）`, 'available');
      if (installBtnEl) installBtnEl.hidden = false;
      if (result.releaseNotes) showNotes(result.releaseNotes);
      return;
    }

    setStatus('当前为最新版本', 'latest');
    if (recheckBtnEl) recheckBtnEl.hidden = false;
  } catch (err) {
    setSpinner(false);
    setStatus(err?.message || '检查更新失败', 'error');
    if (recheckBtnEl) recheckBtnEl.hidden = false;
  }
}

async function startInstall() {
  if (installing || !window.qiziUpdate?.installUpdate) return;
  installing = true;
  if (installBtnEl) {
    installBtnEl.disabled = true;
    installBtnEl.textContent = '升级中…';
  }
  if (recheckBtnEl) recheckBtnEl.hidden = true;
  if (progressWrapEl) progressWrapEl.hidden = false;
  setSpinner(false);
  setStatus('正在下载安装包…', 'checking');

  try {
    const result = await window.qiziUpdate.installUpdate();
    if (!result?.ok) {
      throw new Error(result?.error || '升级失败');
    }
    setStatus('下载完成，应用即将重启并完成安装…', 'latest');
    if (progressTextEl) progressTextEl.textContent = '请稍候…';
  } catch (err) {
    installing = false;
    if (installBtnEl) {
      installBtnEl.hidden = false;
      installBtnEl.disabled = false;
      installBtnEl.textContent = '升级';
    }
    if (recheckBtnEl) recheckBtnEl.hidden = true;
    setStatus(err?.message || '升级失败', 'error');
  }
}

if (window.qiziUpdate?.onDownloadProgress) {
  window.qiziUpdate.onDownloadProgress(({ received, total }) => {
    if (!progressWrapEl || progressWrapEl.hidden) progressWrapEl.hidden = false;
    const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
    if (progressFillEl) {
      progressFillEl.style.width = total > 0 ? `${percent}%` : '35%';
    }
    if (progressTextEl) {
      if (total > 0) {
        progressTextEl.textContent = `已下载 ${formatBytes(received)} / ${formatBytes(total)}（${percent}%）`;
      } else {
        progressTextEl.textContent = `已下载 ${formatBytes(received)}…`;
      }
    }
  });
}

if (window.qiziUpdate?.onRecheck) {
  window.qiziUpdate.onRecheck(() => {
    void runUpdateCheck();
  });
}

if (installBtnEl) {
  installBtnEl.addEventListener('click', () => {
    void startInstall();
  });
}

if (recheckBtnEl) {
  recheckBtnEl.addEventListener('click', () => {
    void runUpdateCheck();
  });
}

void (async () => {
  if (window.qiziUpdate?.getCurrentVersion) {
    try {
      const version = await window.qiziUpdate.getCurrentVersion();
      if (currentVersionEl) currentVersionEl.textContent = version || '—';
    } catch {
      if (currentVersionEl) currentVersionEl.textContent = '—';
    }
  }
  await runUpdateCheck();
})();
