#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  effectiveDmScope,
  displayPeerName,
  buildChannelSessionKey,
  createPrivateChannelStore,
  buildPrivateChannelCatalog,
} = require('../private-channel');

assert.equal(effectiveDmScope(undefined, 5), 'per-account-channel-peer');
assert.equal(effectiveDmScope('per-channel-peer', 1), 'per-channel-peer');
assert.equal(effectiveDmScope('per-account-channel-peer', 1), 'per-account-channel-peer');
assert.equal(displayPeerName('Darryl Wang id:7044906239', 'telegram'), 'Darryl Wang');
assert.equal(displayPeerName('telegram:7044906239', 'telegram'), '');

const sessionKey = buildChannelSessionKey({
  agentId: 'main',
  channel: 'telegram',
  accountId: 'main',
  peerId: '7044906239',
  dmScope: 'per-account-channel-peer',
});
assert.equal(sessionKey, 'agent:main:telegram:main:direct:7044906239');

const status = {
  channelOrder: ['telegram', 'whatsapp'],
  channelLabels: { telegram: 'Telegram', whatsapp: 'WhatsApp' },
  channelDefaultAccountId: { telegram: 'main', whatsapp: 'default' },
  channelAccounts: {
    telegram: [
      { accountId: 'main', configured: true, enabled: true },
      { accountId: 'mo_bao', configured: true, enabled: true },
    ],
    whatsapp: [
      { accountId: 'default', configured: true, enabled: true },
    ],
  },
};
const bindings = [
  { agentId: 'main', match: { channel: 'telegram', accountId: 'main' } },
  { agentId: 'mo_bao', match: { channel: 'telegram', accountId: 'mo_bao' } },
];
const sessions = [
  {
    key: 'agent:main:main',
    isMain: true,
    agentId: 'main',
    channel: 'telegram',
    deliveryContext: { channel: 'telegram', to: 'telegram:7044906239', accountId: 'main' },
    origin: { label: 'telegram:7044906239' },
  },
  {
    key: 'agent:mo_bao:main',
    isMain: true,
    agentId: 'mo_bao',
    channel: 'telegram',
    displayName: 'Darryl Wang id:7044906239',
    deliveryContext: { channel: 'telegram', to: 'telegram:7044906239', accountId: 'mo_bao' },
    origin: { label: 'Darryl Wang id:7044906239' },
  },
  {
    key: 'agent:mo_bao:telegram:mo_bao:direct:7044906239',
    channel: 'telegram',
    deliveryContext: { channel: 'telegram', to: 'telegram:7044906239', accountId: 'mo_bao' },
    origin: { label: 'telegram:7044906239' },
  },
  {
    key: 'agent:main:telegram:main:direct:200',
    channel: 'telegram',
    deliveryContext: { channel: 'telegram', to: 'telegram:200', accountId: 'main' },
    origin: { label: 'Ada id:200' },
  },
];

const mainCatalog = buildPrivateChannelCatalog({
  agentId: 'main',
  defaultAgentId: 'main',
  dmScope: undefined,
  channelStatus: status,
  bindings,
  sessions,
});
const mainLabels = mainCatalog.options.map((option) => `${option.label}|${option.detail}|${option.selectable}`);
assert.deepEqual(mainLabels, [
  'Webchat|只在这台 Mac 上聊，不发到手机|true',
  '和 Telegram 同一通道||true',
  '和 Telegram 同一通道|Ada|true',
  '和 WhatsApp 同一通道|还没有私聊。先在这个软件里给这个 Agent 发一条，再回来选。|false',
]);
assert.equal(mainCatalog.selectedId, 'mac');
assert.equal(mainCatalog.options[0].shortLabel, 'Webchat');
assert.equal(mainCatalog.options[1].shortLabel, 'Telegram');
assert.equal(mainCatalog.options.find((option) => option.channel === 'whatsapp').shortLabel, 'WhatsApp');
const mainTelegram = mainCatalog.options.find((option) => option.sessionKey === sessionKey);
assert.ok(mainTelegram);
assert.equal(mainTelegram.originatingTo, 'telegram:7044906239');
assert.equal(mainCatalog.options.some((option) => option.accountId === 'mo_bao'), false);

const otherCatalog = buildPrivateChannelCatalog({
  agentId: 'mo_bao',
  defaultAgentId: 'main',
  dmScope: 'main',
  channelStatus: status,
  bindings,
  sessions,
});
assert.equal(otherCatalog.options.filter((option) => option.channel === 'telegram' && option.selectable).length, 1);
assert.equal(otherCatalog.options[1].detail, 'Darryl Wang');
assert.equal(otherCatalog.options[1].sessionKey, 'agent:mo_bao:telegram:mo_bao:direct:7044906239');

const emptyStatus = {
  ...status,
  channelAccounts: {
    ...status.channelAccounts,
    telegram: status.channelAccounts.telegram.concat([
      { accountId: 'qi_hui_hui', configured: true, enabled: true },
    ]),
  },
};
const emptyCatalog = buildPrivateChannelCatalog({
  agentId: 'qi_hui_hui',
  defaultAgentId: 'main',
  dmScope: 'main',
  channelStatus: emptyStatus,
  bindings: bindings.concat([
    { agentId: 'qi_hui_hui', match: { channel: 'telegram', accountId: 'qi_hui_hui' } },
  ]),
  sessions: [],
});
assert.equal(emptyCatalog.options[1].selectable, false);
assert.match(emptyCatalog.options[1].detail, /还没有私聊/);

const whatsappCatalog = buildPrivateChannelCatalog({
  agentId: 'main',
  defaultAgentId: 'main',
  channelStatus: status,
  bindings,
  sessions: [],
});
assert.equal(whatsappCatalog.options.some((option) => option.channel === 'whatsapp'), true);
const otherWhatsapp = buildPrivateChannelCatalog({
  agentId: 'mo_bao',
  defaultAgentId: 'main',
  channelStatus: status,
  bindings,
  sessions: [],
});
assert.equal(otherWhatsapp.options.some((option) => option.channel === 'whatsapp'), false);

const file = path.join(os.tmpdir(), `qizi-private-channel-${process.pid}.json`);
const store = createPrivateChannelStore(file);
store.setChoice('main', mainTelegram);
assert.equal(store.shellSessionKey('main'), sessionKey);
assert.deepEqual(store.sendFieldsForSession(sessionKey), {
  deliver: true,
  originatingChannel: 'telegram',
  originatingTo: 'telegram:7044906239',
  originatingAccountId: 'main',
});
assert.deepEqual(store.sendFieldsForSession('agent:main:main'), { deliver: false });
store.setChoice('main', { mode: 'mac' });
assert.equal(store.shellSessionKey('main'), 'agent:main:main');
fs.unlinkSync(file);

const savedCatalog = buildPrivateChannelCatalog({
  agentId: 'main',
  defaultAgentId: 'main',
  channelStatus: status,
  bindings,
  sessions,
  savedChoice: {
    mode: 'channel',
    channel: 'telegram',
    accountId: 'main',
    peerId: '7044906239',
    originatingTo: 'telegram:7044906239',
    sessionKey,
    dmScope: 'per-account-channel-peer',
  },
});
assert.equal(savedCatalog.selectedId, 'channel:telegram:main:7044906239');

console.log('private-channel-smoke OK');
