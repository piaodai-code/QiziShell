const { composeServerTranscript } = require('../message-compose');

const oldRant = '我发现我说话，你从来不认真听！';
const local = [
  {
    who: 'me',
    text: oldRant,
    images: ['data:image/png;base64,old'],
    sentAtMs: 1000,
  },
  { who: 'them', text: '当时的回复', sentAtMs: 2000 },
  {
    who: 'me',
    text: '',
    files: [{ name: 'distill-materials.md', size: 12, dataUrl: 'data:text/markdown;base64,ZmlsZQ==' }],
    sentAtMs: 900000,
  },
];
const server = [
  { who: 'me', serverId: 'id:old', text: oldRant, sentAtMs: 1000 },
  { who: 'them', serverId: 'id:reply', text: '当时的回复', sentAtMs: 2000 },
  { who: 'me', serverId: 'id:file', text: '', files: [{ name: 'distill-materials.md' }], sentAtMs: 900400 },
  { who: 'them', serverId: 'id:ack', text: '文件已经收到。', sentAtMs: 901000 },
];

const merged = composeServerTranscript(server, local);
const fileMessage = merged[2];
if (fileMessage.text && fileMessage.text.includes('从来不认真听')) {
  throw new Error(`file bubble took the old text: ${fileMessage.text}`);
}
if (fileMessage.images?.length) throw new Error('file bubble took the old image');
if (fileMessage.files?.[0]?.name !== 'distill-materials.md') {
  throw new Error(`file bubble lost the file: ${JSON.stringify(fileMessage.files)}`);
}
if (!String(fileMessage.files[0].dataUrl || '').startsWith('data:')) {
  throw new Error('file bubble lost the local file body');
}
if (merged[0].text !== oldRant || merged[0].images?.[0] !== 'data:image/png;base64,old') {
  throw new Error('old message lost its own image');
}
if (merged[0].serverId !== 'id:old' || fileMessage.serverId !== 'id:file') {
  throw new Error('server ids were not kept');
}

const sameText = composeServerTranscript(
  [
    { who: 'me', serverId: 'id:a', text: '好' },
    { who: 'them', serverId: 'id:b', text: '好' },
    { who: 'me', serverId: 'id:c', text: '好' },
  ],
  [
    { who: 'me', serverId: 'id:a', text: '好', images: ['data:image/png;base64,a'] },
    { who: 'me', serverId: 'id:c', text: '好', images: ['data:image/png;base64,c'] },
  ],
);
if (sameText.length !== 3) throw new Error(`same text collapsed: ${sameText.length}`);
if (sameText[0].images?.[0] !== 'data:image/png;base64,a') throw new Error('first image moved');
if (sameText[2].images?.[0] !== 'data:image/png;base64,c') throw new Error('third image moved');
if (sameText[1].images?.length) throw new Error('assistant row took an image');

const captioned = composeServerTranscript(
  [{ who: 'me', serverId: 'id:new', text: '', sentAtMs: 5000 }],
  [{ who: 'me', text: '看这个', images: ['data:image/png;base64,new'], sentAtMs: 5200 }],
);
if (captioned[0].text !== '看这个' || captioned[0].images?.[0] !== 'data:image/png;base64,new') {
  throw new Error(`caption was not kept: ${JSON.stringify(captioned[0])}`);
}

const pending = composeServerTranscript(
  [{ who: 'them', serverId: 'id:old', text: '已有回复' }],
  [{ who: 'me', pendingSend: true, text: '刚发出' }],
);
if (pending.length !== 2 || pending[1].text !== '刚发出') {
  throw new Error(`pending send was dropped: ${JSON.stringify(pending)}`);
}

console.log('history-overlay smoke ok');
