const fs = require('node:fs');
const path = require('node:path');

const DM_SCOPE_RANK = {
  main: 0,
  'per-peer': 1,
  'per-channel-peer': 2,
  'per-account-channel-peer': 3,
};

function normalizeDmScope(value) {
  const text = String(value || '').trim();
  return Object.prototype.hasOwnProperty.call(DM_SCOPE_RANK, text) ? text : 'main';
}

function dmScopeRank(value) {
  return DM_SCOPE_RANK[normalizeDmScope(value)];
}

function neededDmScope(accountCount) {
  return accountCount > 1 ? 'per-account-channel-peer' : 'per-channel-peer';
}

function effectiveDmScope(current, accountCount) {
  const needed = neededDmScope(accountCount);
  return dmScopeRank(current) >= dmScopeRank(needed) ? normalizeDmScope(current) : needed;
}

function peerIdFromRoute(channel, to) {
  const raw = String(to || '').trim().toLowerCase();
  if (!raw) return '';
  const prefix = `${String(channel || '').trim().toLowerCase()}:`;
  if (prefix !== ':' && raw.startsWith(prefix)) return raw.slice(prefix.length);
  return raw;
}

function displayPeerName(label, channel) {
  let text = String(label || '').trim();
  if (!text) return '';
  text = text.replace(/\s+id:\d+$/i, '').trim();
  const prefix = `${String(channel || '').trim()}:`;
  if (prefix !== ':' && text.toLowerCase().startsWith(prefix.toLowerCase())) return '';
  if (/^\d+$/.test(text)) return '';
  return text;
}

function buildChannelSessionKey({ agentId, channel, accountId, peerId, dmScope }) {
  const agent = String(agentId || '').trim();
  const ch = String(channel || '').trim().toLowerCase();
  const peer = String(peerId || '').trim().toLowerCase();
  const account = String(accountId || '').trim() || 'default';
  if (!agent || !ch || !peer) return '';
  const scope = normalizeDmScope(dmScope);
  if (scope === 'per-account-channel-peer') {
    return `agent:${agent}:${ch}:${account}:direct:${peer}`;
  }
  if (scope === 'per-channel-peer') {
    return `agent:${agent}:${ch}:direct:${peer}`;
  }
  if (scope === 'per-peer') {
    return `agent:${agent}:direct:${peer}`;
  }
  return '';
}

function parseDirectSessionKey(sessionKey) {
  const key = String(sessionKey || '').trim();
  const parts = key.split(':');
  if (parts[0] !== 'agent' || parts.length < 4) return null;
  const directAt = parts.lastIndexOf('direct');
  if (directAt < 2 || directAt !== parts.length - 2) return null;
  const peerId = parts[parts.length - 1];
  if (!peerId || peerId === 'direct') return null;
  if (directAt === 2) {
    return { agentId: parts[1], channel: '', accountId: '', peerId, sessionKey: key };
  }
  if (directAt === 3) {
    return { agentId: parts[1], channel: parts[2], accountId: '', peerId, sessionKey: key };
  }
  if (directAt === 4) {
    return { agentId: parts[1], channel: parts[2], accountId: parts[3], peerId, sessionKey: key };
  }
  return null;
}

function choiceIdFor(channel, accountId, peerId) {
  return `channel:${channel}:${accountId}:${peerId}`;
}

function normalizeSavedChoice(value) {
  if (!value || value.mode !== 'channel') return null;
  const channel = String(value.channel || '').trim().toLowerCase();
  const accountId = String(value.accountId || '').trim();
  const peerId = String(value.peerId || '').trim().toLowerCase();
  const originatingTo = String(value.originatingTo || '').trim();
  const sessionKey = String(value.sessionKey || '').trim();
  if (!channel || !accountId || !peerId || !originatingTo || !sessionKey) return null;
  return {
    mode: 'channel',
    channel,
    accountId,
    peerId,
    originatingTo,
    sessionKey,
    dmScope: normalizeDmScope(value.dmScope),
  };
}

function createPrivateChannelStore(filePath) {
  function resolvePath() {
    return typeof filePath === 'function' ? filePath() : filePath;
  }

  function readAll() {
    try {
      const parsed = JSON.parse(fs.readFileSync(resolvePath(), 'utf8'));
      const byAgent = parsed && typeof parsed.byAgent === 'object' && parsed.byAgent ? parsed.byAgent : {};
      return byAgent;
    } catch {
      return {};
    }
  }

  function writeAll(byAgent) {
    const target = resolvePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ byAgent }, null, 2), 'utf8');
  }

  function getChoice(agentId) {
    const id = String(agentId || '').trim();
    if (!id) return null;
    return normalizeSavedChoice(readAll()[id]);
  }

  function setChoice(agentId, choice) {
    const id = String(agentId || '').trim();
    if (!id) return;
    const byAgent = readAll();
    const normalized = normalizeSavedChoice(choice);
    if (!normalized) delete byAgent[id];
    else byAgent[id] = normalized;
    writeAll(byAgent);
  }

  function shellSessionKey(agentId, mainKey = 'main') {
    const id = String(agentId || '').trim() || 'main';
    const saved = getChoice(id);
    if (saved?.sessionKey) return saved.sessionKey;
    const key = String(mainKey || '').trim() || 'main';
    return `agent:${id}:${key}`;
  }

  function shellSessionKeys(agentIds, mainKey = 'main') {
    const keys = {};
    for (const agentId of agentIds || []) {
      const id = String(agentId || '').trim();
      if (!id) continue;
      keys[id] = shellSessionKey(id, mainKey);
    }
    return keys;
  }

  function sendFieldsForSession(sessionKey) {
    const match = /^agent:([^:]+):/.exec(String(sessionKey || '').trim());
    const choice = match ? getChoice(match[1]) : null;
    if (!choice || choice.sessionKey !== sessionKey) return { deliver: false };
    return {
      deliver: true,
      originatingChannel: choice.channel,
      originatingTo: choice.originatingTo,
      originatingAccountId: choice.accountId,
    };
  }

  return {
    getChoice,
    setChoice,
    shellSessionKey,
    shellSessionKeys,
    sendFieldsForSession,
  };
}

function usableAccounts(accounts) {
  return (Array.isArray(accounts) ? accounts : []).filter((account) => (
    account
    && account.accountId
    && account.configured !== false
    && account.enabled !== false
  ));
}

function accountsForAgent(agentId, channelId, { bindings, accounts, defaultAgentId, defaultAccountId }) {
  const bound = (Array.isArray(bindings) ? bindings : []).filter((binding) => (
    binding?.agentId === agentId && binding?.match?.channel === channelId
  ));
  if (bound.length) {
    const chosen = [];
    const seen = new Set();
    for (const binding of bound) {
      const accountId = binding.match.accountId || defaultAccountId || 'default';
      if (seen.has(accountId)) continue;
      seen.add(accountId);
      const snap = accounts.find((account) => account.accountId === accountId);
      if (snap) chosen.push(snap);
    }
    return chosen;
  }
  const channelBoundToSomeone = (Array.isArray(bindings) ? bindings : []).some((binding) => (
    binding?.match?.channel === channelId
  ));
  if (channelBoundToSomeone || agentId !== defaultAgentId) return [];
  return accounts;
}

function addPeer(map, session, spec) {
  const id = `${spec.accountId}\0${spec.peerId}`;
  const label = displayPeerName(session?.displayName || session?.origin?.label || '', spec.channelId);
  const to = String(session?.deliveryContext?.to || session?.lastTo || '').trim();
  const originatingTo = to || `${spec.channelId}:${spec.peerId}`;
  const sessionKey = buildChannelSessionKey({
    agentId: spec.agentId,
    channel: spec.channelId,
    accountId: spec.accountId,
    peerId: spec.peerId,
    dmScope: spec.dmScope,
  });
  if (!sessionKey) return;
  const prev = map.get(id);
  if (!prev) {
    map.set(id, {
      accountId: spec.accountId,
      peerId: spec.peerId,
      label,
      originatingTo,
      sessionKey,
    });
    return;
  }
  if (!prev.label && label) prev.label = label;
  if (to && prev.originatingTo === `${spec.channelId}:${spec.peerId}`) prev.originatingTo = to;
}

function collectPeers({ agentId, channelId, accounts, sessions, dmScope, mainKey }) {
  const accountIds = new Set(accounts.map((account) => account.accountId));
  const peers = new Map();
  for (const session of sessions || []) {
    const parsed = parseDirectSessionKey(session?.key);
    if (!parsed || parsed.agentId !== agentId || parsed.channel !== channelId) continue;
    const accountId = parsed.accountId
      || session?.deliveryContext?.accountId
      || session?.lastAccountId
      || '';
    if (!accountId || !accountIds.has(accountId)) continue;
    addPeer(peers, session, {
      agentId,
      channelId,
      accountId,
      peerId: parsed.peerId,
      dmScope,
    });
  }
  for (const session of sessions || []) {
    const key = String(session?.key || '');
    const isMain = key === `agent:${agentId}:${mainKey}` || (session?.isMain === true && session?.agentId === agentId);
    if (!isMain) continue;
    const channel = session?.deliveryContext?.channel || session?.channel || session?.lastChannel || '';
    if (channel !== channelId) continue;
    const accountId = session?.deliveryContext?.accountId || session?.lastAccountId || '';
    if (!accountId || !accountIds.has(accountId)) continue;
    const to = session?.deliveryContext?.to || session?.lastTo || session?.origin?.to || session?.origin?.from || '';
    const peerId = peerIdFromRoute(channelId, to);
    if (!peerId) continue;
    addPeer(peers, session, { agentId, channelId, accountId, peerId, dmScope });
  }
  return [...peers.values()].sort((left, right) => {
    const leftName = left.label || left.peerId;
    const rightName = right.label || right.peerId;
    return leftName.localeCompare(rightName, 'zh');
  });
}

function buildPrivateChannelCatalog({
  agentId,
  defaultAgentId = 'main',
  mainKey = 'main',
  dmScope,
  channelStatus,
  bindings,
  sessions,
  savedChoice,
}) {
  const id = String(agentId || '').trim() || 'main';
  const options = [{
    id: 'mac',
    mode: 'mac',
    label: 'Webchat',
    shortLabel: 'Webchat',
    detail: '只在这台 Mac 上聊，不发到手机',
    selectable: true,
    sessionKey: `agent:${id}:${mainKey || 'main'}`,
  }];
  const status = channelStatus || {};
  const order = Array.isArray(status.channelOrder) && status.channelOrder.length
    ? status.channelOrder
    : Object.keys(status.channelAccounts || {});
  const seenChannels = new Set();

  for (const channelId of order) {
    const channel = String(channelId || '').trim().toLowerCase();
    if (!channel || seenChannels.has(channel)) continue;
    seenChannels.add(channel);
    const channelLabel = status.channelLabels?.[channelId] || status.channelLabels?.[channel] || channel;
    const accounts = usableAccounts(status.channelAccounts?.[channelId] || status.channelAccounts?.[channel]);
    if (!accounts.length) continue;
    const agentAccounts = accountsForAgent(id, channel, {
      bindings,
      accounts,
      defaultAgentId,
      defaultAccountId: status.channelDefaultAccountId?.[channelId] || status.channelDefaultAccountId?.[channel],
    });
    if (!agentAccounts.length) continue;
    const scope = effectiveDmScope(dmScope, accounts.length);
    const peers = collectPeers({
      agentId: id,
      channelId: channel,
      accounts: agentAccounts,
      sessions,
      dmScope: scope,
      mainKey: mainKey || 'main',
    });
    if (!peers.length) {
      options.push({
        id: `empty:${channel}`,
        mode: 'channel',
        channel,
        label: `和 ${channelLabel} 同一通道`,
        shortLabel: channelLabel,
        detail: '还没有私聊。先在这个软件里给这个 Agent 发一条，再回来选。',
        selectable: false,
      });
      continue;
    }
    const severalAccounts = agentAccounts.length > 1;
    for (const peer of peers) {
      const account = agentAccounts.find((item) => item.accountId === peer.accountId);
      const accountName = severalAccounts ? (account?.name || peer.accountId) : '';
      const detail = [accountName, peer.label].filter(Boolean).join(' · ');
      options.push({
        id: choiceIdFor(channel, peer.accountId, peer.peerId),
        mode: 'channel',
        channel,
        accountId: peer.accountId,
        peerId: peer.peerId,
        originatingTo: peer.originatingTo,
        sessionKey: peer.sessionKey,
        dmScope: scope,
        label: `和 ${channelLabel} 同一通道`,
        shortLabel: channelLabel,
        detail,
        selectable: true,
      });
    }
  }

  const saved = normalizeSavedChoice(savedChoice);
  if (saved && !options.some((option) => option.sessionKey === saved.sessionKey)) {
    const channelLabel = status.channelLabels?.[saved.channel] || saved.channel;
    options.push({
      id: choiceIdFor(saved.channel, saved.accountId, saved.peerId),
      ...saved,
      label: `和 ${channelLabel} 同一通道`,
      shortLabel: channelLabel,
      detail: '',
      selectable: true,
    });
  }

  const selected = options.find((option) => option.selectable && saved && option.sessionKey === saved.sessionKey);
  return {
    agentId: id,
    options,
    selectedId: selected?.id || 'mac',
  };
}

function publicChannelOption(option) {
  return {
    id: option.id,
    label: option.label,
    shortLabel: option.shortLabel || option.label,
    detail: option.detail || '',
    selectable: option.selectable === true,
  };
}

module.exports = {
  normalizeDmScope,
  dmScopeRank,
  neededDmScope,
  effectiveDmScope,
  peerIdFromRoute,
  displayPeerName,
  buildChannelSessionKey,
  parseDirectSessionKey,
  createPrivateChannelStore,
  buildPrivateChannelCatalog,
  publicChannelOption,
  normalizeSavedChoice,
};
