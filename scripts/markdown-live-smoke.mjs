import assert from 'node:assert/strict';
import { EditorSelection, EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { buildLiveDecorations } from './markdown-live.mjs';

function state(doc, cursor) {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage })],
  });
}

function spans(set) {
  const out = [];
  set.between(0, 1e9, (from, to, value) => {
    out.push({
      from,
      to,
      className: value.spec?.class || '',
      kind: value.spec?.widget?.liveKind || (value.spec?.block ? 'block' : 'hide'),
    });
  });
  return out;
}

function covered(doc, list, index) {
  return list.some((span) => index >= span.from && index < span.to);
}

const heading = '# 标题\n\n正文\n**粗**';
const away = buildLiveDecorations(state(heading, heading.indexOf('正文')));
const awayHides = spans(away.hides);
assert.equal(heading.slice(awayHides.find((span) => span.from === 0).from, awayHides.find((span) => span.from === 0).to), '# ');
assert.ok(awayHides.some((span) => heading.slice(span.from, span.to) === '**'));
assert.ok(spans(away.lines).some((span) => span.className === 'cm-md-h1'));
assert.ok(spans(away.marks).some((span) => span.className === 'cm-md-strong'));

const here = spans(buildLiveDecorations(state(heading, 0)).hides);
assert.ok(!here.some((span) => span.from < heading.indexOf('\n')));
assert.ok(here.some((span) => heading.slice(span.from, span.to) === '**'));

const front = '---\nname: a\n---\n\n# 标题\n\n尾';
const frontHides = spans(buildLiveDecorations(state(front, front.indexOf('尾'))).hides);
assert.ok(!frontHides.some((span) => span.from < front.indexOf('# 标题')));
assert.ok(frontHides.some((span) => front.slice(span.from, span.to) === '# '));
assert.ok(spans(buildLiveDecorations(state(front, front.indexOf('尾'))).lines).some((span) => span.className === 'cm-md-frontmatter'));

const list = '段落\n\n- 项目\n';
const bullet = spans(buildLiveDecorations(state(list, 0)).hides).find((span) => span.kind === 'bullet');
assert.ok(bullet);
assert.equal(list.slice(bullet.from, bullet.to), '- ');

const ordered = '1. 第一\n\n尾';
const orderedHides = spans(buildLiveDecorations(state(ordered, ordered.indexOf('尾'))).hides);
assert.ok(!covered(ordered, orderedHides, ordered.indexOf('1')));

const fence = '前文\n\n```js\nconst a = 1;\n```\n\n尾';
const outside = spans(buildLiveDecorations(state(fence, fence.indexOf('尾'))).hides);
assert.ok(outside.some((span) => span.kind === 'collapse' && fence.slice(span.from, span.to) === '```js'));
assert.ok(spans(buildLiveDecorations(state(fence, fence.indexOf('尾'))).lines).some((span) => span.className === 'cm-md-codeblock'));
const inside = spans(buildLiveDecorations(state(fence, fence.indexOf('const'))).hides);
assert.ok(!inside.some((span) => span.kind === 'collapse'));

const table = '| 甲 | **乙** |\n| :--- | ---: |\n| 1 | `a\\|b` |\n|  | 4 |\n\n尾';
const awayTable = buildLiveDecorations(state(table, table.indexOf('尾')));
const tableWidget = spans(awayTable.hides).find((span) => span.kind === 'table');
assert.ok(tableWidget);
assert.equal(tableWidget.from, 0);
assert.equal(tableWidget.to, table.indexOf('\n\n尾'));
let widgetData = null;
awayTable.hides.between(0, 1e9, (from, to, value) => {
  if (value.spec?.widget?.liveKind === 'table') widgetData = value.spec.widget.data;
});
assert.deepEqual(widgetData.aligns, ['left', 'right']);
assert.equal(widgetData.header.length, 2);
assert.deepEqual(widgetData.header[1].segments, [{ text: '乙', styles: ['strong'] }]);
assert.equal(widgetData.rows.length, 2);
assert.equal(widgetData.rows[0][1].segments.map((seg) => seg.text).join(''), 'a|b');
assert.equal(widgetData.rows[1].length, 2);
assert.equal(widgetData.rows[1][1].segments[0].text, '4');
assert.equal(table.slice(widgetData.rows[1][1].offset, widgetData.rows[1][1].offset + 1), '4');
assert.ok(!spans(awayTable.lines).some((span) => span.className === 'cm-md-table'));

const inTable = buildLiveDecorations(state(table, table.indexOf('1 |')));
assert.ok(!spans(inTable.hides).some((span) => span.kind === 'table'));
assert.ok(!covered(table, spans(inTable.hides), table.indexOf('**')));
assert.ok(spans(inTable.lines).some((span) => span.className === 'cm-md-table'));

const strike = '前文\n\n~~删除~~';
const strikeHides = spans(buildLiveDecorations(state(strike, 0)).hides);
assert.ok(strikeHides.some((span) => strike.slice(span.from, span.to) === '~~'));

const ruled = '前文\n\n---\n\n尾';
const rule = spans(buildLiveDecorations(state(ruled, 0)).hides).find((span) => span.kind === 'rule');
assert.ok(rule);
assert.equal(ruled.slice(rule.from, rule.to), '---');

const setext = '标题\n=====\n\n尾';
const setextHides = spans(buildLiveDecorations(state(setext, setext.indexOf('尾'))).hides);
assert.ok(setextHides.some((span) => span.kind === 'collapse' && setext.slice(span.from, span.to).startsWith('=====')));
assert.ok(spans(buildLiveDecorations(state(setext, setext.indexOf('尾'))).lines).some((span) => span.className === 'cm-md-h1'));

const both = '***同时***\n\n尾';
assert.doesNotThrow(() => buildLiveDecorations(state(both, both.indexOf('尾'))));
const bothMarks = spans(buildLiveDecorations(state(both, both.indexOf('尾'))).marks);
assert.ok(bothMarks.some((span) => span.className === 'cm-md-strong'));
assert.ok(bothMarks.some((span) => span.className === 'cm-md-em'));

const task = '前文\n\n- [ ] 待办\n';
const taskHides = spans(buildLiveDecorations(state(task, 0)).hides);
const taskBullet = taskHides.find((span) => span.kind === 'bullet');
assert.equal(task.slice(taskBullet.from, taskBullet.to), '- ');
assert.ok(task.slice(taskBullet.to).startsWith('[ ]'));

console.log('markdown-live smoke ok');
