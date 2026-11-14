import { EditorSelection, EditorState, Prec, Compartment } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  placeholder as cmPlaceholder,
} from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { indentWithTab, history, defaultKeymap, historyKeymap, insertNewline } from '@codemirror/commands';
import {
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
} from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { liveMarkdown } from './markdown-live.mjs';

const sourceTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: '#fff',
  },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: '1.55',
  },
  '.cm-content': {
    padding: '12px 0',
    caretColor: '#174ea6',
  },
  '.cm-gutters': {
    backgroundColor: '#f7f7f5',
    color: '#8a8a8a',
    borderRight: '1px solid #eee',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-activeLineGutter': { backgroundColor: '#e8f0fe' },
});

const liveChrome = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: '#fff',
  },
  '.cm-scroller': {
    fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    lineHeight: '1.65',
  },
  '.cm-content': {
    padding: '16px 18px 32px',
    caretColor: '#174ea6',
  },
  '.cm-gutters': { display: 'none' },
  '&.cm-focused': { outline: 'none' },
});

const composerChrome = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '14px',
    backgroundColor: 'transparent',
  },
  '.cm-scroller': {
    fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    lineHeight: '1.6',
    overflow: 'auto',
  },
  '.cm-content': {
    padding: '12px 52px 12px 16px',
    caretColor: '#174ea6',
  },
  '.cm-gutters': { display: 'none' },
  '&.cm-focused': { outline: 'none' },
  '.cm-placeholder': {
    color: '#999',
    fontStyle: 'normal',
  },
});

const selectionColor = '#d7d4f0';
const selectionTheme = Prec.highest(EditorView.theme({
  '.cm-activeLine': { backgroundColor: 'transparent !important' },
  '.cm-selectionBackground': { backgroundColor: `${selectionColor} !important` },
  '.cm-content ::selection, .cm-line::selection': { backgroundColor: `${selectionColor} !important` },
}));

function modeExtensions(live, variant) {
  if (live && variant === 'composer') return [composerChrome, liveMarkdown()];
  if (live) return [liveChrome, liveMarkdown()];
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    foldGutter(),
    highlightActiveLine(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    keymap.of([...foldKeymap, indentWithTab]),
    sourceTheme,
  ];
}

function placeholderExtensions(text) {
  const value = String(text || '');
  return value ? [cmPlaceholder(value)] : [];
}

function editableExtensions(on) {
  return [
    EditorView.editable.of(on !== false),
    EditorState.readOnly.of(on === false),
  ];
}

function mount(parent, handlers = {}) {
  let applying = false;
  let live = handlers.live !== false;
  const variant = handlers.variant === 'composer' ? 'composer' : '';
  const mode = new Compartment();
  const placeholderSlot = new Compartment();
  const editableSlot = new Compartment();
  const keys = keymap.of([
    {
      key: 'Mod-s',
      preventDefault: true,
      run() {
        handlers.onSave?.();
        return true;
      },
    },
    {
      key: 'Shift-Enter',
      run: insertNewline,
    },
  ]);
  const extensions = [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightSelectionMatches(),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...completionKeymap,
    ]),
    markdown({ base: markdownLanguage }),
    keys,
    selectionTheme,
    EditorView.lineWrapping,
    mode.of(modeExtensions(live, variant)),
    placeholderSlot.of(placeholderExtensions(handlers.placeholder)),
    editableSlot.of(editableExtensions(handlers.editable !== false)),
    Prec.highest(EditorView.domEventHandlers({
      keydown(event) {
        return handlers.onKeyDown?.(event) === true;
      },
      paste(event) {
        return handlers.onPaste?.(event) === true;
      },
      blur() {
        handlers.onBlur?.();
        return false;
      },
      contextmenu(event) {
        return handlers.onContextMenu?.(event) === true;
      },
      drop(event) {
        if (variant !== 'composer') return false;
        const transfer = event.dataTransfer;
        if (!transfer) return false;
        const types = Array.from(transfer.types || []);
        const dropped = transfer.files ? Array.from(transfer.files) : [];
        if (!dropped.length && !types.includes('Files')) return false;
        event.preventDefault();
        if (dropped.length) handlers.onFiles?.(dropped);
        return true;
      },
    })),
    EditorView.updateListener.of((update) => {
      if (applying || !update.docChanged) return;
      handlers.onChange?.(update.state.doc.toString());
    }),
  ];
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: String(handlers.doc ?? ''),
      extensions,
    }),
  });
  parent.classList.toggle('is-live', live);

  return {
    setMode(next) {
      const isLive = next !== false;
      if (isLive === live) return;
      live = isLive;
      parent.classList.toggle('is-live', live);
      view.dispatch({ effects: mode.reconfigure(modeExtensions(live, variant)) });
    },
    setPlaceholder(text) {
      view.dispatch({
        effects: placeholderSlot.reconfigure(placeholderExtensions(text)),
      });
    },
    setEditable(on) {
      view.dispatch({
        effects: editableSlot.reconfigure(editableExtensions(on !== false)),
      });
    },
    getSelection() {
      const range = view.state.selection.main;
      return { from: range.from, to: range.to };
    },
    setSelection(from, to) {
      const docLength = view.state.doc.length;
      const anchor = Math.max(0, Math.min(Number(from) || 0, docLength));
      const head = Math.max(0, Math.min(Number(to ?? from) || 0, docLength));
      view.dispatch({ selection: EditorSelection.range(anchor, head) });
    },
    selectAll() {
      view.dispatch({
        selection: EditorSelection.range(0, view.state.doc.length),
      });
      view.focus();
    },
    contentHeight() {
      const style = view.contentDOM.ownerDocument.defaultView.getComputedStyle(view.contentDOM);
      const pad = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      return Math.ceil(view.contentHeight + pad);
    },
    isCaretOnFirstLine() {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      if (line.number > 1) return false;
      return Math.abs(view.lineBlockAt(head).top - view.lineBlockAt(line.from).top) < 2;
    },
    isCaretOnLastLine() {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      if (line.number < view.state.doc.lines) return false;
      return Math.abs(view.lineBlockAt(head).top - view.lineBlockAt(line.to).top) < 2;
    },
    hasFocus() {
      return view.hasFocus;
    },
    setDoc(text) {
      applying = true;
      const next = String(text ?? '');
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
        selection: EditorSelection.cursor(0),
      });
      applying = false;
    },
    getDoc() {
      return view.state.doc.toString();
    },
    focus() {
      view.focus();
    },
    relayout() {
      view.requestMeasure();
    },
    topLine() {
      const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
      return view.state.doc.lineAt(block.from).number;
    },
    scrollToLine(lineNumber) {
      const doc = view.state.doc;
      const target = Math.max(1, Math.min(doc.lines, lineNumber || 1));
      const current = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
      if (view.state.doc.lineAt(current.from).number === target) return;
      const line = doc.line(target);
      view.dispatch({
        effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 0 }),
      });
    },
    scrollRatio() {
      const el = view.scrollDOM;
      const max = el.scrollHeight - el.clientHeight;
      return max <= 0 ? 0 : el.scrollTop / max;
    },
    setScrollRatio(ratio) {
      const el = view.scrollDOM;
      const max = el.scrollHeight - el.clientHeight;
      el.scrollTop = Math.max(0, Math.min(1, Number(ratio) || 0)) * max;
    },
    destroy() {
      view.destroy();
    },
  };
}

export { mount };
