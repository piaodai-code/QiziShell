(() => {
  const rowsEl = document.getElementById('rows');
  const statusEl = document.getElementById('status');
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

  function lastCell(job) {
    if (job.lastOk === false) {
      const title = job.lastError ? ` title="${escapeHtml(job.lastError)}"` : '';
      return `<span class="auto-dot"${title}></span>`;
    }
    if (job.lastOk === true) return escapeHtml(formatDistance(job.lastRunAtMs, '前'));
    return '—';
  }

  function render(jobs) {
    if (!jobs.length) {
      rowsEl.innerHTML = '<tr><td class="auto-empty" colspan="6">还没有自动化任务</td></tr>';
      return;
    }
    let band = 0;
    let previousAgent = '';
    rowsEl.innerHTML = jobs.map((job) => {
      if (job.agentName !== previousAgent) {
        if (previousAgent) band = 1 - band;
        previousAgent = job.agentName;
      }
      const busy = running.has(job.id) || job.running;
      const off = job.enabled ? '' : ' is-off';
      const shade = band ? ' band' : '';
      const task = `${escapeHtml(job.name)}${job.enabled ? '' : '（已停用）'}`;
      const action = busy ? '运行中' : '重跑';
      const face = busy
        ? '<span class="auto-spin" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>'
        : '<img src="assets/icons/automation-run.png" alt="">';
      return `<tr class="${(off + shade).trim()}">
        <td>${escapeHtml(job.agentName)}</td>
        <td class="task">${task}</td>
        <td>${escapeHtml(job.scheduleLabel)}</td>
        <td>${escapeHtml(formatDistance(job.nextRunAtMs, '后'))}</td>
        <td>${lastCell(job)}</td>
        <td><button type="button" class="auto-run${busy ? ' is-busy' : ''}" data-id="${escapeHtml(job.id)}" title="${action}" aria-label="${action}" ${busy ? 'disabled' : ''}>${face}</button></td>
      </tr>`;
    }).join('');
  }

  async function refresh() {
    const result = await window.automation.list();
    if (!result?.ok) {
      statusEl.textContent = result?.error || '没有取到自动化任务';
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
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, jobs.some((job) => job.running) || running.size ? 4000 : 20000);
  }

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
