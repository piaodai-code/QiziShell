(() => {
  const rowsEl = document.getElementById('rows');
  const statusEl = document.getElementById('status');
  const statRunningEl = document.getElementById('stat-running');
  const statNextEl = document.getElementById('stat-next');
  const statTodayEl = document.getElementById('stat-today');
  const footEl = document.getElementById('foot');
  const AGENT_COLORS = ['#8c8c91', '#4c8de8', '#e3a64b', '#34a853', '#c47ad4', '#e36b8a', '#3aa8a0'];

  function agentColors(jobs) {
    const colors = new Map();
    for (const job of jobs) {
      const name = job.agentName;
      if (colors.has(name)) continue;
      const index = colors.size;
      const color = AGENT_COLORS[index]
        || `hsl(${Math.round((index * 47) % 360)} 52% 46%)`;
      colors.set(name, color);
    }
    return colors;
  }
  const running = new Set();
  const holding = new Set();
  let refreshTimer = null;

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDistance(ms, suffix) {
    const at = Number(ms);
    if (!at) return '—';
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const delta = Math.max(0, suffix === '后' ? at - Date.now() : Date.now() - at);
    if (delta > day) return `${Math.floor(delta / day)}天${suffix}`;
    if (delta >= hour) return `${Math.floor(delta / hour)}小时${suffix}`;
    return `${Math.max(1, Math.floor(delta / minute))}分钟${suffix}`;
  }

  function valueWithUnit(text) {
    const match = String(text).match(/^(\d+)(.*)$/);
    if (!match) return escapeHtml(text);
    return `${match[1]} <small>${escapeHtml(match[2])}</small>`;
  }

  function paintStats(jobs) {
    const enabled = jobs.filter((job) => job.enabled);
    const nextAt = enabled.reduce((soonest, job) => {
      const at = Number(job.nextRunAtMs);
      if (!at || at <= Date.now()) return soonest;
      return soonest && soonest < at ? soonest : at;
    }, 0);
    const endOfToday = new Date();
    endOfToday.setHours(24, 0, 0, 0);
    const todayLeft = enabled.filter((job) => {
      const at = Number(job.nextRunAtMs);
      return at > Date.now() && at < endOfToday.getTime();
    }).length;
    statRunningEl.innerHTML = `${enabled.length} <small>个</small>`;
    statNextEl.innerHTML = nextAt ? valueWithUnit(formatDistance(nextAt, '后')) : '—';
    statTodayEl.innerHTML = `${todayLeft} <small>个</small>`;
    footEl.textContent = `监控任务 ${jobs.length} 个`;
  }

  function clipHtml(text) {
    const full = String(text || '');
    return `<span class="clip" data-full="${escapeHtml(full)}">${escapeHtml(full)}</span>`;
  }

  function lastCell(job) {
    if (job.lastOk === false) {
      const title = job.lastError ? ` title="${escapeHtml(job.lastError)}"` : '';
      return `<span class="auto-dot"${title}></span>`;
    }
    if (job.lastOk === true) return escapeHtml(formatDistance(job.lastRunAtMs, '前'));
    return '—';
  }

  function render(jobs) {
    paintStats(jobs);
    if (!jobs.length) {
      rowsEl.innerHTML = '<tr><td class="auto-empty" colspan="6">还没有自动化任务</td></tr>';
      return;
    }
    const colors = agentColors(jobs);
    rowsEl.innerHTML = jobs.map((job) => {
      const busy = running.has(job.id) || job.running;
      const off = job.enabled ? '' : ' is-off';
      const taskText = `${job.name}${job.enabled ? '' : '（已停用）'}`;
      const task = clipHtml(taskText);
      const schedule = clipHtml(job.scheduleLabel);
      const action = busy ? '运行中' : '重跑';
      const face = busy
        ? '<span class="auto-spin" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>'
        : '<img src="assets/icons/automation-run.png" alt="">';
      const dot = colors.get(job.agentName);
      return `<tr class="${off.trim()}">
        <td><span class="agent"><i style="background:${dot}"></i>${escapeHtml(job.agentName)}</span></td>
        <td class="task">${task}</td>
        <td class="schedule">${schedule}</td>
        <td>${escapeHtml(formatDistance(job.nextRunAtMs, '后'))}</td>
        <td class="last">${lastCell(job)}</td>
        <td><button type="button" class="auto-run${busy ? ' is-busy' : ''}" data-id="${escapeHtml(job.id)}" title="${action}" aria-label="${action}" ${busy ? 'disabled' : ''}>${face}</button></td>
      </tr>`;
    }).join('');
  }

  function statusText(error) {
    const message = String(error || '');
    if (
      message.startsWith('gateway closed (')
      || message === 'gateway not connected'
      || message === 'gateway connect timeout'
      || message.startsWith('gateway request timeout')
    ) {
      return '和 Gateway 的连接中断了，正在重试';
    }
    return message || '没有取到自动化任务';
  }

  async function refresh() {
    const result = await window.automation.list();
    clearTimeout(refreshTimer);
    if (!result?.ok) {
      statusEl.textContent = statusText(result?.error);
      refreshTimer = setTimeout(refresh, 4000);
      return;
    }
    statusEl.textContent = '';
    const jobs = result.jobs || [];
    for (const id of [...running]) {
      if (holding.has(id)) continue;
      const job = jobs.find((item) => item.id === id);
      if (job && !job.running) running.delete(id);
    }
    render(jobs);
    refreshTimer = setTimeout(refresh, jobs.some((job) => job.running) || running.size ? 4000 : 20000);
  }

  const clipTip = document.getElementById('clip-tip');

  function hideClipTip() {
    clipTip.hidden = true;
  }

  function showClipTip(el) {
    if (el.scrollWidth <= el.clientWidth + 1) {
      hideClipTip();
      return;
    }
    clipTip.textContent = el.dataset.full || '';
    clipTip.hidden = false;
    const rect = el.getBoundingClientRect();
    const tipRect = clipTip.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + 4;
    if (left + tipRect.width > window.innerWidth - 8) left = window.innerWidth - tipRect.width - 8;
    if (top + tipRect.height > window.innerHeight - 8) top = rect.top - tipRect.height - 4;
    clipTip.style.left = `${Math.max(8, left)}px`;
    clipTip.style.top = `${Math.max(8, top)}px`;
  }

  rowsEl.addEventListener('mouseover', (event) => {
    const clip = event.target.closest?.('.clip');
    if (!clip || !rowsEl.contains(clip)) {
      hideClipTip();
      return;
    }
    showClipTip(clip);
  });
  rowsEl.addEventListener('mouseout', (event) => {
    const next = event.relatedTarget?.closest?.('.clip');
    if (next && rowsEl.contains(next)) return;
    hideClipTip();
  });

  rowsEl.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-id]');
    if (!button || button.disabled) return;
    const id = button.dataset.id;
    running.add(id);
    holding.add(id);
    button.disabled = true;
    button.classList.add('is-busy');
    button.title = '运行中';
    button.setAttribute('aria-label', '运行中');
    button.innerHTML = '<span class="auto-spin" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>';
    const result = await window.automation.run(id);
    if (!result?.ok) {
      holding.delete(id);
      running.delete(id);
      statusEl.textContent = result?.error || '没有跑起来';
    }
    await refresh();
    holding.delete(id);
  });

  refresh();
})();
