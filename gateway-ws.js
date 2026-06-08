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

const PROTOCOL_VERSION = 4;
const CLIENT_ID = 'gateway-client';
const CLIENT_MODE = 'backend';
const OPERATOR_ROLE = 'operator';
const OPERATOR_SCOPES = [
  'operator.admin',
  'operator.read',
  'operator.write',
  'operator.approvals',
  'operator.pairing',
];

function isSecureGatewayUrl(url) {
  return /^wss:\/\//i.test(String(url || ''));
}

function buildGatewayWsOptions(url) {
  const options = { maxPayload: 25 * 1024 * 1024 };
  // OpenClaw 本地 Gateway 常用自签名证书；Node ws 默认会拒绝，导致 SSL handshake failed
  if (isSecureGatewayUrl(url)) {
    options.rejectUnauthorized = false;
  }
  return options;
}

class GatewayWsClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.url = options.url;
    this.token = options.token;
    this.clientDisplayName = options.clientDisplayName || '启孜 Shell';
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
    this.hello = null;
    this.connectPromise = null;
  }

  start() {
    if (this.closed) return;
    this.clearReconnectTimer();
    this.clearConnectTimer();
    this.connectNonce = null;
    this.connectSent = false;
    this.connected = false;

    const ws = new WebSocket(this.url, buildGatewayWsOptions(this.url));
    this.ws = ws;

    ws.on('open', () => this.armConnectChallengeTimeout());
    ws.on('message', (data) => this.handleMessage(String(data)));
    ws.on('close', (code, reason) => this.handleClose(code, String(reason)));
    ws.on('error', (err) => {
      if (!this.connectSent) {
        this.emit('error', err);
      }
    });
  }

  stop() {
    this.closed = true;
    this.clearReconnectTimer();
    this.clearConnectTimer();
    this.flushPending(new Error('gateway client stopped'));
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
  }

  scheduleReconnect() {
    if (this.closed) return;
    this.clearReconnectTimer();
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
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

  armConnectChallengeTimeout() {
    this.clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      if (!this.connectSent && this.ws?.readyState === WebSocket.OPEN) {
        const err = new Error('gateway connect challenge timeout');
        this.emit('error', err);
        this.ws.close(1008, 'connect challenge timeout');
      }
    }, this.connectChallengeTimeoutMs);
  }

  handleClose(code, reason) {
    this.ws = null;
    this.connected = false;
    this.connectSent = false;
    this.connectPromise = null;
    this.clearConnectTimer();
    this.flushPending(new Error(`gateway closed (${code}): ${reason}`));
    this.emit('close', { code, reason });
    if (!this.closed) {
      this.scheduleReconnect();
    }
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
          this.emit('error', new Error('gateway connect challenge missing nonce'));
          this.ws?.close(1008, 'connect challenge missing nonce');
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
        displayName: this.clientDisplayName,
        version: this.clientVersion,
        platform: process.platform,
        mode: CLIENT_MODE,
        instanceId: `qizi-shell-${process.pid}`,
      },
      role,
      scopes,
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
        this.backoffMs = 1000;
        this.hello = hello;
        this.connected = true;
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
        const detailCode = err.details?.code || err.details?.detailCode;
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
          this.ws?.close(1008, 'connect retry');
          return;
        }
        this.emit('error', err);
        this.ws?.close(1008, 'connect failed');
      });
  }

  request(method, params, opts = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
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
      const timeout =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`gateway request timeout for ${method}`));
            }, timeoutMs);
      this.pending.set(id, { resolve, reject, expectFinal, timeout });
      this.ws.send(JSON.stringify(frame));
    });
  }

  waitForConnect(timeoutMs = 15_000) {
    if (this.connected) return Promise.resolve(this.hello);
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
      if (!this.ws && !this.closed) this.start();
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
