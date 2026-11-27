#!/usr/bin/env node
'use strict';

const os = require('os');
const path = require('path');
const { Store } = require('./lib/store');
const { Notifier } = require('./lib/notifier');
const { Hub } = require('./lib/hub');
const { createApi } = require('./lib/api');
const { installLauncher } = require('./lib/launcher');

const USAGE = `Usage: node server.js [--port 18990] [--host 0.0.0.0] [--data-dir ~/.qizi-keepalive]

Keeps sandboxed Chrome sessions alive and serves their state to QiziShell.
Chrome keeps running when this process stops; the next start picks it up again.`;

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    const name = { '--port': 'port', '--host': 'host', '--data-dir': 'dataDir' }[arg];
    if (!name || argv[i + 1] === undefined) {
      console.error(`Unknown or incomplete option: ${arg}\n\n${USAGE}`);
      process.exit(2);
    }
    options[name] = argv[i + 1];
    i += 1;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const dataDir = options.dataDir || process.env.QIZI_KEEPALIVE_DIR || path.join(os.homedir(), '.qizi-keepalive');
const store = new Store(dataDir, { host: options.host, port: options.port });

function log(text) {
  // stdout is already appended to keepalive.log by the launcher. Writing the
  // file here as well put every line in the log twice.
  console.log(`${new Date().toISOString()} ${text}`);
}

for (const note of store.configNotes) log(note);
const notifier = new Notifier(() => store.notify, log);
const hub = new Hub({ store, notifier, log });
const api = createApi({ hub, store, notifier, log });

api.server.on('error', (err) => {
  const reason = err.code === 'EADDRINUSE'
    ? `port ${store.listen.port} is already in use; another keep-alive server may be running`
    : err.message;
  console.error(`Cannot listen on ${store.listen.host}:${store.listen.port}: ${reason}`);
  process.exit(1);
});

api.server.listen(store.listen.port, store.listen.host, () => {
  log(`keep-alive server listening on ${store.listen.host}:${store.listen.port}, data in ${store.dataDir}`);
  try {
    const appPath = installLauncher({
      programDir: __dirname,
      port: store.listen.port,
      dataDir: store.dataDir,
    });
    log(`保活图标：${appPath}`);
  } catch (err) {
    log(`保活图标没生成：${err.message}`);
  }
  hub.start();
});

function shutdown() {
  log('stopping; sandbox Chrome is left running');
  hub.stop();
  api.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
