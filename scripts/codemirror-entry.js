import { basicSetup } from 'codemirror';
import { EditorSelection, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { indentWithTab } from '@codemirror/commands';

const qiziTheme = EditorView.theme({
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
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-activeLineGutter': {
    backgroundColor: '#e8f0fe',
  },
});

const selectionColor = '#d7d4f0';
const selectionTheme = Prec.highest(EditorView.theme({
  '.cm-activeLine': {
    backgroundColor: 'transparent !important',
  },
  '.cm-selectionBackground': {
    backgroundColor: `${selectionColor} !important`,
  },
  '.cm-content ::selection, .cm-line::selection': {
    backgroundColor: `${selectionColor} !important`,
  },
}));

function mount(parent, handlers = {}) {
  let applying = false;
  const keys = keymap.of([
    {
      key: 'Mod-s',
      preventDefault: true,
      run() {
        handlers.onSave?.();
        return true;
      },
    },
    indentWithTab,
  ]);
  const extensions = [
    basicSetup,
    markdown(),
    keys,
    qiziTheme,
    selectionTheme,
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      if (applying || !update.docChanged) return;
      handlers.onChange?.(update.state.doc.toString());
    }),
  ];
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: '', extensions }),
  });
  view.scrollDOM.addEventListener('scroll', () => handlers.onScroll?.(), { passive: true });

  return {
    setDoc(text) {
      applying = true;
      view.setState(EditorState.create({
        doc: String(text ?? ''),
        extensions,
        selection: EditorSelection.cursor(0),
      }));
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
