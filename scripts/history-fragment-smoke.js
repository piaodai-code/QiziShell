const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const start = source.indexOf('function collapseAssistantPrefixes(');
const end = source.indexOf('function isAssistantReplyComplete(');
if (start < 0 || end < start) throw new Error('collapseAssistantPrefixes not found');
const collapseAssistantPrefixes = new Function(`${source.slice(start, end)}; return collapseAssistantPrefixes;`)();

const collapsed = collapseAssistantPrefixes([
  { who: 'me', text: 'https://www.youtube.com/watch?v=tErKfdovz58' },
  { who: 'them', text: '5 条视频已全部下载完成，均为横屏 1280×720 分辨率，保存在桌面根目录。' },
  { who: 'them', text: '5' },
  { who: 'them', text: '5 条视频已全部下载完成，均为横' },
  { who: 'them', text: '5 条视频已全部下载完成，均为横屏 1280×720 分辨率，保存在桌面根目录。\n-' },
  { who: 'them', text: '本次扫描账号43个' },
]);
if (collapsed.length !== 3) throw new Error(`expected user + full reply + later note, got ${collapsed.length}`);
if (collapsed[0].who !== 'me') throw new Error('user bubble was dropped');
if (!collapsed[1].text.includes('1280×720') || collapsed[1].text === '5') {
  throw new Error('kept a fragment instead of the full reply');
}
if (collapsed[2].text !== '本次扫描账号43个') throw new Error('unrelated assistant message was dropped');

const grown = collapseAssistantPrefixes([
  { who: 'them', text: '先确认' },
  { who: 'them', text: '先确认要写入的位置。' },
]);
if (grown.length !== 1 || !grown[0].text.includes('位置')) {
  throw new Error('growing prefix should keep the longer bubble');
}

console.log('history-fragment smoke ok');
