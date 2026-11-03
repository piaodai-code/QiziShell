const Model = window.CopyEditModel;

const editor = document.getElementById('ce-editor');
const sideList = document.getElementById('ce-side-list');
const metaEl = document.getElementById('ce-meta');
const statusEl = document.getElementById('ce-status');
const sendBtn = document.getElementById('ce-send');
const stashBtn = document.getElementById('ce-stash');
const discardBtn = document.getElementById('ce-discard');
const floatEl = document.getElementById('ce-float');
const dropCaretEl = document.getElementById('ce-drop-caret');
const popEl = document.getElementById('ce-pop');
const noteEl = document.getElementById('ce-note');
const noteInput = document.getElementById('ce-note-input');
const menuEl = document.getElementById('ce-menu');

const TYPE_LABEL = {
  insert: '新增',
  delete: '删除',
  replace: '替换',
  move: '移动',
  comment: '批注',
};
const STATUS_LABEL = {
  pending: '待处理',
  accepted: '已接受',
  rejected: '已拒绝',
};

let doc = Model.createDocument('');
let view = 'markup';
let meta = { agentLabel: '', sessionKey: '' };
let draftId = '';
let busy = false;
let composing = false;
let composeRange = null;
let composeDoneAt = 0;
let inputHandledAt = 0;

function inputJustHandled() {
  return Date.now() - inputHandledAt < 40;
}

function markInputHandled() {
  inputHandledAt = Date.now();
}
let noteRange = null;
let noteHost = '';
let menuRange = null;
let floatRange = null;
let popPatchId = '';
let pointerDrag = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clip(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function setStatus(text, isError) {
  statusEl.textContent = text || '';
  statusEl.classList.toggle('is-error', Boolean(isError));
}

function visibleLength(node) {
  return (node?.textContent || '').replace(/\u200b/g, '').length;
}

function posFromNode(node, offset) {
  if (!node) return null;
  const el = node.nodeType === 1 ? node : node.parentElement;
  const span = el?.closest?.('[data-i]');
  if (!span || !editor.contains(span)) return null;
  const pieceIndex = Number(span.dataset.i);
  if (span.dataset.empty === '1') return { pieceIndex, offset: 0 };
  if (node === span) {
    let count = 0;
    const limit = Math.min(offset, span.childNodes.length);
    for (let index = 0; index < limit; index += 1) count += visibleLength(span.childNodes[index]);
    return { pieceIndex, offset: count };
  }
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  let count = 0;
  let current = walker.nextNode();
  while (current) {
    const raw = current.textContent || '';
    if (current === node) {
      return { pieceIndex, offset: count + raw.slice(0, offset).replace(/\u200b/g, '').length };
    }
    if (node.nodeType === 1 && node.contains(current)) break;
    count += raw.replace(/\u200b/g, '').length;
    current = walker.nextNode();
  }
  if (node.nodeType === 1 && span.contains(node)) {
    let inner = 0;
    const limit = Math.min(offset, node.childNodes.length);
    for (let index = 0; index < limit; index += 1) inner += visibleLength(node.childNodes[index]);
    return { pieceIndex, offset: count + inner };
  }
  return { pieceIndex, offset: count };
}

function readRange() {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return null;
  const start = posFromNode(selection.anchorNode, selection.anchorOffset);
  const end = posFromNode(selection.focusNode, selection.focusOffset);
  if (!start || !end) return null;
  return { start, end, collapsed: selection.isCollapsed };
}

function pointInPiece(span, offset) {
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode();
  let last = null;
  while (node) {
    const text = node.textContent || '';
    if (remaining <= text.length) return { node, offset: remaining };
    remaining -= text.length;
    last = node;
    node = walker.nextNode();
  }
  if (last) return { node: last, offset: (last.textContent || '').length };
  return span.firstChild ? { node: span.firstChild, offset: 0 } : null;
}

function setDomCaret(spec) {
  const pieces = Model.buildPieces(doc);
  const placed = Model.placeCaret(pieces, spec);
  const span = editor.querySelector(`[data-i="${placed.pieceIndex}"]`);
  if (!span) return;
  const range = document.createRange();
  if (span.dataset.empty === '1') {
    if (!span.firstChild) return;
    range.setStart(span.firstChild, 0);
  } else {
    const point = pointInPiece(span, placed.offset);
    if (!point) return;
    range.setStart(point.node, point.offset);
  }
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function renderCommentedText(piece) {
  const ranges = Model.commentRangesInPiece(doc, piece);
  if (!ranges.length) return escapeHtml(piece.text);
  let html = '';
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) html += escapeHtml(piece.text.slice(cursor, range.start));
    const ids = range.ids.map((id) => escapeHtml(id)).join(' ');
    html += `<span class="ce-comment" data-comment-id="${ids}">${escapeHtml(piece.text.slice(range.start, range.end))}</span>`;
    cursor = range.end;
  }
  if (cursor < piece.text.length) html += escapeHtml(piece.text.slice(cursor));
  return html;
}

function renderPiece(piece, index) {
  const empty = !piece.text;
  const classes = ['ce-piece', `ce-${piece.kind}`];
  const text = empty ? '&#8203;' : renderCommentedText(piece);
  const patchAttr = piece.patchId ? ` data-patch-id="${escapeHtml(piece.patchId)}"` : '';
  const emptyAttr = empty ? ' data-empty="1"' : '';
  return `<span class="${classes.join(' ')}" data-i="${index}" data-kind="${piece.kind}"${patchAttr}${emptyAttr}>${text}</span>`;
}

function renderEditor(caret) {
  const scrollTop = editor.scrollTop;
  editor.classList.toggle('is-readonly', view !== 'markup');
  editor.contentEditable = view === 'markup' ? 'true' : 'false';
  if (view === 'markup') {
    const pieces = Model.buildPieces(doc);
    editor.innerHTML = pieces.map(renderPiece).join('');
  } else if (view === 'final') {
    const text = Model.finalText(doc);
    editor.innerHTML = text
      ? escapeHtml(text)
      : '<span class="ce-placeholder">终稿是空的</span>';
  } else {
    editor.innerHTML = doc.originalText
      ? escapeHtml(doc.originalText)
      : '<span class="ce-placeholder">原稿是空的</span>';
  }
  editor.scrollTop = scrollTop;
  if (caret && view === 'markup') setDomCaret(caret);
}

function patchPreview(patch) {
  if (patch.type === 'insert') return clip(patch.newText, 72);
  if (patch.type === 'delete') return clip(patch.oldText, 72);
  if (patch.type === 'replace') return `${clip(patch.oldText, 28)} → ${clip(patch.newText, 28)}`;
  if (patch.type === 'move') return clip(patch.oldText, 72);
  const note = patch.comments?.[0]?.content || '';
  return clip(note, 72);
}

function renderSidebar() {
  const items = [...doc.patches].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  if (!items.length) {
    sideList.innerHTML = '<div class="ce-empty-side">还没有修订。直接输入会标成新增，选中文字后删除、替换、拖动或加批注。</div>';
    return;
  }
  sideList.innerHTML = items.map((patch) => {
    const notes = (patch.comments || []).map((note) => (
      `<div class="ce-card-note">${escapeHtml(note.content)}</div>`
    )).join('');
    return `<button type="button" class="ce-card is-${patch.status}" data-side-id="${escapeHtml(patch.id)}">
      <div class="ce-card-top"><span class="ce-card-kind">${TYPE_LABEL[patch.type] || patch.type}</span><span>${STATUS_LABEL[patch.status] || ''}</span></div>
      <div class="ce-card-preview">${escapeHtml(patchPreview(patch) || '（空）')}</div>
      ${notes}
    </button>`;
  }).join('');
}

function updateChrome() {
  const pending = Model.pendingCount(doc);
  const who = meta.agentLabel ? `${meta.agentLabel} · ` : '';
  const draftNote = draftId ? ' · 暂存草稿' : '';
  metaEl.textContent = `${who}${doc.originalText.length} 字 · ${pending} 条待处理${draftNote}`;
  const touched = isDirty() || Boolean(draftId);
  stashBtn.disabled = busy || !touched;
  discardBtn.disabled = busy || !touched;
  sendBtn.disabled = busy || pending === 0;
  document.querySelectorAll('.ce-view').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function hideFloat() {
  floatEl.hidden = true;
  floatRange = null;
}
function hidePop() { popEl.hidden = true; popPatchId = ''; }
function hideMenu() { menuEl.hidden = true; }
function hideNote() {
  noteEl.hidden = true;
  noteRange = null;
  noteHost = '';
  noteInput.value = '';
}

function render(options = {}) {
  lastSelection = null;
  renderEditor(options.caret);
  renderSidebar();
  updateChrome();
  if (options.caret) editor.focus();
}

function placeFlyout(el, x, y) {
  el.hidden = false;
  const rect = el.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function showFloatForSelection() {
  if (view !== 'markup' || composing) {
    hideFloat();
    return;
  }
  const range = readRange();
  if (!range || range.collapsed) {
    hideFloat();
    return;
  }
  floatRange = range;
  const selection = window.getSelection();
  if (!selection.rangeCount) return;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) {
    hideFloat();
    return;
  }
  placeFlyout(floatEl, rect.left, rect.bottom + 6);
}

function openNote(range, hostPatchId, x, y) {
  hideFloat();
  hidePop();
  hideMenu();
  noteRange = range;
  noteHost = hostPatchId || '';
  noteInput.value = '';
  placeFlyout(noteEl, x, y);
  noteInput.focus();
}

function applyPayload(payload) {
  const draft = payload?.draft && typeof payload.draft === 'object' ? payload.draft : null;
  if (draft) {
    doc = Model.restoreDocument(draft);
    draftId = String(draft.id || '');
  } else {
    doc = Model.createDocument(String(payload?.text || ''));
    draftId = '';
  }
  meta = {
    agentLabel: String(payload?.agentLabel || ''),
    sessionKey: String(payload?.sessionKey || ''),
  };
  view = 'markup';
  busy = false;
  hideFloat();
  hidePop();
  hideNote();
  hideMenu();
  setStatus(draft
    ? '已载入暂存的修改，可以继续编辑或发送。'
    : '输入即新增。选中后删除、再输入就是替换，拖动选区可以调整语序。');
  render({ caret: draft ? null : { pieceIndex: 0, offset: 0 } });
}

function draftSnapshot() {
  return {
    id: draftId,
    sessionKey: meta.sessionKey,
    agentLabel: meta.agentLabel,
    originalText: doc.originalText,
    baseText: doc.baseText,
    patches: doc.patches,
    preview: Model.finalText(doc),
  };
}

function isDirty() {
  return doc.baseText !== doc.originalText || Model.pendingCount(doc) > 0;
}

function locatePatch(id) {
  if (view !== 'markup') {
    view = 'markup';
    render();
  }
  const escaped = CSS.escape(id);
  const target = editor.querySelector(`[data-patch-id="${escaped}"], [data-comment-id~="${escaped}"]`);
  if (!target) {
    setStatus('这条已经写进正文，修订视图里不再单独标出。');
    return;
  }
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  target.classList.add('ce-flash');
  window.setTimeout(() => target.classList.remove('ce-flash'), 1100);
}

document.querySelectorAll('.ce-view').forEach((button) => {
  button.addEventListener('click', () => {
    view = button.dataset.view;
    hideFloat();
    hidePop();
    hideMenu();
    if (view === 'final') setStatus('终稿预览：未处理的修订会按接受后的结果来看。');
    else if (view === 'original') setStatus('原稿预览：打开窗口时的文字，不含后来的修订。');
    else setStatus('');
    render();
  });
});

async function runBusy(statusText, task) {
  if (busy) return;
  busy = true;
  hideFloat();
  hidePop();
  hideMenu();
  hideNote();
  setStatus(statusText);
  updateChrome();
  try {
    const result = await task();
    if (!result?.ok) setStatus(result?.error || '操作失败', true);
  } catch (err) {
    setStatus(err?.message || '操作失败', true);
  } finally {
    busy = false;
    updateChrome();
  }
}

stashBtn.addEventListener('click', () => {
  if (!isDirty()) {
    if (draftId) {
      void runBusy('这份草稿已经没有修改，正在清掉…', () => window.qiziCopyEdit.discard({ draftId }));
      return;
    }
    setStatus('还没有修改，不用暂存。', true);
    return;
  }
  void runBusy('正在暂存…', () => window.qiziCopyEdit.stash(draftSnapshot()));
});

discardBtn.addEventListener('click', () => {
  if (isDirty() && !window.confirm('放弃后，这次的所有修改和批注都会清掉，也不会留下暂存。')) return;
  void runBusy('正在放弃…', () => window.qiziCopyEdit.discard({ draftId }));
});

sendBtn.addEventListener('click', () => {
  if (!Model.pendingCount(doc)) {
    setStatus('还没有待处理的修订或批注。', true);
    return;
  }
  const prompt = Model.exportToAgentPrompt(doc.baseText, doc.patches);
  void runBusy('正在发给当前对话…', () => window.qiziCopyEdit.sendToAgent({
    text: prompt,
    sessionKey: meta.sessionKey,
    draftId,
  }));
});

sideList.addEventListener('click', (event) => {
  const card = event.target.closest('[data-side-id]');
  if (!card) return;
  locatePatch(card.dataset.sideId);
});

editor.addEventListener('beforeinput', (event) => {
  if (view !== 'markup') {
    event.preventDefault();
    return;
  }
  if (composing || event.isComposing || event.inputType === 'insertCompositionText') return;
  if (Date.now() - composeDoneAt < 50) {
    event.preventDefault();
    return;
  }
  const type = event.inputType || '';
  if (type === 'insertFromPaste' || type === 'deleteByCut') {
    event.preventDefault();
    if (inputJustHandled()) return;
    const pendingRange = readRange();
    if (!pendingRange) return;
    if (type === 'deleteByCut') {
      if (pendingRange.collapsed) return;
      markInputHandled();
      const cutCaret = Model.deleteSelection(doc, pendingRange.start, pendingRange.end);
      setStatus('');
      render({ caret: cutCaret });
      return;
    }
    const pasted = event.dataTransfer?.getData('text/plain') || event.data || '';
    if (!pasted) return;
    markInputHandled();
    hideNote();
    const pasteCaret = pendingRange.collapsed
      ? Model.insertText(doc, pendingRange.start, pasted)
      : Model.replaceSelection(doc, pendingRange.start, pendingRange.end, pasted);
    setStatus('');
    render({ caret: pasteCaret });
    return;
  }
  if (!type.startsWith('insert') && !type.startsWith('delete')) return;
  event.preventDefault();
  const range = readRange();
  if (!range) return;
  hideNote();
  let caret = null;
  if (type === 'insertText') {
    const text = event.data || '';
    caret = range.collapsed
      ? Model.insertText(doc, range.start, text)
      : Model.replaceSelection(doc, range.start, range.end, text);
  } else if (type === 'insertParagraph' || type === 'insertLineBreak') {
    caret = range.collapsed
      ? Model.insertText(doc, range.start, '\n')
      : Model.replaceSelection(doc, range.start, range.end, '\n');
  } else if (type === 'deleteContentBackward') {
    caret = range.collapsed
      ? Model.deleteBackward(doc, range.start)
      : Model.deleteSelection(doc, range.start, range.end);
  } else if (type === 'deleteContentForward' || type === 'deleteContent') {
    caret = range.collapsed
      ? Model.deleteForward(doc, range.start)
      : Model.deleteSelection(doc, range.start, range.end);
  } else {
    return;
  }
  setStatus('');
  render({ caret });
});

editor.addEventListener('paste', (event) => {
  if (view !== 'markup') return;
  event.preventDefault();
  if (inputJustHandled()) return;
  const text = event.clipboardData?.getData('text/plain') || '';
  const range = readRange();
  if (!range || !text) return;
  markInputHandled();
  hideNote();
  const caret = range.collapsed
    ? Model.insertText(doc, range.start, text)
    : Model.replaceSelection(doc, range.start, range.end, text);
  setStatus('');
  render({ caret });
});

editor.addEventListener('cut', (event) => {
  if (view !== 'markup') return;
  const range = readRange();
  if (!range || range.collapsed) return;
  event.preventDefault();
  event.clipboardData.setData('text/plain', Model.selectedFragment(doc, range.start, range.end));
  if (inputJustHandled()) return;
  markInputHandled();
  const caret = Model.deleteSelection(doc, range.start, range.end);
  setStatus('');
  render({ caret });
});

editor.addEventListener('compositionstart', () => {
  if (view !== 'markup') return;
  composing = true;
  composeRange = readRange();
  hideFloat();
});

editor.addEventListener('compositionend', (event) => {
  if (!composing) return;
  composing = false;
  composeDoneAt = Date.now();
  const text = event.data || '';
  const range = composeRange || readRange();
  composeRange = null;
  if (!range || !text) {
    render();
    return;
  }
  const caret = range.collapsed
    ? Model.insertText(doc, range.start, text)
    : Model.replaceSelection(doc, range.start, range.end, text);
  setStatus('');
  render({ caret });
});

editor.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    sendBtn.click();
  }
});

editor.addEventListener('mouseup', () => {
  window.requestAnimationFrame(showFloatForSelection);
});

editor.addEventListener('keyup', (event) => {
  if (event.key === 'Shift' || event.key.startsWith('Arrow')) showFloatForSelection();
});

let lastSelection = null;
let restoringSelection = false;

function selectionSnapshot() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const domRange = selection.getRangeAt(0);
  if (domRange.commonAncestorContainer !== editor && !editor.contains(domRange.commonAncestorContainer)) return null;
  const modelRange = readRange();
  if (!modelRange || modelRange.collapsed) return null;
  return {
    modelRange,
    domRange: domRange.cloneRange(),
    rects: [...domRange.getClientRects()].map((rect) => ({
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    })),
  };
}

function pointInRects(rects, x, y) {
  const pad = 4;
  return rects.some((rect) => (
    x >= rect.left - pad
    && x <= rect.right + pad
    && y >= rect.top - pad
    && y <= rect.bottom + pad
  ));
}

function rememberSelection() {
  if (pointerDrag || restoringSelection) return;
  const snapshot = selectionSnapshot();
  if (snapshot) lastSelection = snapshot;
}

function restoreDragSelection() {
  if (!pointerDrag?.saved || restoringSelection) return;
  const selection = window.getSelection();
  if (!selection) return;
  const current = selection.rangeCount ? selection.getRangeAt(0) : null;
  const saved = pointerDrag.saved;
  if (current
    && current.compareBoundaryPoints(Range.START_TO_START, saved) === 0
    && current.compareBoundaryPoints(Range.END_TO_END, saved) === 0) return;
  restoringSelection = true;
  selection.removeAllRanges();
  selection.addRange(saved);
  restoringSelection = false;
}

function hideDropCaret() {
  dropCaretEl.hidden = true;
}

function showDropCaret(x, y) {
  const editorRect = editor.getBoundingClientRect();
  const inside = x >= editorRect.left && x <= editorRect.right
    && y >= editorRect.top && y <= editorRect.bottom;
  if (!inside) {
    hideDropCaret();
    return;
  }
  const probe = document.caretRangeFromPoint(x, y);
  const node = probe?.startContainer;
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  const rect = probe && el && editor.contains(el) ? probe.getBoundingClientRect() : null;
  const height = rect && rect.height > 2 ? rect.height : 24;
  const left = rect && rect.height > 2 ? rect.left : x;
  const top = rect && rect.height > 2 ? rect.top : y - height / 2;
  dropCaretEl.hidden = false;
  dropCaretEl.style.left = `${left}px`;
  dropCaretEl.style.top = `${top}px`;
  dropCaretEl.style.height = `${height}px`;
}

function finishPointerDrag(event) {
  if (!pointerDrag) return;
  const state = pointerDrag;
  pointerDrag = null;
  hideDropCaret();
  editor.classList.remove('is-dragging');
  if (editor.hasPointerCapture?.(state.pointerId)) editor.releasePointerCapture(state.pointerId);
  if (!state.dragging) {
    const probe = document.caretRangeFromPoint(event.clientX, event.clientY);
    const selection = window.getSelection();
    if (probe && selection) {
      selection.removeAllRanges();
      selection.addRange(probe);
    }
    lastSelection = null;
    hideFloat();
    return;
  }
  const probe = document.caretRangeFromPoint(event.clientX, event.clientY);
  const target = probe ? posFromNode(probe.startContainer, probe.startOffset) : null;
  if (!target) {
    setStatus('放不到这个位置。', true);
    return;
  }
  const result = Model.moveSelection(doc, state.range.start, state.range.end, target);
  if (!result.ok) {
    setStatus(result.error || '不能移动这段', true);
    render();
    return;
  }
  setStatus('已标成移动。原位置留下灰色锚点。');
  render({ caret: result.caret });
}

editor.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || view !== 'markup') return;
  const live = selectionSnapshot();
  if (live) lastSelection = live;
  let snapshot = null;
  if (live && pointInRects(live.rects, event.clientX, event.clientY)) snapshot = live;
  else if (!live && lastSelection && pointInRects(lastSelection.rects, event.clientX, event.clientY)) {
    snapshot = lastSelection;
  }
  if (!snapshot) return;
  event.preventDefault();
  pointerDrag = {
    x: event.clientX,
    y: event.clientY,
    range: snapshot.modelRange,
    saved: snapshot.domRange,
    dragging: false,
    pointerId: event.pointerId,
  };
  try { editor.setPointerCapture(event.pointerId); } catch (err) { /* pointer already gone */ }
  restoreDragSelection();
});

editor.addEventListener('mousedown', (event) => {
  hideMenu();
  if (pointerDrag) event.preventDefault();
});

editor.addEventListener('selectstart', (event) => {
  if (pointerDrag) event.preventDefault();
});

editor.addEventListener('dragstart', (event) => {
  event.preventDefault();
});

editor.addEventListener('pointermove', (event) => {
  if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
  const dx = event.clientX - pointerDrag.x;
  const dy = event.clientY - pointerDrag.y;
  if (!pointerDrag.dragging) {
    if (dx * dx + dy * dy < 9) return;
    pointerDrag.dragging = true;
    editor.classList.add('is-dragging');
    hideFloat();
  }
  event.preventDefault();
  restoreDragSelection();
  showDropCaret(event.clientX, event.clientY);
});

editor.addEventListener('pointerup', (event) => {
  if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
  finishPointerDrag(event);
});

editor.addEventListener('pointercancel', (event) => {
  if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
  pointerDrag.dragging = false;
  finishPointerDrag(event);
});

document.addEventListener('selectionchange', () => {
  if (pointerDrag) {
    restoreDragSelection();
    return;
  }
  rememberSelection();
});

editor.addEventListener('scroll', () => {
  if (!lastSelection?.domRange || pointerDrag) return;
  const range = lastSelection.domRange;
  if (range.commonAncestorContainer !== editor && !editor.contains(range.commonAncestorContainer)) {
    lastSelection = null;
    return;
  }
  lastSelection.rects = [...range.getClientRects()].map((rect) => ({
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
  }));
});

editor.addEventListener('click', (event) => {
  const range = readRange();
  if (!range || !range.collapsed || view !== 'markup') {
    hidePop();
    return;
  }
  const span = event.target.closest?.('[data-patch-id]');
  const kind = span?.dataset.kind;
  if (!span || kind === 'base' || !span.dataset.patchId) {
    hidePop();
    return;
  }
  popPatchId = span.dataset.patchId;
  const rect = span.getBoundingClientRect();
  placeFlyout(popEl, rect.left, rect.bottom + 6);
});

editor.addEventListener('contextmenu', (event) => {
  if (view !== 'markup') return;
  const range = readRange();
  if (!range || range.collapsed) return;
  event.preventDefault();
  hidePop();
  hideFloat();
  menuRange = range;
  placeFlyout(menuEl, event.clientX, event.clientY);
});

editor.addEventListener('dragover', (event) => {
  event.preventDefault();
});

editor.addEventListener('drop', (event) => {
  event.preventDefault();
});

floatEl.addEventListener('mousedown', (event) => event.preventDefault());
floatEl.querySelector('#ce-float-comment').addEventListener('click', () => {
  const range = floatRange || readRange();
  if (!range || range.collapsed) return;
  const rect = floatEl.getBoundingClientRect();
  openNote(range, '', rect.left, rect.bottom + 6);
});

popEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-decide]');
  if (!button || !popPatchId) return;
  const id = popPatchId;
  const rect = popEl.getBoundingClientRect();
  if (button.dataset.decide === 'accept') {
    Model.acceptPatch(doc, id);
    hidePop();
    setStatus('已接受。');
    render();
    return;
  }
  if (button.dataset.decide === 'reject') {
    Model.rejectPatch(doc, id);
    hidePop();
    setStatus('已拒绝。');
    render();
    return;
  }
  hidePop();
  openNote({ start: { pieceIndex: 0, offset: 0 }, end: { pieceIndex: 0, offset: 0 } }, id, rect.left, rect.bottom + 6);
});

menuEl.addEventListener('mousedown', (event) => event.preventDefault());
menuEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-menu]');
  if (!button) return;
  const range = menuRange || readRange();
  const rect = menuEl.getBoundingClientRect();
  hideMenu();
  menuRange = null;
  if (!range || (range.collapsed && !range.start)) return;
  if (range.collapsed) return;
  openNote(range, '', rect.left, rect.bottom + 6);
});

noteEl.addEventListener('submit', (event) => {
  event.preventDefault();
  const content = noteInput.value;
  const range = noteRange || { start: { pieceIndex: 0, offset: 0 }, end: { pieceIndex: 0, offset: 0 } };
  const result = Model.addComment(doc, range.start, range.end, content, noteHost);
  if (!result.ok) {
    setStatus(result.error || '没能加上批注', true);
    return;
  }
  hideNote();
  setStatus('已加上批注。发送时会把这段交给 AI 重写。');
  render();
  if (result.patchId) locatePatch(result.patchId);
});

document.getElementById('ce-note-cancel').addEventListener('click', () => {
  hideNote();
  editor.focus();
});

document.addEventListener('mousedown', (event) => {
  if (!event.target.closest('#ce-float')) hideFloat();
  if (!event.target.closest('#ce-pop')) hidePop();
  if (!event.target.closest('#ce-menu')) hideMenu();
  if (!event.target.closest('#ce-note') && !event.target.closest('#ce-float') && !event.target.closest('#ce-pop') && !event.target.closest('#ce-menu')) {
    if (!noteEl.hidden && event.target !== noteInput) hideNote();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  hideFloat();
  hidePop();
  hideMenu();
  hideNote();
});

async function boot() {
  const payload = await window.qiziCopyEdit.getPayload();
  applyPayload(payload || {});
  window.qiziCopyEdit.onPayload((next) => {
    const nextDraftId = String(next?.draft?.id || '');
    if (nextDraftId && nextDraftId === draftId) return;
    if (isDirty()) {
      const ok = window.confirm('当前文案还有没处理完的修订。换成另一份会丢掉这些修订；想留着请先点「暂存修改」。');
      if (!ok) return;
    }
    applyPayload(next || {});
  });
}

void boot();
