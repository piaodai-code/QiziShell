(() => {
  const $ = (id) => document.getElementById(id);
  const platformsEl = $('ka-platforms');
  const linkEl = $('ka-link');
  const toastEl = $('ka-toast');
  const dialog = $('ka-dialog');

  /** Last snapshot from the server; null until the first one arrives. */
  let state = null;
  let link = { state: 'connecting', error: '' };
  /** platform id -> operation in flight, so its controls stay disabled until the server answers. */
  const pending = new Map();
  const openEventLists = new Set();
  let editingId = null;
  /** Platform card left open. Empty until the first choice, which keeps the first card open. */
  let expandedId = '';
  let deleteArmed = false;
  let toastTimer = null;
  /** platformId -> { at, ok, error } for a notice this window has seen forwarded. */
  const relayStatus = new Map();

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  const pad = (n) => String(n).padStart(2, '0');

  /** 13:02:11 today, 11-18 13:02 on another day. Follows the Mac menu-bar clock. */
  function clock(ms, { seconds = true } = {}) {
    if (!ms) return '';
    const parts = window.MessageTime?.localParts?.(ms);
    const today = window.MessageTime?.localParts?.(Date.now());
    if (!parts || !today) return '';
    const time = `${pad(parts.hour)}:${pad(parts.minute)}${seconds ? `:${pad(parts.second)}` : ''}`;
    if (parts.year === today.year && parts.month === today.month && parts.day === today.day) return time;
    return `${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
  }

  function toast(text, tone) {
    toastEl.textContent = text;
    toastEl.dataset.tone = tone || '';
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, tone === 'bad' ? 7000 : 3500);
  }

  const connected = () => link.state === 'connected';

  // ---- reading a platform's status ----

  function badgeOf(platform) {
    const s = platform.status;
    if (!platform.enabled) return ['off', '已停用'];
    if (s.transition === 'starting') return ['busy', '正在启动'];
    if (s.transition === 'stopping') return ['busy', '正在关闭'];
    if (!s.chrome_on) return ['off', '已停止'];
    if (s.activity === 'keepalive') return ['busy', '正在保活'];
    if (s.activity === 'check') return ['busy', '正在检测'];
    if (s.script.state !== 'ok') return ['warn', '待确认'];
    if (!s.browser_alive) return ['warn', '待确认'];
    if (s.awaiting_login || s.session?.status === 'logged_out') return ['bad', '已掉线'];
    if (s.session?.status === 'alive') return ['ok', '已登录'];
    return ['warn', '待确认'];
  }

  function shellDown() {
    if (!connected() || !state) return false;
    const wanted = state.platforms.filter((item) => (
      item.enabled && item.status?.chrome_on && !item.status?.transition
    ));
    return wanted.length > 0 && wanted.every((item) => !item.status.browser_alive);
  }

  function phaseOf(platform) {
    const s = platform.status;
    const scriptOk = s.script?.state === 'ok';
    const pageOpen = Boolean(s.chrome_on && s.browser_alive);
    const loggedOut = Boolean(s.awaiting_login || s.session?.status === 'logged_out');
    if (!scriptOk) {
      const detail = s.script?.state === 'invalid' && s.script.error
        ? `后续检查暂停，登录页和登录状态暂不判断。${s.script.error}`
        : '后续检查暂停，登录页和登录状态暂不判断。';
      return {
        banner: ['warn', '脚本未就绪', detail],
        stages: [['warn', '脚本', '未就绪'], ['pending', '登录页', '等待脚本'], ['pending', '登录', '等待登录页']],
      };
    }
    if (!pageOpen) {
      return {
        banner: s.chrome_on ? ['warn', '登录页未打开', '登录状态暂不判断。'] : null,
        stages: [
          ['ok', '脚本', '已就绪'],
          ['alert', '登录页', s.chrome_on ? '未打开' : '已关闭'],
          ['pending', '登录', '等待登录页'],
        ],
      };
    }
    if (loggedOut) {
      return {
        banner: ['bad', '登录掉线', `登录状态失效，保活已暂停。${s.session?.reason_text || '原因未知'}`],
        notice: true,
        stages: [['ok', '脚本', '已就绪'], ['ok', '登录页', '已打开'], ['alert', '登录', '已掉线']],
      };
    }
    if (s.session?.status === 'alive') {
      return {
        banner: null,
        stages: [['ok', '脚本', '已就绪'], ['ok', '登录页', '已打开'], ['ok', '登录', '已登录']],
      };
    }
    return {
      banner: null,
      stages: [['ok', '脚本', '已就绪'], ['ok', '登录页', '已打开'], ['pending', '登录', '等待检测']],
    };
  }

  function runSummary(last) {
    if (!last) return '还没有';
    if (last.result === 'ok') return `${last.steps.length} 步完成`;
    if (last.result === 'skipped_locked') return '占用中跳过';
    if (last.result === 'no_script') return '没有脚本';
    if (last.result === 'action_failed') return '没跑完';
    return '出错';
  }

  function formatRemain(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
    return `${minutes}:${pad(seconds)}`;
  }

  const LOCK_OPEN = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 8V5.8a3.5 3.5 0 0 1 6.8-1"/><rect x="4.5" y="8" width="11" height="9" rx="2"/><path d="M10 11.5v2"/></svg>';
  const LOCK_CLOSED = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4.5" y="8" width="11" height="9" rx="2"/><path d="M6.5 8V5.7a3.5 3.5 0 0 1 7 0V8M10 11.5v2"/></svg>';

  function noticeFact(platform) {
    const notice = platform.status.notice;
    const what = notice.kind === 'script_trouble' ? '检查保活脚本' : '重新登录';
    const relay = relayStatus.get(platform.platform_id);
    if (relay && relay.at === notice.at && relay.ok) return `${clock(notice.at)} 已通过 Maintainer 发出，请它去${what}`;
    if (relay && relay.at === notice.at && !relay.ok) return `没通过 Maintainer 发出：${escapeHtml(relay.error)}`;
    if (notice.state === 'sent') return `${clock(notice.at)} 已通过 Maintainer 发出，请它去${what}`;
    if (notice.state === 'pending' || notice.state === 'failed' || notice.state === 'not_configured') {
      return '待通过本机已登录的 Maintainer 发出';
    }
    return '没有待处理的掉线';
  }

  // ---- rendering ----

  function lampOf(platform) {
    const s = platform.status;
    if (!platform.enabled || !s.chrome_on) return '';
    if (shellDown()) return 'lost';
    if (s.awaiting_login || s.session?.status === 'logged_out') return 'lost';
    if (s.script.state !== 'ok' || !s.browser_alive || s.session?.status !== 'alive') return 'warn';
    return 'ok';
  }

  function cardExpanded(id) {
    if (expandedId && state?.platforms.some((item) => item.platform_id === expandedId)) return expandedId === id;
    return state?.platforms[0]?.platform_id === id;
  }

  function rhythm(platform) {
    const every = `每 ${platform.keep_alive.interval_minutes} 分钟`;
    const drift = Number(platform.keep_alive.jitter_minutes)
      ? ` · 漂移 ±${platform.keep_alive.jitter_minutes} 分钟`
      : '';
    return `${every}${drift}`;
  }

  function statusLine(platform) {
    const s = platform.status;
    if (s.paused) return '<span>已暂停</span>';
    if (s.awaiting_login || s.session?.status === 'logged_out') return '<span>重新登录后恢复</span>';
    if (!s.chrome_on) return '<span>保活页面已关闭</span>';
    if (s.script.state !== 'ok') return '<span>等保活脚本</span>';
    if (!s.browser_alive) return '<span>登录页未打开</span>';
    const note = `<span class="ka-next-note">${escapeHtml(rhythm(platform))}</span>`;
    if (!s.next_keepalive_at) return `<span>下次</span><strong class="ka-next">—</strong>${note}`;
    return `<span>下次</span><strong class="ka-next">${escapeHtml(clock(s.next_keepalive_at, { seconds: false }))}</strong>${note}`;
  }

  function renderPlatform(platform) {
    const s = platform.status;
    const id = platform.platform_id;
    const lamp = lampOf(platform);
    const [tone, text] = badgeOf(platform);
    const phase = phaseOf(platform);
    const busy = pending.has(id) || Boolean(s.transition);
    const serverOff = !connected() || busy;
    const down = shellDown();
    const expanded = cardExpanded(id);
    const lock = s.lock;
    const events = s.events.map((event) => `<li><time>${clock(event.at)}</time><span>${escapeHtml(event.text)}</span></li>`).join('');
    const pageSwitchOff = serverOff || !platform.enabled;
    const editOff = serverOff || down;
    const checkOff = editOff || !s.browser_alive;
    const pauseOff = serverOff;
    const banner = phase.banner
      ? `<p class="ka-alert" data-tone="${phase.banner[0]}"><strong>${escapeHtml(phase.banner[1])}</strong>${escapeHtml(phase.banner[2])}${phase.notice ? `<span class="ka-notice">${noticeFact(platform)}</span>` : ''}</p>`
      : '';
    const stages = phase.stages.map(([kind, name, label]) => (
      `<div class="ka-stage" data-kind="${kind}"><i></i><span>${name}</span><small>${escapeHtml(label)}</small></div>`
    ));
    const progress = [stages[0], '<b class="ka-stage-link">›</b>', stages[1], '<b class="ka-stage-link">›</b>', stages[2]].join('');
    const count = lock
      ? `<span class="ka-lock-count" data-expires="${lock.expires_at}">${formatRemain(lock.expires_at - Date.now())}</span>`
      : '';
    const nextAt = s.next_keepalive_at ? clock(s.next_keepalive_at, { seconds: false }) : '—';
    const lastAt = s.last_keepalive?.at ? clock(s.last_keepalive.at, { seconds: false }) : '—';
    const lampTitle = lamp === 'ok' ? '保活正常' : lamp === 'lost' ? '保活失败' : lamp === 'warn' ? '还不能保活' : '';
    return `
      <article class="ka-card${expanded ? ' expanded' : ''}${platform.enabled ? '' : ' is-disabled'}" data-id="${escapeHtml(id)}">
        <button type="button" class="ka-card-toggle" aria-expanded="${expanded ? 'true' : 'false'}">
          <span class="ka-title-row">
            <span class="ka-lamp" data-state="${lamp}" title="${lampTitle}" ${lamp ? '' : 'hidden'}></span>
            <strong class="ka-title">${escapeHtml(platform.name)}</strong>
            <span class="ka-id">${escapeHtml(id)}</span>
            <span class="ka-badge" data-tone="${tone}">${text}</span>
            <span class="ka-affordance" aria-hidden="true">⌄</span>
          </span>
          <span class="ka-status">${statusLine(platform)}</span>
        </button>
        <div class="ka-card-body">
          ${banner}
          <div class="ka-progress" aria-label="脚本到登录状态的检查进度">${progress}</div>
          <div class="ka-cycle">
            <div class="ka-cycle-line">
              <div class="ka-cycle-stop"><small>上次保活</small><strong>${escapeHtml(lastAt)}</strong></div>
              <div class="ka-cycle-track">
                <span class="ka-lock-wrap">
                  <span class="ka-lock${lock ? ' is-locked' : ''}" aria-label="${lock ? '占用锁已锁住' : '占用锁未锁'}">${lock ? LOCK_CLOSED : LOCK_OPEN}</span>
                  ${count}
                </span>
              </div>
              <div class="ka-cycle-stop"><small>下次</small><strong>${escapeHtml(nextAt)}</strong></div>
            </div>
            <div class="ka-cycle-caption"><span>${escapeHtml(runSummary(s.last_keepalive))}</span><span>间隔 ${escapeHtml(String(platform.keep_alive.interval_minutes))} 分钟 · 漂移 ±${escapeHtml(String(platform.keep_alive.jitter_minutes || 0))} 分钟</span></div>
          </div>
          <div class="ka-controls">
            <label class="ka-switch${pageSwitchOff ? ' is-off' : ''}">
              <input type="checkbox" data-act="chrome" ${s.chrome_on ? 'checked' : ''} ${pageSwitchOff ? 'disabled' : ''}>
              <span class="ka-switch-track"></span>保活页面
            </label>
            <label class="ka-switch${pauseOff ? ' is-off' : ''}">
              <input type="checkbox" data-act="pause" ${s.paused ? 'checked' : ''} ${pauseOff ? 'disabled' : ''}>
              <span class="ka-switch-track"></span>暂停保活
            </label>
            <button type="button" class="ka-text-btn" data-act="edit" ${editOff ? 'disabled' : ''}>编辑</button>
            <button type="button" class="ka-btn" data-act="check" ${checkOff ? 'disabled' : ''}>立即检测</button>
          </div>
          <details class="ka-events" ${openEventLists.has(id) ? 'open' : ''}>
            <summary>最近记录</summary>
            <ol>${events || '<li><span>还没有记录</span></li>'}</ol>
          </details>
        </div>
      </article>`;
  }

  function renderPlatforms() {
    if (!state) {
      platformsEl.innerHTML = '<p class="ka-empty">连上保活服务后，这里显示各平台的状态。</p>';
      $('ka-add').hidden = true;
      return;
    }
    // A control that has focus keeps it across the re-render a state push causes.
    const focused = document.activeElement?.closest?.('.ka-card[data-id]');
    const focusKey = focused ? [focused.dataset.id, document.activeElement.dataset.act] : null;
    platformsEl.innerHTML = state.platforms.length
      ? state.platforms.map(renderPlatform).join('')
      : '<p class="ka-empty">还没有平台。点“添加平台”，从微信视频号开始。</p>';
    if (focusKey) {
      platformsEl.querySelector(`.ka-card[data-id="${CSS.escape(focusKey[0])}"] [data-act="${focusKey[1]}"]`)?.focus();
    }
    $('ka-add').hidden = false;
    $('ka-add').disabled = !connected();
  }

  const beats = [];
  const PROBE_STALE_MS = 25000;

  function latestBeat() {
    const stamps = (state?.platforms || []).map((item) => item.status?.last_heartbeat_at).filter(Boolean);
    return stamps.length ? Math.max(...stamps) : 0;
  }

  function probeDown() {
    if (link.state === 'offline') return true;
    if (link.state !== 'connected') return false;
    const latest = Math.max(latestBeat(), beats[beats.length - 1] || 0);
    if (!latest) return false;
    return Date.now() - latest > PROBE_STALE_MS;
  }

  function noteBeat() {
    const latest = latestBeat();
    if (!latest) return;
    const prev = beats[beats.length - 1] || 0;
    if (latest - prev > 500) beats.push(latest);
    if (beats.length > 24) beats.splice(0, beats.length - 24);
  }

  function paintTimes(times) {
    document.querySelectorAll('#ka-heart [data-beat]').forEach((slot, index) => {
      slot.textContent = times[index] ? clock(times[index]) : '';
    });
  }

  // Spikes peak at these x positions in the 600-wide trace, 200 apart.
  // The flat tail after the third peak plus the lead-in to the next peak is
  // also 200, so one steady horizontal speed makes the restart meet the next beat.
  const ECG_VIEW = 600;
  const ECG_PEAK_SPAN = 400;
  let sweep = null;
  let heartRunning = false;
  let heartFrame = 0;

  function reveal() {
    return document.querySelector('.ka-ecg-reveal');
  }

  function setReveal(x) {
    const rect = reveal();
    if (rect) rect.setAttribute('width', String(Math.max(0, Math.min(ECG_VIEW, x))));
  }

  function beginSweep(times, start) {
    const span = Math.max(1000, times[2] - times[0]);
    sweep = { times, start, duration: span * (ECG_VIEW / ECG_PEAK_SPAN) };
  }

  function advanceSweep(now) {
    let guard = 0;
    while (sweep && now - sweep.start >= sweep.duration && guard < 50) {
      guard += 1;
      const boundary = sweep.start + sweep.duration;
      if (beats.length >= 3) beginSweep(beats.splice(0, 3), boundary);
      else sweep = { ...sweep, start: boundary };
    }
  }

  function stopHeart() {
    heartRunning = false;
    if (heartFrame) cancelAnimationFrame(heartFrame);
    heartFrame = 0;
    const heart = $('ka-heart');
    if (heart) heart.dataset.state = 'down';
  }

  function stepHeart(now) {
    const heart = $('ka-heart');
    if (!heart) return;
    if (probeDown()) {
      stopHeart();
      return;
    }
    if (!sweep) {
      if (beats.length < 3) {
        heart.dataset.state = 'hold';
        paintTimes(beats.slice(-3));
        setReveal(0);
        return;
      }
      beginSweep(beats.splice(0, 3), now);
    }
    advanceSweep(now);
    heart.dataset.state = 'run';
    paintTimes(sweep.times);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const x = reduced ? ECG_VIEW : ((now - sweep.start) / sweep.duration) * ECG_VIEW;
    setReveal(x);
  }

  function kickHeart() {
    if (heartRunning || probeDown()) return;
    heartRunning = true;
    const loop = () => {
      heartFrame = 0;
      if (!heartRunning) return;
      stepHeart(Date.now());
      if (heartRunning) heartFrame = requestAnimationFrame(loop);
    };
    heartFrame = requestAnimationFrame(loop);
  }

  function connectionLabel(shown) {
    if (shown === 'stale' || shown === 'offline') return '未连接';
    if (shown === 'connected') return '已连接';
    return '正在连接…';
  }

  function shownLinkState() {
    if (link.state === 'offline' || probeDown()) return link.state === 'offline' ? 'offline' : 'stale';
    return link.state;
  }

  function renderLink() {
    const port = servicePort();
    const pid = servicePid();
    const shown = shownLinkState();
    linkEl.dataset.state = shown;
    linkEl.innerHTML = `
      <span class="ka-conn" data-state="${escapeHtml(shown)}"><i></i>${escapeHtml(connectionLabel(shown))}</span>
      <span>CDP 端口 ${port ? escapeHtml(port) : '—'}</span>
      <span>进程 ${pid ? escapeHtml(pid) : '—'}</span>`;
  }

  function render() {
    noteBeat();
    renderLink();
    renderPlatforms();
    kickHeart();
  }

  function applyState(next) {
    state = next;
    render();
  }

  function replacePlatform(platform) {
    if (!state || !platform) return;
    const index = state.platforms.findIndex((item) => item.platform_id === platform.platform_id);
    if (index >= 0) state.platforms[index] = platform;
    else state.platforms.push(platform);
  }

  // ---- operations ----

  async function runOp(platformId, op, payload) {
    pending.set(platformId, op);
    render();
    const result = await window.keepalive.op(op, platformId, payload);
    pending.delete(platformId);
    if (result.ok) replacePlatform(result.platform);
    else toast(result.error || '操作没成功', 'bad');
    render();
    return result;
  }

  function reportCheck(result) {
    if (!result.ok) return;
    const detection = result.detection || {};
    const why = result.platform?.status.session?.reason_text || detection.reason;
    if (detection.reason === 'no_script') toast('没有可用的保活脚本，判断不了登录状态');
    else if (detection.status === 'alive') toast('检测结果：已登录');
    else if (detection.status === 'logged_out') toast(`检测结果：已掉线，${why}`, 'bad');
    else toast(`没判断出登录状态：${why}`);
  }

  platformsEl.addEventListener('change', (event) => {
    const input = event.target.closest('input[data-act]');
    if (!input) return;
    const id = input.closest('.ka-card').dataset.id;
    if (input.dataset.act === 'chrome') void runOp(id, 'chrome', { on: input.checked });
    if (input.dataset.act === 'pause') void runOp(id, 'pause', { paused: input.checked });
  });

  platformsEl.addEventListener('click', (event) => {
    const toggle = event.target.closest('.ka-card-toggle');
    if (toggle) {
      expandedId = toggle.closest('.ka-card').dataset.id;
      renderPlatforms();
      platformsEl.querySelector(`.ka-card[data-id="${CSS.escape(expandedId)}"] .ka-card-toggle`)?.focus();
      return;
    }
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const id = button.closest('.ka-card').dataset.id;
    if (button.dataset.act === 'check') void runOp(id, 'check').then(reportCheck);
    if (button.dataset.act === 'edit') openDialog(state.platforms.find((item) => item.platform_id === id));
  });

  platformsEl.addEventListener('toggle', (event) => {
    const details = event.target.closest?.('.ka-events');
    if (!details) return;
    const id = details.closest('.ka-card').dataset.id;
    if (details.open) openEventLists.add(id);
    else openEventLists.delete(id);
  }, true);

  // ---- server address and the shared CDP port ----

  function servicePort() {
    if (state?.server?.cdp_port) return state.server.cdp_port;
    const live = (state?.platforms || []).find((item) => item.status?.cdp_port);
    return live?.status?.cdp_port || '';
  }

  function servicePid() {
    const platforms = state?.platforms || [];
    const live = platforms.find((item) => item.status?.browser_alive && item.status?.chrome_pid);
    return live?.status?.chrome_pid || '';
  }

  function linkError(text) {
    const error = $('ka-link-error');
    error.textContent = text || '';
    error.hidden = !text;
  }

  function openLinkDialog() {
    $('ka-link-url').value = $('ka-server-url').value;
    $('ka-link-port').value = servicePort();
    linkError('');
    $('ka-link-dialog').showModal();
  }

  $('ka-server-form').addEventListener('submit', (event) => {
    event.preventDefault();
    openLinkDialog();
  });
  $('ka-server-connect').addEventListener('click', openLinkDialog);
  $('ka-link-cancel').addEventListener('click', () => $('ka-link-dialog').close());
  $('ka-link-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('ka-link-save');
    button.disabled = true;
    linkError('');
    const result = await window.keepalive.setServer($('ka-link-url').value);
    if (!result.ok) {
      button.disabled = false;
      linkError(result.error || '没保存成功');
      return;
    }
    applyBoot(result);
    const port = Number($('ka-link-port').value);
    // setServer reconnects the socket, so link.state can still be "connecting"
    // after the state request has already succeeded. Gate on that request.
    if (result.state?.ok && port) {
      const saved = await window.keepalive.op('settings.cdp', '', { cdp_port: port });
      if (!saved.ok) {
        button.disabled = false;
        linkError(saved.error || 'CDP 端口没保存成功');
        return;
      }
      if (saved.cdp_port && state?.server) {
        state.server.cdp_port = saved.cdp_port;
        render();
      }
    }
    button.disabled = false;
    $('ka-link-dialog').close();
  });

  function applyBoot(result) {
    $('ka-server-url').value = result.serverUrl || '';
    link = result.link;
    state = result.state?.ok ? result.state : null;
    if (!state && result.state?.error && link.state !== 'connected') {
      link = { state: 'offline', error: result.state.error };
    }
    render();
  }

  // ---- platform dialog ----

  const field = (name) => $(`ka-f-${name}`);

  function fillTypeOptions(current) {
    const presets = state?.presets || {};
    const options = Object.values(presets).map((preset) => [preset.platform_type, preset.name]);
    if (current && !presets[current] && current !== 'custom') options.push([current, current]);
    options.push(['custom', '其他平台']);
    field('type').innerHTML = options
      .map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('');
    field('type').value = current || options[0][0];
  }

  function fillFromPreset() {
    const preset = state?.presets?.[field('type').value];
    field('id').value = preset?.platform_id || '';
    field('name').value = preset?.name || '';
    field('url').value = preset?.entry_url || '';
    field('interval').value = preset?.keep_alive.interval_minutes ?? 15;
    field('jitter').value = preset?.keep_alive.jitter_minutes ?? 3;
  }

  function openDialog(platform) {
    editingId = platform ? platform.platform_id : null;
    deleteArmed = false;
    $('ka-dialog-title').textContent = platform ? `编辑 ${platform.name}` : '添加平台';
    fillTypeOptions(platform?.platform_type);
    field('type').disabled = Boolean(platform);
    field('id').readOnly = Boolean(platform);
    field('delete').hidden = !platform;
    field('delete').textContent = '删除平台';
    field('error').hidden = true;
    if (platform) {
      field('id').value = platform.platform_id;
      field('name').value = platform.name;
      field('url').value = platform.entry_url;
      field('profile').value = platform.profile_dir;
      field('interval').value = platform.keep_alive.interval_minutes;
      field('jitter').value = platform.keep_alive.jitter_minutes;
      field('lock').value = platform.lock_ttl_minutes;
      field('args').value = platform.chrome_args.join(' ');
      field('restart').checked = platform.auto_restart;
      field('enabled').checked = platform.enabled;
    } else {
      fillFromPreset();
      field('profile').value = '';
      field('lock').value = 10;
      field('args').value = '';
      field('restart').checked = true;
      field('enabled').checked = true;
    }
    dialog.showModal();
    (platform ? field('name') : field('id')).focus();
  }

  function dialogError(text) {
    field('error').textContent = text;
    field('error').hidden = false;
  }

  field('type').addEventListener('change', () => {
    if (!editingId) fillFromPreset();
  });
  field('cancel').addEventListener('click', () => dialog.close());
  $('ka-add').addEventListener('click', () => openDialog(null));

  $('ka-platform-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      platform_id: field('id').value.trim(),
      platform_type: field('type').value,
      name: field('name').value.trim(),
      entry_url: field('url').value.trim(),
      profile_dir: field('profile').value.trim(),
      keep_alive: {
        interval_minutes: Number(field('interval').value),
        jitter_minutes: Number(field('jitter').value),
      },
      lock_ttl_minutes: Number(field('lock').value),
      chrome_args: field('args').value.trim(),
      auto_restart: field('restart').checked,
      enabled: field('enabled').checked,
    };
    field('save').disabled = true;
    const result = editingId
      ? await window.keepalive.op('platform.update', editingId, payload)
      : await window.keepalive.op('platform.create', '', payload);
    field('save').disabled = false;
    if (!result.ok) {
      dialogError(result.error || '没保存成功');
      return;
    }
    replacePlatform(result.platform);
    dialog.close();
    render();
    toast(editingId ? '已保存' : '平台已添加。打开「保活页面」开始使用');
  });

  document.getElementById('ka-docs').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-doc]');
    if (!button) return;
    button.disabled = true;
    const result = await window.keepalive.saveGuide(button.dataset.doc);
    button.disabled = false;
    if (!result || result.canceled) return;
    if (!result.ok) {
      toast(result.error || '没保存成功', 'bad');
      return;
    }
    toast(`已保存到 ${result.path}`);
  });

  field('delete').addEventListener('click', async () => {
    if (!deleteArmed) {
      deleteArmed = true;
      field('delete').textContent = '再点一次确认删除';
      return;
    }
    field('delete').disabled = true;
    const result = await window.keepalive.op('platform.delete', editingId);
    field('delete').disabled = false;
    if (!result.ok) {
      dialogError(result.error || '没删除成功');
      return;
    }
    state.platforms = state.platforms.filter((item) => item.platform_id !== editingId);
    dialog.close();
    render();
    toast('平台已删除。沙盒目录里的登录数据还留在服务器上');
  });

  // ---- start ----

  window.keepalive.onRelay((payload) => {
    relayStatus.set(payload.platformId, payload);
    render();
  });
  window.keepalive.onState(applyState);
  window.keepalive.onLink((next) => {
    link = next;
    render();
  });
  render();
  setInterval(() => {
    document.querySelectorAll('.ka-lock-count[data-expires]').forEach((el) => {
      el.textContent = formatRemain(Number(el.dataset.expires) - Date.now());
    });
    const heart = $('ka-heart');
    const mark = (stateName) => {
      linkEl.dataset.state = stateName;
      const conn = linkEl.querySelector('.ka-conn');
      if (!conn) return;
      conn.dataset.state = stateName;
      const text = [...conn.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
      const label = connectionLabel(stateName);
      if (text) text.nodeValue = label;
      else conn.append(label);
    };
    if (probeDown()) {
      if (heart && heart.dataset.state !== 'down') stopHeart();
      const next = link.state === 'offline' ? 'offline' : 'stale';
      if (linkEl.dataset.state !== next) mark(next);
      return;
    }
    if (heart?.dataset.state === 'down') kickHeart();
    if (link.state === 'connected' && linkEl.dataset.state !== 'connected') mark('connected');
  }, 1000);
  window.keepalive.boot().then(applyBoot);
})();
