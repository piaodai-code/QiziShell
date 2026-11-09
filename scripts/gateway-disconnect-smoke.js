const assert = require('node:assert');
const WebSocket = require('ws');
const { isRetryableGatewayDisconnect } = require('../gateway-ws');

const alive = {
  connected: true,
  socketRetiring: false,
  readyState: WebSocket.OPEN,
};

assert.strictEqual(
  isRetryableGatewayDisconnect(new Error('gateway closed (1006): '), { connected: false }),
  true,
);
assert.strictEqual(
  isRetryableGatewayDisconnect(new Error('gateway not connected'), {}),
  true,
);
assert.strictEqual(
  isRetryableGatewayDisconnect(new Error('gateway connect timeout'), {}),
  true,
);
assert.strictEqual(
  isRetryableGatewayDisconnect(new Error('gateway request timeout for skills.status'), {
    connected: false,
    socketRetiring: true,
    readyState: WebSocket.OPEN,
  }),
  true,
);
assert.strictEqual(
  isRetryableGatewayDisconnect(new Error('gateway request timeout for skills.status'), alive),
  false,
);
assert.strictEqual(
  isRetryableGatewayDisconnect(new Error('没有找到这个技能'), { connected: false }),
  false,
);

const clientError = new Error('未指定 Agent');
clientError.clientError = true;
assert.strictEqual(isRetryableGatewayDisconnect(clientError, { connected: false }), false);
assert.strictEqual(
  isRetryableGatewayDisconnect(new Error('gateway client stopped'), { connected: false }),
  false,
);

console.log('gateway disconnect smoke ok');
