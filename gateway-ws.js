const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { buildDeviceAuthPayloadV3 } = require('./device-auth-payload');
const {
  loadOrCreateDeviceIdentity,
  signDevicePayload,
  publicKeyRawBase64UrlFromPem,
} = require('./device-identity');
const {
  loadDeviceAuthToken,
  storeDeviceAuthToken,
  clearDeviceAuthToken,
} = require('./device-auth-store');
const { rejectUnauthorizedForUrl } = require('./tls-policy');

const PROTOCOL_VERSION = 4;
// operator UI 客户端（TUI / Control UI）在 chat.send 时不写入 SenderId/SenderName，
// 避免用户消息被标成「QiziShell (gateway-client)」。不用 control-ui：会触发 origin 校验。
const CLIENT_ID = 'openclaw-tui';
const CLIENT_MODE = 'cli';
const CLIENT_CAPS = ['tool-events'];
const OPERATOR_ROLE = 'operator';
const OPERATOR_SCOPES = [
  'operator.admin',
  'operator.read',
  'operator.write',
  'operator.approvals',
  'operator.pairing',
];
function readConnectDetailCode(err) {
  return err?.details?.code || err?.details?.detailCode || null;
}

function describeGatewayClose(detailCode) {
  if (detailCode === 'AUTH_RATE_LIMITED') return '登录尝试过多，稍后会自动重试';
  return null;
}

function isSecureGatewayUrl(url) {
  return /^wss:\/\//i.test(String(url || ''));
}

const DEFAULT_TICK_INTERVAL_MS = 30_000;
const MIN_TICK_INTERVAL_MS = 1_000;
const MAX_TICK_INTERVAL_MS = 60_000;
const SOCKET_HANDSHAKE_TIMEOUT_MS = 15_000;
const SOCKET_CLOSE_TIMEOUT_MS = 1_000;
const FORCE_STOP_TERMINATE_GRACE_MS = 250;

function buildGatewayWsOptions(url) {
  const options = {
    maxPayload: 25 * 1024 * 1024,
    // 握手挂死（网关进程已死、中间代理仍接受 TCP）时不要一直停在 CONNECTING。
    handshakeTimeout: SOCKET_HANDSHAKE_TIMEOUT_MS,
    // 对端不回 close 帧时，ws 默认要等 30s 才销毁。缩短后，主动断开能更快进入重连。
    closeTimeout: SOCKET_CLOSE_TIMEOUT_MS,
  };
  if (isSecureGatewayUrl(url)) {
    options.rejectUnauthorized = rejectUnauthorizedForUrl(url);
  }
  return options;
}

function resolveTickIntervalMs(advertised) {
  const value = Number(advertised);
  if (!Number.isFinite(value) || value < MIN_TICK_INTERVAL_MS) {
    return DEFAULT_TICK_INTERVAL_MS;
  }
  return Math.min(value, MAX_TICK_INTERVAL_MS);
}

class GatewayWsClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.url = options.url;
    this.token = options.token;
    this.clientDisplayName = options.clientDisplayName;
    this.clientVersion = options.clientVersion || '0.1.0';
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.connectChallengeTimeoutMs = options.connectChallengeTimeoutMs ?? 10_000;

    this.ws = null;
    this.pending = new Map();
    this.closed = false;
    this.connected = false;
    this.connectNonce = null;
    this.connectSent = false;
    this.connectTimer = null;
    this.reconnectTimer = null;
    this.backoffMs = 1000;
    this.deviceIdentity = loadOrCreateDeviceIdentity();
    this.pendingDeviceTokenRetry = false;
    this.deviceTokenRetryBudgetUsed = false;
    this.pendingConnectError = null;
    this.hello = null;
    this.connectPromise = null;
    this.lastRxAt = 0;
    this.lastTick = null;
    this.tickIntervalMs = DEFAULT_TICK_INTERVAL_MS;
    this.livenessTimer = null;
    this.pingSentAt = 0;
    this.socketRetiring = false;
    this.attemptTimer = null;
    // 平时没有人等连接。error 事件若没有监听者，Node 会直接抛错，后面的重连就排不下去。
    this.on('error', () => {});
  }

  safeEmit(event, payload) {
    try {
      this.emit(event, payload);
    } catch (err) {
      console.warn(`[qizi] gateway ${event} listener failed:`, err?.message || err);
    }
  }

  start() {
    if (this.closed) return;
    this.clearReconnectTimer();
    this.clearConnectTimer();
    this.clearAttemptTimer();
    this.clearLivenessWatch();
    this.connectNonce = null;
    this.connectSent = false;
    this.connected = false;
    this.lastTick = null;
    this.pingSentAt = 0;
    this.socketRetiring = false;
    this.tickIntervalMs = DEFAULT_TICK_INTERVAL_MS;

    const previous = this.ws;
    const ws = new WebSocket(this.url, buildGatewayWsOptions(this.url));
    this.ws = ws;
    if (previous && previous !== ws) {
      previous.removeAllListeners();
      try { previous.terminate(); } catch {}
    }
    this.armAttemptTimeout(ws);

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.noteInbound();
      this.armConnectChallengeTimeout();
    });
    ws.on('message', (data) => {
      if (this.ws !== ws) return;
      // 只把网关应用帧算作存活。代理自己回复的 ping/pong 不能证明 OpenClaw 进程还在。
      this.noteInbound();
      this.handleMessage(String(data));
    });
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.handleClose(code, String(reason));
    });
    ws.on('error', (err) => {
      if (this.ws !== ws) return;
      // 先安排强制断开，再通知监听者。监听者抛错也不能把这次重连卡住。
      const timer = setTimeout(() => {
        if (this.ws !== ws) return;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          try { ws.terminate(); } catch {}
        }
      }, SOCKET_CLOSE_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      if (!this.connectSent) this.safeEmit('error', err);
    });
  }

  stop() {
    this.closed = true;
    this.clearReconnectTimer();
    this.clearConnectTimer();
    this.clearAttemptTimer();
    this.clearLivenessWatch();
    this.flushPending(new Error('gateway client stopped'));
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    if (ws) this.retireSocket(ws);
  }

  scheduleReconnect() {
    if (this.closed) return;
    this.clearReconnectTimer();
    const delay = this.backoffMs;
    if (this.backoffMs < 30_000) {
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, delay);
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  clearConnectTimer() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  clearAttemptTimer() {
    if (this.attemptTimer) {
      clearTimeout(this.attemptTimer);
      this.attemptTimer = null;
    }
  }

  // 这一轮握手若既没连上、也没走到 close，重连定时器不会再排。到点强制拆掉。
  armAttemptTimeout(ws) {
    this.clearAttemptTimer();
    const limit = this.connectChallengeTimeoutMs + this.requestTimeoutMs + 5_000;
    this.attemptTimer = setTimeout(() => {
      this.attemptTimer = null;
      if (this.closed || this.connected || this.ws !== ws) return;
      this.retireSocket(ws, 4000, 'connect attempt timeout');
    }, limit);
  }

  clearLivenessWatch() {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  noteInbound() {
    const now = Date.now();
    this.lastRxAt = now;
    this.lastTick = now;
  }

  // 网关进程重启后，Tailscale / 反向代理经常不把 TCP 关闭交给客户端。
  // readyState 会一直停在 OPEN，现有重连逻辑根本不会跑，只能退出应用再开。
  // 协议约定：入站静默超过 policy.tickIntervalMs 的两倍就用 4000 拆掉这条连接。
  startLivenessWatch() {
    this.clearLivenessWatch();
    const every = Math.min(5_000, Math.max(MIN_TICK_INTERVAL_MS, this.tickIntervalMs));
    this.livenessTimer = setInterval(() => this.checkLiveness(), every);
  }

  checkLiveness() {
    if (this.closed || this.socketRetiring || !this.connected || !this.ws || !this.lastTick) return;
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.maybePing();
    // 进行中的请求有自己的超时，并由超时路径拆掉完全无入站的半开连接。
    if (this.pending.size > 0) return;
    const gap = Date.now() - this.lastTick;
    if (gap > this.tickIntervalMs * 2) {
      this.dropSilentSocket('tick timeout');
    }
  }

  maybePing() {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.socketRetiring) return;
    const interval = Math.min(this.tickIntervalMs, 15_000);
    const now = Date.now();
    if (this.pingSentAt && now - this.pingSentAt < interval) return;
    this.pingSentAt = now;
    try {
      ws.ping();
    } catch {
      this.dropSilentSocket('heartbeat ping failed');
    }
  }

  dropSilentSocket(reason) {
    if (this.socketRetiring || !this.ws) return;
    this.socketRetiring = true;
    this.connected = false;
    this.retireSocket(this.ws, 4000, reason);
  }

  // close() 在对端已死时要等关闭握手。250ms 内没结束就 terminate，让 close 事件马上出现并进入重连。
  retireSocket(ws, code, reason) {
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    if (ws.readyState === WebSocket.CONNECTING) {
      try { ws.terminate(); } catch {}
      return;
    }
    try { ws.close(code, reason); } catch {}
    const timer = setTimeout(() => {
      if (ws.readyState === WebSocket.CLOSED) return;
      try { ws.terminate(); } catch {}
    }, FORCE_STOP_TERMINATE_GRACE_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  armConnectChallengeTimeout() {
    this.clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      if (!this.connectSent && this.ws?.readyState === WebSocket.OPEN) {
        const err = new Error('gateway connect challenge timeout');
        this.retireSocket(this.ws, 1008, 'connect challenge timeout');
        this.safeEmit('error', err);
      }
    }, this.connectChallengeTimeoutMs);
  }

  handleClose(code, reason) {
    this.ws = null;
    this.connected = false;
    this.connectSent = false;
    this.connectPromise = null;
    this.socketRetiring = false;
    this.lastTick = null;
    this.pingSentAt = 0;
    this.clearConnectTimer();
    this.clearAttemptTimer();
    this.clearLivenessWatch();
    const failure = this.pendingConnectError;
    this.pendingConnectError = null;
    const detailCode = failure?.detailCode || null;
    const reconnecting = !this.closed;
    if (detailCode === 'AUTH_RATE_LIMITED') {
      const waitMs = Math.max(failure?.retryAfterMs || 60_000, 15_000);
      this.backoffMs = waitMs;
    }
    this.flushPending(new Error(`gateway closed (${code}): ${reason}`));
    // 先排下一次重连，再通知界面。界面处理抛错时，不能把循环停在这一轮。
    if (reconnecting) this.scheduleReconnect();
    this.safeEmit('close', {
      code,
      reason,
      reconnecting,
      errorMessage: describeGatewayClose(detailCode),
    });
  }

  flushPending(err) {
    for (const [, pending] of this.pending) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pending.clear();
  }

  handleMessage(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (parsed?.type === 'event') {
      if (parsed.event === 'connect.challenge') {
        const nonce = parsed.payload?.nonce;
        if (typeof nonce !== 'string' || !nonce.trim()) {
          this.retireSocket(this.ws, 1008, 'connect challenge missing nonce');
          this.safeEmit('error', new Error('gateway connect challenge missing nonce'));
          return;
        }
        this.connectNonce = nonce.trim();
        this.sendConnect();
        return;
      }
      this.emit('event', parsed);
      return;
    }

    if (parsed?.type === 'res') {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      const status = parsed.payload?.status;
      if (pending.expectFinal && status === 'accepted') {
        return;
      }
      this.pending.delete(parsed.id);
      if (pending.timeout) clearTimeout(pending.timeout);
      if (parsed.ok) {
        pending.resolve(parsed.payload);
      } else {
        const err = new Error(parsed.error?.message || 'gateway request failed');
        err.gatewayCode = parsed.error?.code;
        err.details = parsed.error?.details;
        err.retryAfterMs = parsed.error?.retryAfterMs;
        pending.reject(err);
      }
    }
  }

  selectConnectAuth(role) {
    const explicitGatewayToken = this.token?.trim() || undefined;
    const storedAuth = loadDeviceAuthToken({
      deviceId: this.deviceIdentity.deviceId,
      role,
    });
    const storedToken = storedAuth?.token;
    const storedScopes = storedAuth?.scopes;
    const shouldUseDeviceRetryToken =
      this.pendingDeviceTokenRetry && explicitGatewayToken && storedToken;
    const resolvedDeviceToken = shouldUseDeviceRetryToken ? storedToken : undefined;
    const reusingStoredDeviceToken =
      Boolean(resolvedDeviceToken) && resolvedDeviceToken === storedToken;
    const authToken = explicitGatewayToken ?? resolvedDeviceToken;
    return {
      authToken,
      authDeviceToken: shouldUseDeviceRetryToken ? storedToken : undefined,
      signatureToken: authToken,
      resolvedDeviceToken,
      storedToken,
      storedScopes,
      usingStoredDeviceToken: reusingStoredDeviceToken,
    };
  }

  resolveConnectScopes(selectedAuth) {
    if (
      selectedAuth.usingStoredDeviceToken &&
      Array.isArray(selectedAuth.storedScopes) &&
      selectedAuth.storedScopes.length > 0
    ) {
      return [...selectedAuth.storedScopes];
    }
    return [...OPERATOR_SCOPES];
  }

  sendConnect() {
    if (this.connectSent || !this.connectNonce) return;
    const role = OPERATOR_ROLE;
    const selectedAuth = this.selectConnectAuth(role);
    if (this.pendingDeviceTokenRetry && selectedAuth.authDeviceToken) {
      this.pendingDeviceTokenRetry = false;
    }
    const scopes = this.resolveConnectScopes(selectedAuth);
    const signedAtMs = Date.now();
    const nonce = this.connectNonce;
    const payload = buildDeviceAuthPayloadV3({
      deviceId: this.deviceIdentity.deviceId,
      clientId: CLIENT_ID,
      clientMode: CLIENT_MODE,
      role,
      scopes,
      signedAtMs,
      token: selectedAuth.signatureToken ?? null,
      nonce,
      platform: process.platform,
      deviceFamily: undefined,
    });
    const signature = signDevicePayload(this.deviceIdentity.privateKeyPem, payload);
    const params = {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: CLIENT_ID,
        ...(this.clientDisplayName ? { displayName: this.clientDisplayName } : {}),
        version: this.clientVersion,
        platform: process.platform,
        mode: CLIENT_MODE,
        instanceId: `qizi-shell-${process.pid}`,
      },
      role,
      scopes,
      caps: CLIENT_CAPS,
      auth: selectedAuth.authToken
        ? {
            token: selectedAuth.authToken,
            deviceToken: selectedAuth.authDeviceToken ?? selectedAuth.resolvedDeviceToken,
          }
        : undefined,
      device: {
        id: this.deviceIdentity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(this.deviceIdentity.publicKeyPem),
        signature,
        signedAt: signedAtMs,
        nonce,
      },
    };

    this.connectSent = true;
    this.clearConnectTimer();
    this.request('connect', params)
      .then((hello) => {
        this.pendingDeviceTokenRetry = false;
        this.deviceTokenRetryBudgetUsed = false;
        this.pendingConnectError = null;
        this.backoffMs = 1000;
        this.hello = hello;
        this.connected = true;
        this.tickIntervalMs = resolveTickIntervalMs(hello?.policy?.tickIntervalMs);
        this.noteInbound();
        this.pingSentAt = 0;
        this.clearAttemptTimer();
        this.startLivenessWatch();
        if (hello?.auth?.deviceToken) {
          storeDeviceAuthToken({
            deviceId: this.deviceIdentity.deviceId,
            role: hello.auth.role ?? role,
            token: hello.auth.deviceToken,
            scopes: hello.auth.scopes ?? [],
          });
        }
        this.emit('connected', hello);
      })
      .catch((err) => {
        const detailCode = readConnectDetailCode(err);
        this.pendingConnectError = {
          detailCode,
          message: err?.message || 'connect failed',
          retryAfterMs: err?.retryAfterMs || err?.details?.retryAfterMs || null,
        };
        if (
          this.deviceIdentity &&
          selectedAuth.usingStoredDeviceToken &&
          detailCode === 'AUTH_DEVICE_TOKEN_MISMATCH'
        ) {
          clearDeviceAuthToken({
            deviceId: this.deviceIdentity.deviceId,
            role,
          });
        }
        const shouldRetryWithDeviceToken =
          !this.deviceTokenRetryBudgetUsed &&
          !selectedAuth.resolvedDeviceToken &&
          explicitGatewayTokenPresent(this.token) &&
          selectedAuth.storedToken;
        if (shouldRetryWithDeviceToken) {
          this.pendingDeviceTokenRetry = true;
          this.deviceTokenRetryBudgetUsed = true;
          this.connectSent = false;
          this.retireSocket(this.ws, 1008, 'connect retry');
          return;
        }
        console.warn('[qizi] gateway connect failed, retrying:', err?.message || err);
        this.retireSocket(this.ws, 1008, 'connect failed');
        this.safeEmit('error', err);
      });
  }

  request(method, params, opts = {}) {
    if (!this.ws || this.socketRetiring || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('gateway not connected'));
    }
    const id = crypto.randomUUID();
    const frame = { type: 'req', id, method, params };
    const expectFinal = opts.expectFinal === true;
    const timeoutMs =
      opts.timeoutMs === null
        ? null
        : typeof opts.timeoutMs === 'number'
          ? opts.timeoutMs
          : expectFinal
            ? null
            : this.requestTimeoutMs;

    return new Promise((resolve, reject) => {
      const silentSince = this.lastRxAt;
      const timeout =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`gateway request timeout for ${method}`));
              // 这次请求从头到尾没有任何入站帧，连接多半是半开的。只在这种情况下拆掉它。
              if (
                this.ws
                && this.ws.readyState === WebSocket.OPEN
                && this.lastRxAt === silentSince
              ) {
                this.dropSilentSocket('request timeout');
              }
            }, timeoutMs);
      this.pending.set(id, { resolve, reject, expectFinal, timeout });
      this.ws.send(JSON.stringify(frame));
    });
  }

  waitForConnect(timeoutMs = 15_000) {
    if (this.connected && !this.socketRetiring && this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve(this.hello);
    }
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.connectPromise = null;
        reject(new Error('gateway connect timeout'));
      }, timeoutMs);
      const onConnected = (hello) => {
        cleanup();
        resolve(hello);
      };
      const onError = (err) => {
        cleanup();
        this.connectPromise = null;
        reject(err);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('connected', onConnected);
        this.off('error', onError);
      };
      this.on('connected', onConnected);
      this.on('error', onError);
      if (!this.ws && !this.closed && !this.reconnectTimer) this.start();
    }).finally(() => {
      if (this.connected) {
        this.connectPromise = null;
      }
    });

    return this.connectPromise;
  }
}

function explicitGatewayTokenPresent(token) {
  return typeof token === 'string' && token.trim().length > 0;
}

module.exports = { GatewayWsClient, OPERATOR_SCOPES };
