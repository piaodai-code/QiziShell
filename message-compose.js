// 服务器历史是对话本身。本地只补服务器不还回来的附件、引用和转发结构。
// 已有 serverId 的本地行只按编号贴回。没有编号的只用于还没进历史的那一条，以及旧归档的一次对上。

(function initMessageCompose(root, moduleObj) {
const ATTACHMENT_ONLY_CAPTIONS = new Set([
  '（附件）', '（图片）', '[图片]', '[附件]', '[User sent media without caption]',
]);

function isAttachmentPlaceholder(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  return ATTACHMENT_ONLY_CAPTIONS.has(trimmed);
}

function messageIsForward(message) {
  if (!message || message.who !== 'me') return false;
  if (message.forward?.text) return true;
  return String(message.text || '').includes('【转发开始】')
    || /"kind"\s*:\s*"forwarded-message"/.test(String(message.text || ''));
}

function localHasExtra(message) {
  if (!message || message.who !== 'me') return false;
  if (Array.isArray(message.images) && message.images.length > 0) return true;
  if (Array.isArray(message.files) && message.files.length > 0) return true;
  if (message.quote?.text || message.forward?.text) return true;
  return false;
}

function attachmentNames(message) {
  return (Array.isArray(message?.files) ? message.files : [])
    .map((file) => String(file?.name || ''))
    .filter(Boolean);
}

function sameAttachmentNames(a, b) {
  const left = attachmentNames(a);
  const right = attachmentNames(b);
  return left.length > 0 && left.length === right.length && left.every((name, index) => name === right[index]);
}

function sentTimesClose(a, b) {
  if (a?.sentAtMs == null || b?.sentAtMs == null) return false;
  return Math.abs(Number(a.sentAtMs) - Number(b.sentAtMs)) < 10000;
}

function textsMatch(server, local) {
  const serverText = String(server?.text || '').trim();
  const localText = String(local?.text || '').trim();
  if (!serverText || !localText) return false;
  return serverText === localText;
}

function claimUnbound(server, localList, used) {
  if (!server || server.who !== 'me' || messageIsForward(server)) return null;
  let bestIndex = -1;
  let bestScore = Infinity;
  for (let index = 0; index < localList.length; index += 1) {
    if (used.has(index)) continue;
    const candidate = localList[index];
    if (!candidate || candidate.serverId || candidate.who !== 'me' || messageIsForward(candidate)) continue;
    if (!localHasExtra(candidate) && !textsMatch(server, candidate)) continue;
    let score = null;
    if (sameAttachmentNames(server, candidate)) score = 0;
    else if (sentTimesClose(server, candidate) && (
      isAttachmentPlaceholder(server.text)
      || textsMatch(server, candidate)
    )) {
      score = Math.abs(Number(server.sentAtMs) - Number(candidate.sentAtMs));
    } else if (textsMatch(server, candidate)) score = 5000;
    else if (
      isAttachmentPlaceholder(server.text)
      && isAttachmentPlaceholder(candidate.text)
      && localHasExtra(candidate)
    ) score = 8000;
    if (score == null || score >= bestScore) continue;
    bestScore = score;
    bestIndex = index;
  }
  if (bestIndex < 0) return null;
  used.add(bestIndex);
  return localList[bestIndex];
}

function applyLocalExtra(server, local) {
  const copy = { ...server, streaming: server.streaming === true };
  if (!local) return copy;
  if (Array.isArray(local.images) && local.images.length > 0) copy.images = local.images;
  if (Array.isArray(local.files) && local.files.length > 0) {
    copy.files = local.files.map(({ name, mimeType, size, dataUrl }) => ({
      name,
      mimeType,
      size,
      ...(dataUrl ? { dataUrl } : {}),
    }));
  }
  if (local.quote) copy.quote = local.quote;
  if (local.forward) copy.forward = local.forward;
  if (local.runId != null && copy.runId == null) copy.runId = local.runId;
  const serverText = String(server.text || '').trim();
  const localText = String(local.text || '').trim();
  if (localText && !isAttachmentPlaceholder(localText) && isAttachmentPlaceholder(serverText)) {
    copy.text = local.text;
  }
  if (server.serverId) copy.serverId = server.serverId;
  return copy;
}

function composeServerTranscript(serverMessages, localMessages) {
  const server = Array.isArray(serverMessages) ? serverMessages : [];
  const local = Array.isArray(localMessages) ? localMessages : [];
  const used = new Set();

  function claimById(row) {
    if (!row?.serverId) return null;
    for (let index = 0; index < local.length; index += 1) {
      if (used.has(index)) continue;
      if (local[index]?.serverId === row.serverId) {
        used.add(index);
        return local[index];
      }
    }
    return null;
  }

  const rows = server.map((row) => applyLocalExtra(row, claimById(row) || claimUnbound(row, local, used)));

  for (let index = 0; index < local.length; index += 1) {
    if (used.has(index)) continue;
    const message = local[index];
    if (!message || message.kind === 'tool') continue;
    if (message.serverId && server.some((row) => row?.serverId === message.serverId)) continue;
    if (message.streaming && message.who === 'them') {
      rows.push({ ...message });
      continue;
    }
    if (!message.serverId && message.who === 'me' && message.pendingSend) rows.push({ ...message });
  }
  return rows;
}

const api = { composeServerTranscript };
if (moduleObj && moduleObj.exports) moduleObj.exports = api;
if (root) root.MessageCompose = api;
})(typeof window !== 'undefined' ? window : globalThis, typeof module === 'object' ? module : null);
