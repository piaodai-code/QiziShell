const http = require('http');
const { WebSocketServer } = require('ws');
const { HermesClient, normalizeDashboardUrl, historyToUiMessages } = require('../hermes-client');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(normalizeDashboardUrl('host:9119') === 'http://host:9119', 'bare host');
assert(normalizeDashboardUrl('http://host:9119/') === 'http://host:9119', 'trailing slash');

const ui = historyToUiMessages([
  { role: 'user', content: 'hello' },
  { role: 'tool', content: 'hidden' },
  { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
]);
assert(ui.length === 2 && ui[0].who === 'me' && ui[0].text === 'hello', 'user row');
assert(ui[1].who === 'them' && ui[1].text === 'world', 'assistant row');

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/status')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ auth_required: true, auth_providers: ['basic'] }));
    return;
  }
  if (req.url === '/auth/password-login') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (json.username !== 'admin' || json.password !== 'secret' || json.provider !== 'basic') {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Invalid credentials' }));
        return;
      }
      res.setHeader('set-cookie', 'hermes_session_at=token; Path=/');
      res.end(JSON.stringify({ ok: true, next: '/' }));
    });
    return;
  }
  if (req.url === '/api/auth/ws-ticket') {
    if (!String(req.headers.cookie || '').includes('hermes_session_at=token')) {
      res.statusCode = 401;
      res.end('no cookie');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ticket: 'ticket-1', ttl_seconds: 30 }));
    return;
  }
  res.statusCode = 404;
  res.end();
});

const wss = new WebSocketServer({ server, path: '/api/ws' });
wss.on('connection', (socket, req) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.searchParams.get('ticket') !== 'ticket-1') {
    socket.close(4401, 'unauthorized');
    return;
  }
  socket.send(JSON.stringify({
    jsonrpc: '2.0',
    method: 'event',
    params: { type: 'gateway.ready', payload: {} },
  }));
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw));
    const reply = (result) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }));
    if (frame.method === 'client.capabilities') reply({ ok: true, server_requests: frame.params.server_requests === true });
    else if (frame.method === 'session.most_recent') reply({ session_id: 'stored-1', title: 'main' });
    else if (frame.method === 'session.resume') {
      reply({
        session_id: 'live-1',
        stored_session_id: 'stored-1',
        messages: [{ role: 'assistant', content: 'earlier' }],
      });
    } else if (frame.method === 'image.attach_bytes') {
      assert(frame.params.session_id === 'live-1', 'attach session');
      assert(String(frame.params.content_base64 || '').length > 20, 'attach bytes');
      reply({ attached: true });
    } else if (frame.method === 'file.attach') {
      assert(frame.params.session_id === 'live-1', 'file session');
      assert(frame.params.name === 'note.txt', 'file name');
      assert(String(frame.params.data_url || '').startsWith('data:text/plain;base64,'), 'file data');
      reply({ attached: true, ref_text: '@file:note.txt' });
    } else if (frame.method === 'prompt.submit') {
      assert(frame.params.text === 'ping\n@file:note.txt', 'prompt text');
      reply({ status: 'streaming' });
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { type: 'status.update', payload: { kind: 'lifecycle', text: 'Thinking' } },
      }));
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { type: 'tool.start', payload: { tool_id: 't1', name: 'terminal', context: 'git status' } },
      }));
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { type: 'reasoning.delta', payload: { text: 'checking the gateway' } },
      }));
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { type: 'message.delta', payload: { text: 'Hi' } },
      }));
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { type: 'message.delta', payload: { text: ' there' } },
      }));
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { type: 'message.complete', payload: { text: 'Hi there' } },
      }));
    } else if (frame.method === 'gateway.ping') reply({ ok: true });
    else reply({});
  });
});

server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  const bad = new HermesClient();
  let rejected = false;
  try {
    await bad.connect({ url: `http://127.0.0.1:${port}`, username: 'admin', password: 'nope' });
  } catch (err) {
    rejected = /Invalid account or password/.test(err.message);
  }
  assert(rejected, 'bad password should fail');
  bad.close();

  const client = new HermesClient();
  const streamed = [];
  const activity = [];
  let completed = '';
  client.on('stream', (payload) => streamed.push(payload.text));
  client.on('activity', (payload) => activity.push(payload.text));
  client.on('complete', (payload) => { completed = payload.text; });
  const opened = await client.connect({
    url: `http://127.0.0.1:${port}`,
    username: 'admin',
    password: 'secret',
  });
  assert(opened.hasHistory === true, 'history flag');
  assert(opened.messages[0].text === 'earlier', 'resumed text');
  await client.submit({
    text: 'ping',
    images: [{
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      name: 'dot.png',
    }],
    files: [{
      dataUrl: 'data:text/plain;base64,aGk=',
      name: 'note.txt',
      size: 2,
    }],
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert(streamed.includes('Hi there'), `streamed ${streamed.join(' | ')}`);
  assert(completed === 'Hi there', `completed ${completed}`);
  assert(activity.includes('Thinking'), `status ${activity.join(' | ')}`);
  assert(activity.includes('terminal · git status'), `tool ${activity.join(' | ')}`);
  assert(activity.includes('Thinking · checking the gateway'), `thought ${activity.join(' | ')}`);
  const probe = new HermesClient();
  await probe.probe({
    url: `http://127.0.0.1:${port}`,
    username: 'admin',
    password: 'secret',
  });
  assert(client.connected, 'probe leaves the live client connected');
  let probeRejected = false;
  try {
    await new HermesClient().probe({
      url: `http://127.0.0.1:${port}`,
      username: 'admin',
      password: 'nope',
    });
  } catch (err) {
    probeRejected = /Invalid account or password/.test(err.message);
  }
  assert(probeRejected, 'probe rejects a bad password');
  client.close();
  wss.close();
  server.close();
  console.log('hermes client smoke ok');
});
