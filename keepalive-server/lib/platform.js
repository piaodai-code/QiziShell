'use strict';

const fs = require('fs');
const chrome = require('./chrome');
const { loadScript } = require('./script');
const { visit, keepaliveBudgetMs } = require('./session');
const { InputError } = require('./store');

const HEARTBEAT_MS = 10000;
const MISSES_BEFORE_DEAD = 2;
const FIRST_CHECK_DELAY_MS = 15000;
const LOGGED_OUT_RECHECK_MS = 60000;
const CHECK_TIMEOUT_MS = 60000;
const TROUBLE_ROUNDS = 3;
const MAX_EVENTS = 40;
const RESTART_BACKOFF_MS = [5000, 15000, 30000, 60000, 300000];

const REASON_TEXT = {
  login_url: '页面跳到了登录地址',
  api_auth_failed: '平台接口返回未登录',
  logout_text: '页面出现登录或扫码文案',
  login_qr: '页面出现登录二维码',
  url_mismatch: '页面不在后台地址上',
  no_alive_signal: '没看到后台页面的特征',
  no_platform_tab: '没有这个平台的页签',
  alive_ui_matched: '看到了后台页面的特征',
};

function reasonText(reason) {
  return REASON_TEXT[reason] || reason || '';
}

function firstLine(err) {
  return String(err?.message || err || '').split('\n')[0];
}

function systemClock(ms) {
  const sec = Math.floor(Number(ms) / 1000);
  if (!Number.isFinite(sec)) return '';
  try {
    return require('child_process').execFileSync('/bin/date', ['-r', String(sec), '+%H:%M:%S'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** One platform: its sandbox Chrome, its keep-alive timer, its lock and its login state. */
class PlatformRuntime {
  constructor(config, ctx) {
    this.config = config;
    this.ctx = ctx;
    const saved = ctx.store.platformState(config.platform_id);
    this.chromeOn = saved.chrome_on;
    this.paused = saved.paused;
    this.lockInfo = saved.lock;
    // Chrome that should be on is brought up once at boot even when auto-restart is off.
    this.bootStartPending = this.chromeOn;

    this.browserAlive = false;
    this.chromePid = null;
    this.chromeError = '';
    this.transition = '';
    this.activity = '';
    this.probeMisses = 0;
    this.lastProbeAt = 0;
    this.lastHeartbeatAt = 0;
    this.restartAttempts = 0;
    this.nextRestartAt = 0;

    this.script = { state: 'missing', script: null, error: '' };
    this.scriptStamp = '';
    this.session = null;
    this.awaitingLogin = false;
    this.lastKeepalive = null;
    this.nextKeepaliveAt = 0;
    this.checkDueAt = 0;
    this.troubleRounds = 0;
    this.troubleNotified = false;
    this.notice = { kind: '', state: 'idle', at: 0, error: '' };
    this.noticeRetryAt = 0;

    this.events = [];
    this.queue = Promise.resolve();
    this.queued = 0;
  }

  get id() {
    return this.config.platform_id;
  }

  // ---- bookkeeping ----

  persist() {
    this.ctx.store.savePlatformState(this.id, {
      chrome_on: this.chromeOn,
      paused: this.paused,
      lock: this.lockInfo,
    });
  }

  note(text) {
    this.events.unshift({ at: Date.now(), text });
    if (this.events.length > MAX_EVENTS) this.events.length = MAX_EVENTS;
    this.ctx.log(`[${this.id}] ${text}`);
    this.ctx.changed();
  }

  /** Runs one operation at a time, so Chrome start/stop, keep-alive rounds, checks and lock changes never overlap. */
  enqueue(fn) {
    this.queued += 1;
    const task = this.queue.then(fn);
    this.queue = task.catch(() => {}).finally(() => { this.queued -= 1; });
    return task;
  }

  scheduleNext(now = Date.now()) {
    const { interval_minutes: interval, jitter_minutes: jitter } = this.config.keep_alive;
    const minutes = interval + (Math.random() * 2 - 1) * jitter;
    this.nextKeepaliveAt = now + Math.round(minutes * 60000);
  }

  refreshScript() {
    const file = this.ctx.store.scriptPath(this.id);
    let stamp = 'missing';
    try {
      const stat = fs.statSync(file);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      // no script yet
    }
    if (stamp === this.scriptStamp) return;
    const first = this.scriptStamp === '';
    this.scriptStamp = stamp;
    this.script = loadScript(file);
    if (this.script.state === 'ok') {
      this.troubleRounds = 0;
      this.troubleNotified = false;
      this.note(first ? '已读到保活脚本' : '保活脚本已更新，下一轮起生效');
    } else if (this.script.state === 'invalid') {
      this.note(`保活脚本有错误，本轮不执行：${this.script.error}`);
    } else if (!first) {
      this.note('保活脚本被移走了，保活停下');
    }
  }

  // ---- Chrome process ----

  async setChrome(on) {
    if (on && !this.config.enabled) throw new InputError('这个平台已停用，先在“编辑”里启用', 409);
    this.chromeOn = on;
    this.bootStartPending = false;
    this.restartAttempts = 0;
    this.nextRestartAt = 0;
    this.persist();
    await this.enqueue(() => (on ? this.startChrome('manual') : this.stopChrome()));
    const label = this.config.browser === 'shell' ? '保活窗口' : '沙盒 Chrome';
    if (on && !this.browserAlive) throw new InputError(this.chromeError || `${label}没启动起来`, 502);
  }

  async startChrome(why) {
    this.transition = 'starting';
    this.ctx.changed();
    try {
      const shell = this.config.browser === 'shell';
      const started = shell
        ? await chrome.startShell({
          dataDir: this.ctx.store.dataDir,
          port: chrome.shellDebugPort() || this.ctx.store.cdpPort,
          entryUrl: this.config.entry_url,
          name: this.config.name,
          platformId: this.config.platform_id,
        })
        : await chrome.start({
          binary: chrome.findChromeBinary(this.ctx.store.chromePath),
          port: this.config.cdp_port,
          profileDir: this.config.profile_dir,
          entryUrl: this.config.entry_url,
          extraArgs: this.config.chrome_args,
        });
      const now = Date.now();
      this.chromePid = started.pid;
      this.browserAlive = true;
      this.chromeError = '';
      this.probeMisses = 0;
      this.restartAttempts = 0;
      this.lastHeartbeatAt = now;
      this.lastProbeAt = now;
      // --restore-last-session puts the previous small window back after the
      // process is up. Size it only once that restore has finished.
      if (!shell) {
        if (!started.adopted) await chrome.sleep(1500);
        await chrome.settleEntryTab(this.config.cdp_port, this.config.entry_url, { closeExtras: !started.adopted })
          .catch((err) => this.note(`入口页签没开成：${firstLine(err)}`));
        await chrome.ensureWindowSize(this.config.cdp_port)
          .catch((err) => this.note(`窗口没拉开：${firstLine(err)}`));
      }
      this.checkDueAt = Date.now() + FIRST_CHECK_DELAY_MS;
      this.scheduleNext();
      const label = this.config.browser === 'shell' ? '保活窗口' : '沙盒 Chrome';
      if (started.adopted) this.note(`接管了已在运行的${label}`);
      else this.note(why === 'auto' ? `${label}已自动重启` : `${label}已启动`);
    } catch (err) {
      this.browserAlive = false;
      const message = firstLine(err);
      const repeated = message === this.chromeError && message.includes('内置浏览器');
      this.chromeError = message;
      const base = RESTART_BACKOFF_MS[Math.min(this.restartAttempts, RESTART_BACKOFF_MS.length - 1)];
      const wait = message.includes('内置浏览器') ? Math.max(60000, base) : base;
      this.restartAttempts += 1;
      this.nextRestartAt = Date.now() + wait;
      if (!repeated) this.note(`${this.config.browser === 'shell' ? '保活窗口' : '沙盒 Chrome'}启动失败：${this.chromeError}`);
    } finally {
      this.transition = '';
      this.ctx.changed();
    }
  }

  async stopChrome() {
    this.transition = 'stopping';
    this.ctx.changed();
    try {
      if (this.config.browser === 'shell') {
        await chrome.closeShellTab(this.config.platform_id);
        await chrome.stopShellIfEmpty();
        this.note('这个平台的保活页已从窗口拿掉');
      } else {
        await chrome.stop({
          port: this.config.cdp_port,
          profileDir: chrome.runtimeProfile(this.config.profile_dir, this.config.browser),
          pid: this.chromePid,
        });
        this.note('沙盒 Chrome 已关闭');
      }
      this.chromeError = '';
    } catch (err) {
      this.chromeError = firstLine(err);
      this.note(`沙盒 Chrome 没关掉：${this.chromeError}`);
    } finally {
      this.browserAlive = this.config.browser === 'shell'
        ? await chrome.shellTabReady(this.config.platform_id, this.config.entry_url)
        : Boolean(await chrome.probe(this.config.cdp_port));
      if (!this.browserAlive) this.chromePid = null;
      this.session = null;
      this.awaitingLogin = false;
      this.notice = { kind: '', state: 'idle', at: 0, error: '' };
      this.nextKeepaliveAt = 0;
      this.checkDueAt = 0;
      this.transition = '';
      this.ctx.changed();
    }
  }

  async heartbeat(now) {
    this.lastProbeAt = now;
    if (this.config.browser === 'shell') {
      const hasTab = await chrome.shellHasTab(this.config.platform_id);
      if (hasTab) {
        this.browserAlive = await chrome.shellTabReady(this.config.platform_id, this.config.entry_url);
        this.chromePid = this.chromePid || null;
        this.chromeError = '';
        this.probeMisses = 0;
        this.lastHeartbeatAt = now;
        this.ctx.changed();
        return;
      }
      this.browserAlive = false;
      this.probeMisses += 1;
      this.lastHeartbeatAt = now;
      if (this.chromeOn && this.probeMisses >= 2 && !this.transition && this.queued === 0 && now >= (this.nextRestartAt || 0)) {
        this.enqueue(() => this.startChrome('auto')).catch(() => {});
      }
      this.ctx.changed();
      return;
    }
    const answered = Boolean(await chrome.probe(this.config.cdp_port));
    if (answered) {
      if (!this.browserAlive) {
        // The port answering is not enough: it has to be this sandbox's Chrome,
        // not some other Chrome that happens to debug on the same port.
        const pid = await chrome.ownerPid(
          this.config.cdp_port,
          chrome.runtimeProfile(this.config.profile_dir, this.config.browser),
        );
        if (!pid) return;
        this.browserAlive = true;
        this.chromePid = pid;
        this.chromeError = '';
        this.bootStartPending = false;
        this.note(this.config.browser === 'shell' ? '接管了已在运行的保活窗口' : '接管了已在运行的沙盒 Chrome');
      }
      this.probeMisses = 0;
      this.lastHeartbeatAt = now;
      this.ctx.changed();
      return;
    }
    this.probeMisses += 1;
    // One slow answer from a busy Chrome is not a crash.
    if (!this.browserAlive || this.probeMisses < MISSES_BEFORE_DEAD) return;
    this.browserAlive = false;
    this.chromePid = null;
    this.session = null;
    this.nextKeepaliveAt = 0;
    this.checkDueAt = 0;
    if (this.chromeOn) {
      this.chromeError = '沙盒 Chrome 进程不在了';
      this.nextRestartAt = now;
      this.note(this.config.auto_restart
        ? '沙盒 Chrome 进程不在了（崩溃或被手动关掉），准备自动重启'
        : '沙盒 Chrome 进程不在了（崩溃或被手动关掉）。自动重启已关，需要手动打开');
    }
    this.ctx.changed();
  }

  // ---- timer ----

  async tick(now) {
    if (this.lockInfo && now >= this.lockInfo.expires_at) {
      const owner = this.lockInfo.owner;
      this.lockInfo = null;
      this.persist();
      this.note(`${owner} 的占用锁到期，自动解除`);
    }
    this.refreshScript();
    if (!this.transition && now - this.lastProbeAt >= HEARTBEAT_MS) await this.heartbeat(now);
    if (this.transition || this.queued > 0) return;
    if (!this.config.enabled || !this.chromeOn) return;

    if (!this.browserAlive) {
      const due = this.bootStartPending || (this.config.auto_restart && now >= this.nextRestartAt);
      if (!due) return;
      const why = this.bootStartPending ? 'boot' : 'auto';
      this.bootStartPending = false;
      this.enqueue(() => this.startChrome(why)).catch(() => {});
      return;
    }

    if (!this.nextKeepaliveAt) {
      this.scheduleNext(now);
      if (!this.checkDueAt) this.checkDueAt = now + FIRST_CHECK_DELAY_MS;
    }
    if (this.checkDueAt && now >= this.checkDueAt) {
      this.checkDueAt = 0;
      this.enqueue(() => this.runCheck('自动检测')).catch(() => {});
      return;
    }
    if (this.awaitingLogin) {
      if (now - (this.session?.checked_at || 0) >= LOGGED_OUT_RECHECK_MS) {
        this.enqueue(() => this.runCheck('等待登录')).catch(() => {});
      }
      return;
    }
    if (!this.paused && now >= this.nextKeepaliveAt) {
      this.enqueue(() => this.runKeepalive('定时', {})).catch(() => {});
    }
  }

  // ---- visits ----

  requireBrowser() {
    if (!this.browserAlive) throw new InputError('沙盒 Chrome 没在运行，先打开它', 409);
  }

  /** Read-only: looks at the page, clicks nothing. */
  async runCheck(source) {
    this.requireBrowser();
    this.refreshScript();
    if (this.script.state !== 'ok') {
      this.session = null;
      this.ctx.changed();
      return { status: 'unknown', reason: 'no_script', url: '' };
    }
    this.activity = 'check';
    this.ctx.changed();
    try {
      const result = await visit({
        platform: this.config,
        script: this.script.script,
        mode: 'check',
        // While an agent holds the lock the tabs are its to manage.
        allowOpen: !this.lockInfo,
        timeoutMs: CHECK_TIMEOUT_MS,
      });
      await this.applyDetection(result.detection, source);
      return result.detection;
    } catch (err) {
      this.note(`检测没跑成：${firstLine(err)}`);
      throw new InputError(`检测没跑成：${firstLine(err)}`, 502);
    } finally {
      this.activity = '';
      this.ctx.changed();
    }
  }

  async runKeepalive(source, { owner }) {
    this.requireBrowser();
    const now = Date.now();
    if (this.lockInfo && this.lockInfo.owner !== owner) {
      this.lastKeepalive = { at: now, source, result: 'skipped_locked', lock_owner: this.lockInfo.owner };
      this.scheduleNext();
      this.note(`${this.lockInfo.owner} 正在占用，这一轮保活跳过`);
      return this.lastKeepalive;
    }
    this.refreshScript();
    if (this.script.state !== 'ok') {
      this.lastKeepalive = { at: now, source, result: 'no_script', error: this.script.error };
      this.scheduleNext();
      this.ctx.changed();
      return this.lastKeepalive;
    }
    const script = this.script.script;
    this.activity = 'keepalive';
    this.ctx.changed();
    const scheduled = source === '定时';
    try {
      const result = await visit({
        platform: this.config,
        script,
        mode: 'keepalive',
        allowOpen: true,
        timeoutMs: keepaliveBudgetMs(script),
      });
      const failed = !result.steps.ok;
      this.lastKeepalive = {
        at: Date.now(),
        source,
        result: failed ? 'action_failed' : 'ok',
        steps: result.steps.results,
        detection: result.detection,
      };
      const broken = result.steps.results.find((step) => !step.ok && !step.skipped);
      this.note(failed
        ? `保活动作没跑完：第 ${broken.index + 1} 步 ${broken.action} 失败（${broken.error}）`
        : `保活动作完成（${result.steps.results.length} 步）`);
      await this.applyDetection(result.detection, source);
      if (scheduled) await this.trackTrouble(failed, result.detection);
    } catch (err) {
      this.lastKeepalive = { at: Date.now(), source, result: 'error', error: firstLine(err) };
      this.note(`这一轮保活出错：${firstLine(err)}`);
      if (scheduled) await this.trackTrouble(true, null);
    } finally {
      this.activity = '';
      this.scheduleNext();
      this.ctx.changed();
    }
    return this.lastKeepalive;
  }

  async applyDetection(detection, source) {
    const previous = this.session?.status || '';
    this.session = { ...detection, reason_text: reasonText(detection.reason), checked_at: Date.now(), source };
    if (detection.status === 'logged_out') {
      if (this.awaitingLogin) return;
      this.awaitingLogin = true;
      this.note(`确认掉线：${reasonText(detection.reason)}。保活点击已停，等重新登录`);
      await this.sendNotice('logged_out');
      return;
    }
    if (detection.status === 'alive') {
      if (this.awaitingLogin) {
        this.awaitingLogin = false;
        this.notice = { kind: '', state: 'idle', at: 0, error: '' };
        this.scheduleNext();
        this.note('已重新登录，保活恢复');
      } else if (previous !== 'alive') {
        this.note('会话正常：已登录');
      }
      return;
    }
    if (previous !== 'unknown') this.note(`没判断出登录状态：${reasonText(detection.reason)}`);
  }

  /**
   * A script that keeps failing while the session is not logged out usually
   * means the page changed. The Maintainer is told once per streak so it can
   * rework the script.
   */
  async trackTrouble(failed, detection) {
    if (detection?.status === 'logged_out') return;
    if (!failed && detection?.status === 'alive') {
      this.troubleRounds = 0;
      this.troubleNotified = false;
      return;
    }
    this.troubleRounds += 1;
    if (this.troubleRounds >= TROUBLE_ROUNDS && !this.troubleNotified) {
      this.troubleNotified = true;
      await this.sendNotice('script_trouble');
    }
  }

  // ---- Maintainer notices ----

  noticeText(kind) {
    const api = `http://127.0.0.1:${this.ctx.store.listen.port}`;
    const title = `${this.config.name}（${this.id}）`;
    if (kind === 'logged_out') {
      return [
        `【Chrome Keep-alive】${title}掉线，请去重新登录。`,
        `判定依据：${reasonText(this.session?.reason)}${this.session?.detail ? `（${this.session.detail}）` : ''}`,
        `当前页面：${this.session?.url || '未知'}`,
        `保活窗口的 CDP 地址：http://127.0.0.1:${chrome.debugPort(this.config)}`,
        '登录前先占锁，登录完解锁。解锁后保活服务会自己检测并恢复保活。步骤见保活维护说明：',
        `GET ${api}/api/agent-guide/maintainer`,
        `POST ${api}/api/platforms/${this.id}/lock   {"owner":"maintainer"}`,
        `POST ${api}/api/platforms/${this.id}/unlock {"owner":"maintainer"}`,
      ].join('\n');
    }
    const last = this.lastKeepalive || {};
    const broken = (last.steps || []).find((step) => !step.ok && !step.skipped);
    let detail = last.error || '';
    if (broken) detail = `第 ${broken.index + 1} 步 ${broken.action}${broken.selector ? ` ${broken.selector}` : ''} 失败：${broken.error}`;
    else if (last.detection?.status === 'unknown') detail = `动作跑完了，但判断不出登录状态：${reasonText(last.detection.reason)}`;
    return [
      `【Chrome Keep-alive】${title}的保活脚本连续 ${this.troubleRounds} 轮没跑通，页面可能改版了。请对照现在的页面更新脚本。`,
      `最近一轮：${detail || '没有更多信息'}`,
      `保活维护说明：GET ${api}/api/agent-guide/maintainer`,
    ].join('\n');
  }

  /**
   * When this machine has a local Hermes address, deliver here. Otherwise leave
   * the notice pending so QiziShell can send it with the Maintainer it already
   * has. A failed local delivery stays failed for that same fallback.
   */
  async sendNotice(kind) {
    const text = this.noticeText(kind);
    this.notice = { kind, state: 'pending', at: Date.now(), error: '', text };
    const notifier = this.ctx.notifier;
    if (!notifier || !notifier.configured()) {
      this.note(kind === 'logged_out'
        ? '掉线消息待 QiziShell 用 Maintainer 的登录发出'
        : '脚本异常消息待 QiziShell 用 Maintainer 的登录发出');
      return;
    }
    try {
      await notifier.send(text);
      if (this.notice.kind !== kind) return;
      this.notice = { ...this.notice, state: 'sent', error: '' };
      this.note(kind === 'logged_out' ? '已通过本机 Hermes 发给 Maintainer' : '已通过本机 Hermes 发出脚本异常通知');
    } catch (err) {
      if (this.notice.kind !== kind) return;
      const message = String(err.message || err).split('\n')[0];
      const state = err.code === 'not_configured' ? 'not_configured' : 'failed';
      this.notice = { ...this.notice, state, error: message };
      this.note(`没从本机 Hermes 发出：${message}`);
    }
  }

  ackNotice(at) {
    if (!this.notice?.kind || Number(at) !== this.notice.at) return { acked: false };
    if (this.notice.state !== 'sent') {
      this.notice = { ...this.notice, state: 'sent', error: '' };
      this.note(this.notice.kind === 'logged_out' ? '已通过 Maintainer 发出重新登录通知' : '已通过 Maintainer 发出脚本异常通知');
      this.ctx.changed();
    }
    return { acked: true };
  }

  // ---- controls ----

  setPaused(paused) {
    this.paused = paused === true;
    this.persist();
    this.note(this.paused ? '保活已暂停' : '保活已恢复');
  }

  checkNow() {
    this.requireBrowser();
    return this.enqueue(() => this.runCheck('立即检测'));
  }

  keepaliveNow(owner) {
    this.requireBrowser();
    return this.enqueue(() => this.runKeepalive('手动', { owner }));
  }

  /** Granted only after the round in flight has finished, so a caller holding the lock knows nothing else is clicking. */
  lock({ owner, ttl_minutes: ttlInput, reason }) {
    const name = String(owner || '').trim().slice(0, 80);
    if (!name) throw new InputError('owner 必填：写清是谁在占用');
    let ttl = this.config.lock_ttl_minutes;
    if (ttlInput !== undefined && ttlInput !== null && ttlInput !== '') {
      ttl = Number(ttlInput);
      if (!Number.isFinite(ttl) || ttl < 1 || ttl > 24 * 60) throw new InputError('ttl_minutes 要在 1–1440 之间');
    }
    return this.enqueue(() => {
      const now = Date.now();
      const held = this.lockInfo && now < this.lockInfo.expires_at ? this.lockInfo : null;
      if (held && held.owner !== name) {
        throw new InputError(`${held.owner} 正在占用，最晚 ${systemClock(held.expires_at)} 自动解除`, 409);
      }
      this.lockInfo = {
        owner: name,
        reason: String(reason || '').trim().slice(0, 200),
        since: held ? held.since : now,
        expires_at: now + Math.round(ttl * 60000),
        ttl_minutes: ttl,
      };
      this.persist();
      this.note(held
        ? `${name} 续了占用锁，${ttl} 分钟后到期`
        : `${name} 占用了页面，保活不再点击；${ttl} 分钟后自动解除`);
      return this.lockInfo;
    });
  }

  unlock({ owner, force }) {
    const name = String(owner || '').trim();
    return this.enqueue(() => {
      if (!this.lockInfo) return { released: false };
      if (!force && this.lockInfo.owner !== name) {
        throw new InputError(`占用锁是 ${this.lockInfo.owner} 的，owner 对不上`, 409);
      }
      const holder = this.lockInfo.owner;
      this.lockInfo = null;
      this.persist();
      // The holder has usually just logged in or published; look at the page right away.
      if (this.browserAlive) this.checkDueAt = Date.now() + 1000;
      this.note(`${holder} 解除了占用，保活恢复`);
      return { released: true };
    });
  }

  assertCanApply(next) {
    const running = this.browserAlive || this.chromeOn;
    const changed = next.cdp_port !== this.config.cdp_port
      || next.profile_dir !== this.config.profile_dir
      || JSON.stringify(next.chrome_args) !== JSON.stringify(this.config.chrome_args);
    if (running && changed) {
      throw new InputError('先关闭沙盒 Chrome，再改 CDP 端口、沙盒目录或启动参数', 409);
    }
  }

  async applyConfig(next) {
    const timing = JSON.stringify(next.keep_alive) !== JSON.stringify(this.config.keep_alive);
    this.config = next;
    if (timing && this.nextKeepaliveAt) this.scheduleNext();
    if (!next.enabled && this.chromeOn) await this.setChrome(false);
    this.ctx.changed();
  }

  livePort() {
    if (this.config.browser === 'shell' && chrome.shellDebugPort()) return chrome.shellDebugPort();
    return this.config.cdp_port;
  }

  snapshot() {
    const ticking = this.browserAlive && this.chromeOn && !this.paused && !this.awaitingLogin
      && this.script.state === 'ok';
    const shared = this.config.browser === 'shell';
    return {
      ...this.config,
      status: {
        chrome_on: this.chromeOn,
        paused: this.paused,
        browser_alive: this.browserAlive,
        chrome_pid: this.chromePid,
        shared_window: shared,
        shared_window_pid: shared ? this.chromePid : null,
        chrome_error: this.chromeError,
        transition: this.transition,
        activity: this.activity,
        cdp_port: this.livePort(),
        cdp_http: `http://127.0.0.1:${this.livePort()}`,
        session: this.session,
        awaiting_login: this.awaitingLogin,
        script: { state: this.script.state, error: this.script.error },
        lock: this.lockInfo,
        last_heartbeat_at: this.lastHeartbeatAt,
        last_keepalive: this.lastKeepalive,
        next_keepalive_at: ticking ? this.nextKeepaliveAt : 0,
        notice: this.notice,
        events: this.events,
      },
    };
  }
}

module.exports = { PlatformRuntime, reasonText };
