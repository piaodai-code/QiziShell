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

  /** 13:02:11 today, 11-18 13:02 on another day. */
  function clock(ms, { seconds = true } = {}) {
    if (!ms) return '';
    const date = new Date(ms);
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}${seconds ? `:${pad(date.getSeconds())}` : ''}`;
    if (date.toDateString() === new Date().toDateString()) return time;
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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

  function headline(platform) {
    const s = platform.status;
    if (!platform.enabled) return ['off', '已停用'];
    if (s.transition === 'starting') return ['busy', '正在启动'];
    if (s.transition === 'stopping') return ['busy', '正在关闭'];
    if (!s.browser_alive) return s.chrome_on ? ['bad', 'Chrome 没在运行'] : ['off', '已停止'];
    if (s.awaiting_login) return ['bad', '需重新登录'];
    if (s.activity === 'keepalive') return ['busy', '正在保活'];
    if (s.activity === 'check') return ['busy', '正在检测'];
    if (s.script.state === 'missing') return ['warn', '缺保活脚本'];
    if (s.script.state === 'invalid') return ['warn', '保活脚本有错误'];
    if (!s.session) return ['off', '等待检测'];
    if (s.session.status === 'alive') return s.paused ? ['warn', '已登录，保活暂停'] : ['ok', '已登录'];
    return ['warn', '登录状态未知'];
  }

  function alertOf(platform) {
    const s = platform.status;
    if (s.browser_alive && s.awaiting_login) {
      return ['bad', `掉线了：${s.session?.reason_text || '原因未知'}。保活点击已停，重新登录后自动恢复。`];
    }
    if (s.chrome_error && !s.transition) {
      const retry = s.chrome_on && platform.auto_restart ? '稍后自动重试。' : '';
      return ['bad', `${s.chrome_error}。${retry}`];
    }
    if (s.script.state === 'invalid') return ['warn', `保活脚本有错误，没有执行：${s.script.error}`];
    return null;
  }

  function sessionFact(platform) {
    const s = platform.status;
    if (!s.browser_alive) return '—';
    if (s.script.state !== 'ok') return '没有可用的保活脚本，判断不了';
    if (!s.session) return '还没检测';
    const label = { alive: '已登录', logged_out: '已掉线', unknown: '没判断出来' }[s.session.status] || s.session.status;
    return `${label}（${escapeHtml(s.session.reason_text)}），${clock(s.session.checked_at)} 检测`;
  }

  function lastKeepaliveFact(last) {
    if (!last) return '还没有';
    const at = clock(last.at);
    if (last.result === 'ok') return `${at} 完成，共 ${last.steps.length} 步`;
    if (last.result === 'skipped_locked') return `${at} 跳过：${escapeHtml(last.lock_owner)} 正在占用`;
    if (last.result === 'no_script') return `${at} 没执行：没有可用的保活脚本`;
    if (last.result === 'action_failed') {
      const broken = last.steps.find((step) => !step.ok && !step.skipped);
      return `${at} 第 ${broken.index + 1} 步没做成：${escapeHtml(broken.error)}`;
    }
    return `${at} 出错：${escapeHtml(last.error)}`;
  }

  function nextKeepaliveFact(platform) {
    const s = platform.status;
    if (!s.browser_alive) return '—';
    if (s.awaiting_login) return '重新登录后恢复';
    if (s.paused) return '已暂停';
    if (s.script.state !== 'ok') return '等保活脚本';
    if (!s.next_keepalive_at) return '—';
    const jitter = platform.keep_alive.jitter_minutes;
    return `${clock(s.next_keepalive_at, { seconds: false })}${s.lock ? '，占用中则跳过' : ''}`
      + `（每 ${platform.keep_alive.interval_minutes} 分钟${jitter ? `，前后漂移 ${jitter} 分钟` : ''}）`;
  }

  function lockFact(platform) {
    const lock = platform.status.lock;
    if (!lock) return `无（占用后 ${platform.lock_ttl_minutes} 分钟自动解除）`;
    const reason = lock.reason ? `，${escapeHtml(lock.reason)}` : '';
    return `${escapeHtml(lock.owner)} 占用中${reason}，${clock(lock.expires_at, { seconds: false })} 自动解除`;
  }

  function scriptFact(platform) {
    const script = platform.status.script;
    if (script.state === 'ok') return '已就绪';
    if (script.state === 'invalid') return '有错误';
    return `还没有。由 Agent 制作后放到服务器上的 <code>${escapeHtml(state.server.scripts_dir)}/${escapeHtml(platform.platform_id)}.json</code>`;
  }

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
    if (!s.chrome_on || s.paused) return '';
    const scriptReady = s.script && s.script.state === 'ok';
    const linked = link.state === 'connected' && s.browser_alive;
    const sessionAlive = s.session && s.session.status === 'alive';
    const keepFailed = Boolean(
      s.awaiting_login
      || (s.session && s.session.status !== 'alive')
      || (s.last_keepalive && (s.last_keepalive.result === 'action_failed' || s.last_keepalive.result === 'error')),
    );
    if (linked && scriptReady && sessionAlive && !keepFailed) return 'ok';
    if (linked && scriptReady && keepFailed) return 'lost';
    return 'warn';
  }

  function renderPlatform(platform) {
    const s = platform.status;
    const id = platform.platform_id;
    const lamp = lampOf(platform);
    const [tone, text] = headline(platform);
    const alert = alertOf(platform);
    const busy = pending.has(id) || Boolean(s.transition);
    const locked = !connected() || busy;
    const shownPort = s.cdp_port || platform.cdp_port;
    const browser = s.browser_alive
      ? `运行中，CDP 端口 ${shownPort}${s.shared_window ? '（各平台共用）' : ''}${s.chrome_pid ? `，进程 ${s.chrome_pid}` : ''}`
      : `没在运行，CDP 端口 ${shownPort}`;
    const facts = [
      ['浏览器', browser],
      ['登录状态', sessionFact(platform)],
      ['最后心跳', s.last_heartbeat_at ? clock(s.last_heartbeat_at) : '—'],
      ['上次保活', lastKeepaliveFact(s.last_keepalive)],
      ['下次保活', nextKeepaliveFact(platform)],
      ['占用锁', lockFact(platform)],
      ['保活脚本', scriptFact(platform)],
      ['掉线通知', noticeFact(platform)],
    ];
    const events = s.events.map((event) => `<li><time>${clock(event.at)}</time><span>${escapeHtml(event.text)}</span></li>`).join('');
    const chromeOff = locked || !platform.enabled;
    return `
      <article class="ka-card${platform.enabled ? '' : ' is-disabled'}" data-id="${escapeHtml(id)}">
        <header class="ka-card-head">
          <div class="ka-card-title"><span class="ka-lamp" data-state="${lamp}" title="${lamp === 'ok' ? '保活正常' : lamp === 'lost' ? '保活失败' : lamp === 'warn' ? '还不能保活' : ''}" ${lamp ? '' : 'hidden'}></span><strong>${escapeHtml(platform.name)}</strong><span class="ka-id">${escapeHtml(id)}</span></div>
          <span class="ka-badge" data-tone="${tone}">${text}</span>
          <button type="button" class="ka-text-btn" data-act="edit">编辑</button>
        </header>
        ${alert ? `<p class="ka-alert" data-tone="${alert[0]}">${escapeHtml(alert[1])}</p>` : ''}
        <dl class="ka-facts">${facts.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join('')}</dl>
        <div class="ka-controls">
          <label class="ka-switch${chromeOff ? ' is-off' : ''}">
            <input type="checkbox" data-act="chrome" ${s.chrome_on ? 'checked' : ''} ${chromeOff ? 'disabled' : ''}>
            <span class="ka-switch-track"></span>沙盒 Chrome
          </label>
          <label class="ka-switch${locked ? ' is-off' : ''}">
            <input type="checkbox" data-act="pause" ${s.paused ? 'checked' : ''} ${locked ? 'disabled' : ''}>
            <span class="ka-switch-track"></span>暂停保活
          </label>
          <button type="button" class="ka-btn" data-act="check" ${locked || !s.browser_alive ? 'disabled' : ''}>立即检测</button>
        </div>
        <details class="ka-events" ${openEventLists.has(id) ? 'open' : ''}>
          <summary>最近记录</summary>
          <ol>${events || '<li><span>还没有记录</span></li>'}</ol>
        </details>
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

  function channelFact() {
    const notify = state?.notify;
    if (!notify?.hermes_url) return '';
    if (notify.reachable === true) return '通知通道正常';
    if (notify.reachable === false) return `通知通道坏了：${notify.last_error || '发送失败'}`;
    return '通知通道还没发过';
  }

  function renderLink() {
    linkEl.dataset.state = link.state;
    const channel = channelFact();
    if (link.state === 'connected') {
      const base = state ? `已连接，保活服务 ${state.server.version}` : '已连接';
      linkEl.textContent = channel ? `${base}。${channel}` : base;
    } else if (link.state === 'offline') {
      linkEl.textContent = `${link.error}${state ? '。下面是断开前的状态' : ''}`;
    } else {
      linkEl.textContent = '正在连接…';
    }
  }

  function render() {
    renderLink();
    renderPlatforms();
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

  // ---- server address ----

  $('ka-server-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('ka-server-connect');
    button.disabled = true;
    const result = await window.keepalive.setServer($('ka-server-url').value);
    button.disabled = false;
    if (!result.ok) {
      toast(result.error, 'bad');
      return;
    }
    applyBoot(result);
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
    field('port').value = preset?.cdp_port || '';
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
      field('port').value = platform.cdp_port;
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
      cdp_port: Number(field('port').value),
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
    toast(editingId ? '已保存' : '平台已添加。打开“沙盒 Chrome”开始使用');
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
  window.keepalive.boot().then(applyBoot);
})();
