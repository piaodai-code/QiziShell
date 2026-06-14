function buildClientReplyToMeta(ref) {
  const author = ref?.authorLabel || '未知';
  const role = ref?.who === 'me' ? 'user' : 'assistant';
  const time = typeof ref?.time === 'string' && ref.time.trim() ? ref.time.trim() : '';
  return {
    label: author,
    role,
    time,
  };
}

function formatForwardForAgent(forward, userText) {
  const forwardedBody = String(forward?.text || '').trim();
  const replyTo = buildClientReplyToMeta(forward);
  const meta = {
    label: replyTo.label,
    role: replyTo.role,
    kind: 'forwarded-message',
    replyTo,
  };
  const parts = [
    'Sender (untrusted metadata):',
    '```json',
    JSON.stringify(meta),
    '```',
    '',
    '【转发开始】',
    forwardedBody,
    '【转发结束】',
  ];
  const tail = String(userText || '').trim();
  if (tail) {
    parts.push('', '【留言】', tail);
  }
  return parts.join('\n');
}

module.exports = {
  buildClientReplyToMeta,
  formatForwardForAgent,
};
