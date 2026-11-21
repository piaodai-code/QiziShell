const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad2(value) {
  return String(value).padStart(2, '0');
}

function clock(hour, minute) {
  return `${pad2(hour)}:${pad2(minute)}`;
}

function expandHours(hour, minute) {
  if (!/^\d{1,2}$/.test(minute)) return null;
  const minutes = Number(minute);
  if (minutes > 59) return null;
  if (/^\d{1,2}$/.test(hour)) {
    const hours = Number(hour);
    return hours <= 23 ? [clock(hours, minutes)] : null;
  }
  if (!/^(\d{1,2})(,(\d{1,2}))+$/.test(hour)) return null;
  const hours = hour.split(',').map(Number);
  if (hours.some((item) => item > 23)) return null;
  return hours.map((item) => clock(item, minutes));
}

function expandWeekdays(dow) {
  if (dow === '*' || dow === '?') return null;
  const names = [];
  for (const part of dow.split(',')) {
    if (/^\d$/.test(part)) {
      const day = Number(part) % 7;
      names.push(WEEKDAYS[day]);
      continue;
    }
    const range = part.match(/^(\d)-(\d)$/);
    if (!range) return null;
    let start = Number(range[1]) % 7;
    const end = Number(range[2]) % 7;
    for (let guard = 0; guard < 7; guard += 1) {
      names.push(WEEKDAYS[start]);
      if (start === end) break;
      start = (start + 1) % 7;
    }
  }
  return names;
}

function formatCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length < 5) return String(expr || '');
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const times = expandHours(hour, minute);
  if (!times || month !== '*') return String(expr);
  const timeText = times.join('、');
  if (dayOfMonth === '*' && (dayOfWeek === '*' || dayOfWeek === '?')) return `每天 ${timeText}`;
  if (dayOfMonth === '*') {
    const days = expandWeekdays(dayOfWeek);
    if (!days) return String(expr);
    return `每${days.join('、')} ${timeText}`;
  }
  if (dayOfWeek === '*' || dayOfWeek === '?') return `每月 ${dayOfMonth} 日 ${timeText}`;
  return String(expr);
}

function formatEvery(everyMs) {
  const ms = Number(everyMs);
  if (!Number.isFinite(ms) || ms <= 0) return '按间隔运行';
  if (ms % 3600000 === 0) {
    const hours = ms / 3600000;
    return hours === 1 ? '每小时' : `每 ${hours} 小时`;
  }
  if (ms % 60000 === 0) {
    const minutes = ms / 60000;
    return minutes === 1 ? '每分钟' : `每 ${minutes} 分钟`;
  }
  return `每 ${Math.round(ms / 1000)} 秒`;
}

function formatSchedule(schedule, formatInstant) {
  if (!schedule || typeof schedule !== 'object') return '—';
  if (schedule.kind === 'cron') return formatCron(schedule.expr);
  if (schedule.kind === 'every') return formatEvery(schedule.everyMs);
  if (schedule.kind === 'at') {
    const at = Date.parse(schedule.at);
    return Number.isFinite(at) && typeof formatInstant === 'function' ? formatInstant(at) : String(schedule.at || '—');
  }
  return '—';
}

function jobFailure(job) {
  const status = String(job?.state?.lastRunStatus || job?.lastRunStatus || '').toLowerCase();
  const at = Number(job?.state?.lastRunAtMs || job?.lastRunAtMs || 0);
  if (!at || !status || status === 'ok' || status === 'skipped') return false;
  return true;
}

function presentJobs(jobs, agents) {
  const names = new Map();
  for (const agent of agents || []) {
    const id = String(agent?.id || '');
    if (!id) continue;
    names.set(id, String(agent?.name || '').trim() || id);
  }
  return (jobs || []).map((job) => {
    const agentId = String(job.agentId || job.effectiveAgentId || '');
    const status = String(job.state?.lastRunStatus || job.lastRunStatus || '').toLowerCase();
    const lastRunAtMs = Number(job.state?.lastRunAtMs || job.lastRunAtMs || 0);
    let lastOk = null;
    if (lastRunAtMs && (status === 'ok' || status === 'skipped')) lastOk = true;
    else if (jobFailure(job)) lastOk = false;
    return {
      id: String(job.id || ''),
      agentId,
      agentName: names.get(agentId) || (agentId ? agentId : '未指定'),
      name: String(job.name || job.id || '未命名任务'),
      enabled: job.enabled !== false,
      scheduleLabel: formatSchedule(job.schedule, (at) => new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(at)),
      nextRunAtMs: Number(job.state?.nextRunAtMs || job.nextRunAtMs || 0),
      lastRunAtMs,
      lastOk,
      lastError: lastOk === false ? String(job.state?.lastError || job.lastError || '').slice(0, 240) : '',
      running: Boolean(job.state?.runningAtMs),
    };
  }).filter((job) => job.id).sort((a, b) => (
    a.agentName.localeCompare(b.agentName, 'zh') || a.name.localeCompare(b.name, 'zh')
  ));
}

function createAutomationFeature({
  app,
  BrowserWindow,
  ipcMain,
  screen,
  presentWindow,
  cancelPresent,
  syncDockVisibility,
  isMaintainingWindowSender,
  gatewayRequest,
  onAutomationAlert,
  openBesideMaintainer,
}) {
  let win = null;
  let pollTimer = null;
  let failed = false;
  const boundsPath = () => path.join(app.getPath('userData'), 'automation-window-state.json');

  function readBounds() {
    try {
      const saved = JSON.parse(require('fs').readFileSync(boundsPath(), 'utf8'));
      const width = Math.max(760, Math.min(1600, Number(saved.width) || 980));
      const height = Math.max(420, Math.min(1200, Number(saved.height) || 640));
      const x = Number(saved.x);
      const y = Number(saved.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { width, height };
      const visible = screen.getAllDisplays().some((display) => {
        const area = display.workArea;
        return x < area.x + area.width - 80 && x + width > area.x + 80
          && y < area.y + area.height - 40 && y + 48 > area.y;
      });
      return visible ? { width, height, x, y } : { width, height };
    } catch {
      return { width: 980, height: 640 };
    }
  }

  function saveBounds() {
    if (!win || win.isDestroyed()) return;
    try {
      require('fs').writeFileSync(boundsPath(), JSON.stringify(win.getBounds()));
    } catch {
      // non-fatal
    }
  }

  async function loadRows() {
    const jobs = [];
    let offset = 0;
    for (let page = 0; page < 10; page += 1) {
      const result = await gatewayRequest('cron.list', { limit: 200, offset });
      jobs.push(...(Array.isArray(result?.jobs) ? result.jobs : []));
      if (!result?.hasMore) break;
      offset = Number(result.nextOffset);
      if (!Number.isFinite(offset)) break;
    }
    let agents = [];
    try {
      const listed = await gatewayRequest('agents.list', {});
      agents = Array.isArray(listed?.agents) ? listed.agents : [];
    } catch {
      agents = [];
    }
    const rows = presentJobs(jobs, agents);
    failed = rows.some((row) => row.lastOk === false);
    if (typeof onAutomationAlert === 'function') onAutomationAlert(failed);
    return { ok: true, jobs: rows, failed };
  }

  async function refreshAlert() {
    try {
      await loadRows();
    } catch {
      // A gateway blip keeps the last dot instead of hiding a real failure.
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(refreshAlert, 30000);
    if (pollTimer.unref) pollTimer.unref();
    refreshAlert();
  }

  function open() {
    if (win && !win.isDestroyed()) {
      presentWindow(win, { dock: true });
      return { ok: true };
    }
    win = new BrowserWindow({
      ...readBounds(),
      minWidth: 760,
      minHeight: 420,
      title: 'Automation',
      show: false,
      fullscreenable: false,
      backgroundColor: '#f2f2f2',
      webPreferences: {
        preload: require('path').join(__dirname, 'automation-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        devTools: Boolean(process.env.QIZI_DEVTOOLS_PORT),
      },
    });
    const created = win;
    created.setMenu(null);
    created.once('ready-to-show', () => presentWindow(created, { dock: true }));
    created.on('close', saveBounds);
    created.on('closed', () => {
      cancelPresent(created);
      if (win === created) win = null;
      syncDockVisibility();
    });
    created.loadFile(require('path').join(__dirname, 'automation.html'));
    return { ok: true };
  }

  const sideSenders = new Set();

  function attach(contents) {
    sideSenders.add(contents);
    contents.once('destroyed', () => sideSenders.delete(contents));
  }

  function fromWindow(event) {
    if (sideSenders.has(event.sender)) return true;
    return Boolean(win && !win.isDestroyed() && BrowserWindow.fromWebContents(event.sender) === win);
  }

  ipcMain.handle('automation:open', (event) => {
    if (!isMaintainingWindowSender(event)) return { ok: false, error: 'Forbidden' };
    if (typeof openBesideMaintainer === 'function') return openBesideMaintainer('automation');
    return open();
  });

  ipcMain.handle('automation:list', async (event) => {
    if (!fromWindow(event)) return { ok: false, error: 'Forbidden' };
    try {
      return await loadRows();
    } catch (err) {
      return { ok: false, error: err?.message || '没有取到自动化任务' };
    }
  });

  ipcMain.handle('automation:run', async (event, payload) => {
    if (!fromWindow(event)) return { ok: false, error: 'Forbidden' };
    const id = String(payload?.id || '');
    if (!/^[A-Za-z0-9-]{8,80}$/.test(id)) return { ok: false, error: '任务无效' };
    try {
      await gatewayRequest('cron.run', { id });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || '没有跑起来' };
    }
  });

  app.whenReady().then(() => startPolling());
  app.on('before-quit', () => {
    clearInterval(pollTimer);
    pollTimer = null;
  });

  return {
    open,
    attach,
    failed: () => failed,
    isVisible: () => Boolean(win && !win.isDestroyed() && win.isVisible()),
  };
}

module.exports = {
  createAutomationFeature,
  formatSchedule,
  presentJobs,
  jobFailure,
};
