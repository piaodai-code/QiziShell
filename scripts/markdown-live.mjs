import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

const HEADING = {
  ATXHeading1: 'cm-md-h1',
  ATXHeading2: 'cm-md-h2',
  ATXHeading3: 'cm-md-h3',
  ATXHeading4: 'cm-md-h4',
  ATXHeading5: 'cm-md-h5',
  ATXHeading6: 'cm-md-h6',
  SetextHeading1: 'cm-md-h1',
  SetextHeading2: 'cm-md-h2',
};

const INLINE = {
  StrongEmphasis: 'cm-md-strong',
  Emphasis: 'cm-md-em',
  Strikethrough: 'cm-md-strike',
  InlineCode: 'cm-md-code',
  Link: 'cm-md-link',
  Image: 'cm-md-image',
  Autolink: 'cm-md-link',
  Subscript: 'cm-md-sub',
  Superscript: 'cm-md-sup',
};

const styleMark = new Map();
const lineMark = new Map();

function styleDeco(cls) {
  let deco = styleMark.get(cls);
  if (!deco) {
    deco = Decoration.mark({ class: cls });
    styleMark.set(cls, deco);
  }
  return deco;
}

function lineDeco(cls) {
  let deco = lineMark.get(cls);
  if (!deco) {
    deco = Decoration.line({ class: cls });
    lineMark.set(cls, deco);
  }
  return deco;
}

const hideDeco = Decoration.replace({});

class BulletWidget extends WidgetType {
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-md-bullet';
    span.textContent = '•';
    return span;
  }

  eq() { return true; }

  ignoreEvent() { return false; }
}
BulletWidget.prototype.liveKind = 'bullet';
const bulletDeco = Decoration.replace({ widget: new BulletWidget() });

class RuleWidget extends WidgetType {
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-hr';
    const hr = document.createElement('hr');
    wrap.appendChild(hr);
    return wrap;
  }

  eq() { return true; }

  get estimatedHeight() { return 17; }

  ignoreEvent() { return false; }
}
RuleWidget.prototype.liveKind = 'rule';
// Stop before the newline and keep the default inclusive end. Extending onto
// the next line glues that line into this widget, so clicks land below it.
const ruleDeco = Decoration.replace({ widget: new RuleWidget(), block: true });

class CollapseWidget extends WidgetType {
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-md-collapse';
    return span;
  }

  eq() { return true; }

  get estimatedHeight() { return 0; }

  ignoreEvent() { return false; }
}
CollapseWidget.prototype.liveKind = 'collapse';
const collapseDeco = Decoration.replace({ widget: new CollapseWidget(), block: true });

const CELL_TAGS = {
  strong: 'strong',
  em: 'em',
  strike: 's',
  code: 'code',
  link: 'span',
};

function fillCell(el, cell) {
  for (const seg of cell.segments) {
    let node = document.createTextNode(seg.text);
    for (const style of seg.styles) {
      const wrap = document.createElement(CELL_TAGS[style] || 'span');
      if (style === 'link') wrap.className = 'cm-md-link';
      wrap.appendChild(node);
      node = wrap;
    }
    el.appendChild(node);
  }
  el.dataset.offset = String(cell.offset);
}

class TableWidget extends WidgetType {
  constructor(data) {
    super();
    this.data = data;
  }

  eq(other) { return other.data.key === this.data.key; }

  get estimatedHeight() { return (this.data.rows.length + 1) * 30 + 16; }

  toDOM(view) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-table-widget';
    const table = document.createElement('table');
    const { header, rows, aligns } = this.data;
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    header.forEach((cell, index) => {
      const th = document.createElement('th');
      if (aligns[index]) th.style.textAlign = aligns[index];
      fillCell(th, cell);
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    if (rows.length) {
      const tbody = document.createElement('tbody');
      for (const row of rows) {
        const tr = document.createElement('tr');
        row.forEach((cell, index) => {
          const td = document.createElement('td');
          if (aligns[index]) td.style.textAlign = aligns[index];
          fillCell(td, cell);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    }
    wrap.appendChild(table);
    wrap.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const cell = event.target.closest('[data-offset]');
      const start = view.posAtDOM(wrap);
      const offset = cell ? Number(cell.dataset.offset) || 0 : 0;
      view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, start + offset) } });
      view.focus();
    });
    return wrap;
  }
}
TableWidget.prototype.liveKind = 'table';

const SKIP_IN_CELL = new Set([
  'EmphasisMark', 'CodeMark', 'LinkMark', 'URL', 'LinkTitle', 'LinkLabel',
  'StrikethroughMark', 'SubscriptMark', 'SuperscriptMark', 'TableDelimiter',
]);
const CELL_STYLE = {
  StrongEmphasis: 'strong',
  Emphasis: 'em',
  Strikethrough: 'strike',
  InlineCode: 'code',
  Link: 'link',
  Autolink: 'link',
  Image: 'link',
};

function unescapePipes(text) {
  return text.replace(/\\\|/g, '|');
}

function inlineSegments(doc, node, from, to, styles, out) {
  let pos = from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.to <= from || child.from >= to) continue;
    if (child.from > pos) out.push({ text: unescapePipes(doc.sliceString(pos, child.from)), styles });
    if (child.name === 'Escape') {
      out.push({ text: doc.sliceString(child.from + 1, child.to), styles });
    } else if (!SKIP_IN_CELL.has(child.name)) {
      const style = CELL_STYLE[child.name];
      inlineSegments(doc, child, child.from, child.to, style ? [...styles, style] : styles, out);
    }
    pos = Math.max(pos, child.to);
  }
  if (pos < to) out.push({ text: unescapePipes(doc.sliceString(pos, to)), styles });
  return out;
}

function splitRow(text, base) {
  const cells = [];
  let i = 0;
  while (i < text.length && isSpace(text[i])) i += 1;
  if (text[i] === '|') i += 1;
  let start = i;
  let tick = 0;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '`') {
      let run = 1;
      while (text[i + run] === '`') run += 1;
      if (!tick) tick = run;
      else if (tick === run) tick = 0;
      i += run - 1;
      continue;
    }
    if (ch === '|' && !tick) {
      cells.push([start, i]);
      start = i + 1;
    }
  }
  if (text.slice(start).trim()) cells.push([start, text.length]);
  return cells.map(([s, e]) => {
    let a = s;
    let b = e;
    while (a < b && isSpace(text[a])) a += 1;
    while (b > a && isSpace(text[b - 1])) b -= 1;
    return { from: base + a, to: base + b };
  });
}

function cellAlign(text) {
  const t = text.trim();
  const left = t.startsWith(':');
  const right = t.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return '';
}

function tableData(doc, tableNode, start) {
  let headerNode = null;
  let delimNode = null;
  const rowNodes = [];
  for (let child = tableNode.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableHeader') headerNode = child;
    else if (child.name === 'TableDelimiter' && !delimNode) delimNode = child;
    else if (child.name === 'TableRow') rowNodes.push(child);
  }
  if (!headerNode) return null;

  function readRow(rowNode, width) {
    const cellNodes = [];
    for (let child = rowNode.firstChild; child; child = child.nextSibling) {
      if (child.name === 'TableCell') cellNodes.push(child);
    }
    const spans = splitRow(doc.sliceString(rowNode.from, rowNode.to), rowNode.from);
    const count = width || spans.length;
    const cells = [];
    for (let index = 0; index < count; index += 1) {
      const span = spans[index];
      if (!span) {
        cells.push({ offset: rowNode.to - start, segments: [] });
        continue;
      }
      const owner = cellNodes.find((cell) => cell.from >= span.from && cell.to <= span.to);
      const segments = owner
        ? inlineSegments(doc, owner, span.from, span.to, [], [])
        : [{ text: unescapePipes(doc.sliceString(span.from, span.to)), styles: [] }];
      cells.push({ offset: span.from - start, segments });
    }
    return cells;
  }

  const header = readRow(headerNode, 0);
  const width = header.length;
  const aligns = delimNode
    ? splitRow(doc.sliceString(delimNode.from, delimNode.to), delimNode.from)
      .map((span) => cellAlign(doc.sliceString(span.from, span.to)))
    : [];
  const rows = rowNodes.map((row) => readRow(row, width));
  return { header, rows, aligns };
}

const KIND_DECO = {
  hide: hideDeco,
  bullet: bulletDeco,
  rule: ruleDeco,
  collapse: collapseDeco,
};

function parentName(node) {
  const parent = node.node?.parent;
  return parent ? parent.name : '';
}

function activeLines(state) {
  const lines = new Set();
  for (const range of state.selection.ranges) {
    const from = state.doc.lineAt(range.from).number;
    const to = state.doc.lineAt(range.to).number;
    for (let n = from; n <= to; n += 1) lines.add(n);
  }
  return lines;
}

function frontmatterEnd(doc) {
  if (doc.lines < 2 || doc.line(1).text.trim() !== '---') return -1;
  const limit = Math.min(doc.lines, 80);
  for (let n = 2; n <= limit; n += 1) {
    if (doc.line(n).text.trim() === '---') return doc.line(n).to;
  }
  return -1;
}

function isSpace(ch) {
  return ch === ' ' || ch === '\t';
}

function isFenceLine(text) {
  return /^\s{0,3}(`{3,}|~{3,})/.test(text);
}

function mergeHides(ranges) {
  ranges.sort((a, b) => a.from - b.from || b.to - a.to);
  const out = [];
  for (const range of ranges) {
    if (range.to <= range.from) continue;
    const last = out[out.length - 1];
    if (last && range.from < last.to) continue;
    if (last && range.from === last.to && last.kind === 'hide' && range.kind === 'hide') {
      last.to = range.to;
      continue;
    }
    out.push({ from: range.from, to: range.to, kind: range.kind, deco: range.deco });
  }
  return out;
}

function finishSet(items, kind) {
  const builder = new RangeSetBuilder();
  if (kind === 'line') {
    const keys = [...items.keys()].sort((a, b) => a - b);
    for (const pos of keys) {
      for (const cls of items.get(pos)) builder.add(pos, pos, lineDeco(cls));
    }
    return builder.finish();
  }
  if (kind === 'mark') {
    items.sort((a, b) => a.from - b.from || a.to - b.to);
    for (const item of items) builder.add(item.from, item.to, styleDeco(item.cls));
    return builder.finish();
  }
  for (const item of items) builder.add(item.from, item.to, item.deco || KIND_DECO[item.kind]);
  return builder.finish();
}

export function buildLiveDecorations(state) {
  ensureSyntaxTree(state, state.doc.length, 250);
  const doc = state.doc;
  const active = activeLines(state);
  const frontEnd = frontmatterEnd(doc);
  const lineMap = new Map();
  const marks = [];
  const hides = [];

  function addLine(pos, cls) {
    let set = lineMap.get(pos);
    if (!set) {
      set = new Set();
      lineMap.set(pos, set);
    }
    set.add(cls);
  }

  function addLineSpan(from, to, cls) {
    let pos = from;
    while (pos < to && pos <= doc.length) {
      const line = doc.lineAt(pos);
      addLine(line.from, cls);
      const next = line.to + 1;
      if (next <= pos) break;
      pos = next;
    }
  }

  function conceal(pos) {
    return !active.has(doc.lineAt(pos).number);
  }

  function blockActive(from, to) {
    let pos = from;
    while (pos < to && pos <= doc.length) {
      const line = doc.lineAt(pos);
      if (active.has(line.number)) return true;
      const next = line.to + 1;
      if (next <= pos) break;
      pos = next;
    }
    return false;
  }

  function hideSpan(from, to, kind = 'hide') {
    if (to > from) hides.push({ from, to, kind });
  }

  function hideMark(from, to, eat) {
    let start = from;
    let end = to;
    if (eat === 'after' && isSpace(doc.sliceString(end, end + 1))) end += 1;
    if (eat === 'before' && start > 0 && isSpace(doc.sliceString(start - 1, start))) start -= 1;
    hideSpan(start, end);
  }

  if (frontEnd >= 0) {
    for (let n = 1; n <= doc.lines; n += 1) {
      const line = doc.line(n);
      if (line.from > frontEnd) break;
      addLine(line.from, 'cm-md-frontmatter');
    }
  }

  syntaxTree(state).iterate({
    from: 0,
    to: doc.length,
    enter(node) {
      const name = node.name;
      if (name === 'Document') return;
      if (frontEnd >= 0 && node.to <= frontEnd) return false;

      if (HEADING[name]) addLine(doc.lineAt(node.from).from, HEADING[name]);
      else if (name === 'FencedCode' || name === 'CodeBlock') {
        addLineSpan(node.from, node.to, 'cm-md-codeblock');
        if (name === 'FencedCode' && !blockActive(node.from, node.to)) {
          const open = doc.lineAt(node.from);
          const close = doc.lineAt(Math.max(node.from, node.to - 1));
          if (isFenceLine(open.text)) hideSpan(open.from, open.to, 'collapse');
          if (close.from !== open.from && isFenceLine(close.text)) {
            hideSpan(close.from, close.to, 'collapse');
          }
        }
      } else if (name === 'Blockquote') addLineSpan(node.from, node.to, 'cm-md-quote');
      else if (name === 'Table') {
        const first = doc.lineAt(node.from);
        const last = doc.lineAt(Math.max(node.from, node.to));
        if (blockActive(first.from, last.to + 1)) {
          addLineSpan(node.from, node.to, 'cm-md-table');
          return false;
        }
        const data = tableData(doc, node.node, first.from);
        if (!data) {
          addLineSpan(node.from, node.to, 'cm-md-table');
          return false;
        }
        data.key = doc.sliceString(first.from, last.to);
        hides.push({
          from: first.from,
          to: last.to,
          kind: 'table',
          deco: Decoration.replace({ widget: new TableWidget(data), block: true, inclusiveEnd: true }),
        });
        return false;
      }
      else if (name === 'HorizontalRule') {
        if (conceal(node.from)) {
          const line = doc.lineAt(node.from);
          hideSpan(line.from, line.to, 'rule');
        }
        return false;
      } else if (INLINE[name]) marks.push({ from: node.from, to: node.to, cls: INLINE[name] });

      if (!conceal(node.from)) return;

      if (name === 'HeaderMark') {
        const line = doc.lineAt(node.from);
        const mark = doc.sliceString(node.from, node.to).trim();
        if (mark && !mark.includes('#') && line.text.trim() === mark) {
          hideSpan(line.from, line.to, 'collapse');
        }
        else if (isSpace(doc.sliceString(node.to, node.to + 1))) hideMark(node.from, node.to, 'after');
        else hideMark(node.from, node.to, 'before');
      } else if (
        name === 'EmphasisMark'
        || name === 'StrikethroughMark'
        || name === 'SubscriptMark'
        || name === 'SuperscriptMark'
      ) hideSpan(node.from, node.to);
      else if (name === 'CodeMark' && parentName(node) === 'InlineCode') hideSpan(node.from, node.to);
      else if (name === 'QuoteMark') hideMark(node.from, node.to, 'after');
      else if (name === 'ListMark' && /^[-*+]$/.test(doc.sliceString(node.from, node.to))) {
        const to = isSpace(doc.sliceString(node.to, node.to + 1)) ? node.to + 1 : node.to;
        hideSpan(node.from, to, 'bullet');
      } else if (name === 'LinkMark' && /^(Link|Image|Autolink)$/.test(parentName(node))) {
        hideSpan(node.from, node.to);
      } else if (name === 'URL' && /^(Link|Image)$/.test(parentName(node))) hideSpan(node.from, node.to);
    },
  });

  const merged = mergeHides(hides);
  const atomic = merged.filter((item) => item.kind === 'hide' || item.kind === 'bullet');
  return {
    lines: finishSet(lineMap, 'line'),
    marks: finishSet(marks, 'mark'),
    hides: finishSet(merged, 'hide'),
    atomic: finishSet(atomic, 'hide'),
  };
}

const emptyLive = {
  lines: Decoration.none,
  marks: Decoration.none,
  hides: Decoration.none,
  atomic: Decoration.none,
};

function safeLiveDecorations(state) {
  try {
    return buildLiveDecorations(state);
  } catch (err) {
    console.error(err);
    return emptyLive;
  }
}

const liveField = StateField.define({
  create(state) {
    return safeLiveDecorations(state);
  },
  update(value, tr) {
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (!tr.docChanged && !tr.selection && !treeChanged) return value;
    return safeLiveDecorations(tr.state);
  },
  provide(field) {
    return [
      EditorView.decorations.from(field, (value) => value.lines),
      EditorView.decorations.from(field, (value) => value.marks),
      EditorView.decorations.from(field, (value) => value.hides),
      EditorView.atomicRanges.of((view) => view.state.field(field).atomic),
    ];
  },
});

const liveTheme = EditorView.baseTheme({
  '.cm-md-h1': { fontSize: '22px', fontWeight: '700', lineHeight: '1.35' },
  '.cm-md-h2': { fontSize: '18px', fontWeight: '700', lineHeight: '1.35' },
  '.cm-md-h3': { fontSize: '16px', fontWeight: '650', lineHeight: '1.4' },
  '.cm-md-h4, .cm-md-h5, .cm-md-h6': { fontSize: '14px', fontWeight: '650', lineHeight: '1.45' },
  '.cm-md-strong': { fontWeight: '700' },
  '.cm-md-em': { fontStyle: 'italic' },
  '.cm-md-strike': { textDecoration: 'line-through' },
  '.cm-md-code': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '0.92em',
    backgroundColor: '#f3f3f3',
    borderRadius: '4px',
    padding: '1px 4px',
  },
  '.cm-md-link, .cm-md-image': { color: '#174ea6' },
  '.cm-md-link': { textDecoration: 'underline' },
  '.cm-md-quote': { borderLeft: '3px solid #d7d4f0', paddingLeft: '10px' },
  '.cm-md-codeblock': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '12.5px',
    lineHeight: '1.55',
    backgroundColor: '#f6f6f6',
  },
  '.cm-md-table, .cm-md-frontmatter': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '12.5px',
    lineHeight: '1.55',
  },
  '.cm-md-frontmatter': { color: '#666', backgroundColor: '#f7f7f5' },
  '.cm-md-bullet': {
    display: 'inline-block',
    width: '1.15em',
    color: '#6f6aae',
  },
  '.cm-md-hr': { display: 'block', padding: '8px 0' },
  '.cm-md-hr hr': {
    display: 'block',
    height: '0',
    border: 'none',
    borderTop: '1px solid #e4e4e4',
    margin: '0',
  },
  '.cm-md-collapse': { display: 'block', height: '0', overflow: 'hidden' },
  '.cm-md-table-widget': {
    padding: '6px 0',
    overflowX: 'auto',
    cursor: 'text',
  },
  '.cm-md-table-widget table': {
    borderCollapse: 'collapse',
    fontSize: '13px',
    lineHeight: '1.5',
  },
  '.cm-md-table-widget th, .cm-md-table-widget td': {
    border: '1px solid #e4e4e4',
    padding: '4px 10px',
    textAlign: 'left',
    verticalAlign: 'top',
  },
  '.cm-md-table-widget th': { backgroundColor: '#f7f7f5', fontWeight: '600' },
  '.cm-md-table-widget code': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '0.92em',
    backgroundColor: '#f3f3f3',
    borderRadius: '4px',
    padding: '1px 4px',
  },
  '.cm-md-sub': { fontSize: '0.8em', verticalAlign: 'sub' },
  '.cm-md-sup': { fontSize: '0.8em', verticalAlign: 'super' },
});

export function liveMarkdown() {
  return [liveTheme, liveField];
}
