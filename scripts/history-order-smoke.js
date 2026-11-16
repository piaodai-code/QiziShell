const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const start = source.indexOf('function orderHistoryByTime(');
const end = source.indexOf('function finalizeHistoryMessages(');
if (start < 0 || end < start) throw new Error('orderHistoryByTime not found');
const orderHistoryByTime = new Function(`${source.slice(start, end)}; return orderHistoryByTime;`)();

const ordered = orderHistoryByTime([
  { who: 'me', text: '倒数第二条', sentAtMs: 200 },
  { who: 'them', text: '旧回复', sentAtMs: 150 },
  { who: 'me', text: '最后一条', sentAtMs: 300 },
  { who: 'them', text: '正在写', streaming: true },
  { who: 'them', text: '更早的几天前', sentAtMs: 100 },
]);
const texts = ordered.map((msg) => msg.text);
if (texts.join('|') !== '更早的几天前|旧回复|倒数第二条|最后一条|正在写') {
  throw new Error(`unexpected order: ${texts.join('|')}`);
}

const inherited = orderHistoryByTime([
  { who: 'me', text: 'ok，终稿', sentAtMs: 500 },
  { who: 'them', text: '当场回复' },
  { who: 'them', text: '后补的更早回复', sentAtMs: 400 },
]);
if (inherited.map((msg) => msg.text).join('|') !== '后补的更早回复|ok，终稿|当场回复') {
  throw new Error(`timestamp-less reply left the turn: ${inherited.map((msg) => msg.text).join('|')}`);
}

const stable = orderHistoryByTime([
  { who: 'me', text: '先', sentAtMs: 1 },
  { who: 'them', text: '后', sentAtMs: 1 },
]);
if (stable.map((msg) => msg.text).join('|') !== '先|后') {
  throw new Error('same timestamp should keep arrival order');
}

console.log('history-order smoke ok');
