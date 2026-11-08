const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const start = source.indexOf('function localMessageHasAttachments(');
const end = source.indexOf('function clearStaleStreamingState(');
if (start < 0 || end < start) {
  throw new Error('overlay function not found');
}

const ATTACHMENT_ONLY_CAPTIONS = new Set([
  '（附件）', '（图片）', '[图片]', '[附件]', '[User sent media without caption]',
]);

function isAttachmentPlaceholder(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  return ATTACHMENT_ONLY_CAPTIONS.has(trimmed);
}

function messageIsForward(message) {
  return Boolean(message?.forward?.text);
}

function findLocalUserMessageForServer(server, list) {
  const serverText = String(server?.text || '').trim();
  if (!serverText || messageIsForward(server)) return null;
  return (list || []).find((candidate) => (
    candidate?.who === 'me'
    && !messageIsForward(candidate)
    && String(candidate.text || '').trim() === serverText
  )) || null;
}

function normalizeUserMessageRecord(message) {
  return { ...message, streaming: false };
}

const context = {
  isAttachmentPlaceholder,
  messageIsForward,
  findLocalUserMessageForServer,
  normalizeUserMessageRecord,
};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);

const oldRant = '我发现我说话，你从来不认真听！';
const local = [
  {
    who: 'me',
    text: oldRant,
    images: ['data:image/png;base64,old'],
    sentAtMs: 1000,
  },
  {
    who: 'them',
    text: '当时的回复',
    sentAtMs: 2000,
  },
  {
    who: 'me',
    text: '',
    files: [{ name: 'distill-materials.md', size: 12, dataUrl: 'data:text/markdown;base64,ZmlsZQ==' }],
    sentAtMs: 900000,
  },
];
const server = [
  { who: 'me', text: oldRant, sentAtMs: 1000 },
  { who: 'them', text: '当时的回复', sentAtMs: 2000 },
  { who: 'me', text: '', files: [{ name: 'distill-materials.md' }], sentAtMs: 900400 },
  { who: 'them', text: '文件已经收到。', sentAtMs: 901000 },
];

const merged = context.overlayLocalAttachmentsOntoServerHistory(server, local);
const fileMessage = merged[2];
if (fileMessage.text && fileMessage.text.includes('从来不认真听')) {
  throw new Error(`file bubble took the old text: ${fileMessage.text}`);
}
if (fileMessage.images?.length) {
  throw new Error('file bubble took the old image');
}
if (fileMessage.files?.[0]?.name !== 'distill-materials.md') {
  throw new Error(`file bubble lost the file: ${JSON.stringify(fileMessage.files)}`);
}
if (!String(fileMessage.files[0].dataUrl || '').startsWith('data:')) {
  throw new Error('file bubble lost the local file body');
}
if (merged[0].text !== oldRant || merged[0].images?.[0] !== 'data:image/png;base64,old') {
  throw new Error('old message lost its own image');
}

const captioned = context.overlayLocalAttachmentsOntoServerHistory(
  [{ who: 'me', text: '', sentAtMs: 5000 }],
  [{ who: 'me', text: '看这个', images: ['data:image/png;base64,new'], sentAtMs: 5200 }],
);
if (captioned[0].text !== '看这个' || captioned[0].images?.[0] !== 'data:image/png;base64,new') {
  throw new Error(`caption was not kept: ${JSON.stringify(captioned[0])}`);
}

console.log('history-overlay smoke ok');
