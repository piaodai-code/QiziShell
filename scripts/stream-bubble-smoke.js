const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '../chat-timeline.js'), 'utf8');
const context = { window: {}, console };
vm.createContext(context);
vm.runInContext(code, context);

function harness() {
  const messages = [];
  let seq = 0;
  const timeline = context.window.ChatTimeline.create({
    getMessages: () => messages,
    getScope: () => ({ sessionKey: 's', chatEpoch: 1 }),
    allocId: () => {
      seq += 1;
      return `m-${seq}`;
    },
    now: () => '12:00',
    formatEnvelopeTime: () => '12:00',
    isPlaceholderText: (text) => {
      const trimmed = String(text || '').trim();
      return !trimmed || trimmed === '…';
    },
    onArchive: () => {},
    onRender: () => {},
    onRenderStream: () => {},
  });
  return { messages, timeline };
}

function them(messages) {
  return messages.filter((message) => message.who === 'them');
}

const growing = harness();
growing.timeline.enqueueDelta({ runId: 1, replace: true, fullText: '先确认要写入的位置。' });
growing.timeline.enqueueDone({ runId: 1, text: '先确认要写入的位置。', replace: true });
growing.timeline.enqueueDelta({
  runId: 2,
  replace: true,
  fullText: '先确认要写入的位置。格式已经清楚。',
});
if (them(growing.messages).length !== 1) {
  throw new Error(`expected one bubble, got ${them(growing.messages).length}`);
}
if (!growing.messages[0].streaming || !String(growing.messages[0].text).includes('格式已经清楚')) {
  throw new Error(`expected the same bubble to keep growing, got ${JSON.stringify(growing.messages[0])}`);
}

const settled = harness();
settled.timeline.enqueueDelta({ runId: 1, replace: true, fullText: '最终答复' });
settled.timeline.enqueueDone({ runId: 1, text: '最终答复', replace: true });
settled.timeline.enqueueDelta({ runId: 2, replace: true, fullText: '最终答复' });
if (them(settled.messages).length !== 1 || settled.messages[0].streaming) {
  throw new Error(`identical snapshot should stay one finished bubble, got ${JSON.stringify(settled.messages)}`);
}

const nextTurn = harness();
nextTurn.timeline.enqueueDelta({ runId: 1, replace: true, fullText: '上一轮' });
nextTurn.timeline.enqueueDone({ runId: 1, text: '上一轮', replace: true });
nextTurn.messages.push({ who: 'me', text: '再问一句' });
nextTurn.timeline.enqueueDelta({ runId: 3, replace: true, fullText: '上一轮之后的新答复' });
if (them(nextTurn.messages).length !== 2) {
  throw new Error(`a later user message should start a new bubble, got ${them(nextTurn.messages).length}`);
}

console.log('stream-bubble smoke ok');
