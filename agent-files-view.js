const shell = document.getElementById('af-shell');
const sideScroll = document.getElementById('af-side-scroll');
const statusEl = document.getElementById('af-status');
const agentEl = document.getElementById('af-agent');
const sideToggle = document.getElementById('af-side-toggle');
const previewTitle = document.getElementById('af-preview-title');
const previewBody = document.getElementById('af-preview-body');
const editBtn = document.getElementById('af-edit-btn');
const editIcon = document.getElementById('af-edit-icon');
const editLabel = document.getElementById('af-edit-label');
const editorPane = document.getElementById('af-editor');
const editorHost = document.getElementById('af-editor-host');
const helpBtn = document.getElementById('af-help-btn');
const helpCard = document.getElementById('af-help');
const saveBtn = document.getElementById('af-save-btn');
const toastEl = document.getElementById('af-toast');

const PURIFY = {
  ALLOWED_TAGS: [
    'a', 'b', 'blockquote', 'br', 'code', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'i', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
  ],
  ALLOWED_ATTR: ['href', 'title'],
  ALLOW_DATA_ATTR: false,
};

let agentId = '';
let agentLabel = '';
let catalog = null;
let activeKey = '';
let loaded = null;
let draft = '';
let dirty = false;
let editor = null;
let editorOpen = false;
let paneWidth = 0;
let paneToken = 0;
let sidebarOpen = true;
const expandedFolders = new Set();
let toastTimer = 0;

function fileKey(file) {
  if (!file) return '';
  if (file.kind === 'memory') return `memory:${file.name}`;
  const support = file.supportPath ? `:${file.supportPath}` : '';
  return `skill:${file.source}:${file.skillKey}${support}`;
}

function isCodeSupport(file) {
  const rel = String(file?.supportPath || '');
  return Boolean(rel) && !/\.(md|markdown)$/i.test(rel);
}

function readOnlyNote(file) {
  if (!file || file.writable) return '';
  if (file.scope === 'global') return '这台电脑上看不到这份全局技能文件，没法修改。';
  return '这台电脑上看不到这份技能文件，没法修改。';
}

function markedParse(text) {
  const root = window.marked;
  const parse = root && (typeof root.parse === 'function'
    ? root.parse.bind(root)
    : (typeof root.marked === 'function' ? root.marked.bind(root) : null));
  if (!parse) return '';
  try {
    const html = parse(String(text || ''), { async: false, gfm: true, breaks: true });
    if (typeof DOMPurify !== 'undefined' && typeof DOMPurify.sanitize === 'function') {
      return DOMPurify.sanitize(html, PURIFY);
    }
    return '';
  } catch {
    return '';
  }
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2800);
}

function setDirty(next) {
  dirty = Boolean(next);
  window.qiziAgentFiles?.setDirty?.(dirty);
  saveBtn.disabled = !loaded;
  saveBtn.classList.toggle('is-dirty', Boolean(loaded) && dirty);
}

function setSidebar(open) {
  sidebarOpen = open;
  shell.classList.toggle('is-side-closed', !open);
  sideToggle.title = open ? '收起侧栏' : '展开侧栏';
  sideToggle.setAttribute('aria-label', sideToggle.title);
  sideToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function syncEditButton() {
  const showCancel = Boolean(loaded) && (editorOpen || paneWidth > 0);
  editIcon.src = showCancel ? 'assets/icons/agent-files-cancel.png' : 'assets/icons/agent-files-edit.png';
  editLabel.textContent = showCancel ? '放弃编辑' : '编辑';
  editBtn.title = editLabel.textContent;
}

function layoutPanes() {
  if (!paneWidth) {
    shell.classList.remove('is-editor-open');
    shell.style.removeProperty('--pane');
    shell.style.setProperty('--editor', '0px');
    editorPane.hidden = true;
    return;
  }
  shell.classList.add('is-editor-open');
  editorPane.hidden = false;
  shell.style.setProperty('--pane', `${paneWidth}px`);
  shell.style.setProperty('--editor', `${Math.max(0, window.innerWidth - paneWidth)}px`);
}

function editorColumnWidth() {
  if (!paneWidth) return 0;
  return Math.max(0, window.innerWidth - paneWidth);
}

function revealEditor() {
  if (!paneWidth) return;
  if (editorColumnWidth() < 320) paneWidth = Math.max(280, window.innerWidth - 320);
  layoutPanes();
}

function setEditorOpen(open) {
  if (open === editorOpen && (!open || editorColumnWidth() >= 320)) return Promise.resolve();
  const token = ++paneToken;
  editorOpen = open;
  syncEditButton();
  if (open) {
    if (!paneWidth) paneWidth = window.innerWidth;
    layoutPanes();
    return window.qiziAgentFiles.setEditorPane(true).then(() => {
      if (token !== paneToken) return;
      revealEditor();
      editor?.relayout?.();
      syncEditorFromPreview();
      editor?.focus();
    });
  }
  return window.qiziAgentFiles.setEditorPane(false).finally(() => {
    if (token !== paneToken) return;
    paneWidth = 0;
    layoutPanes();
    syncEditButton();
    editor?.relayout?.();
  });
}

function abandonEdit() {
  if (dirty && !window.confirm('这些修改还没保存。要放弃吗？')) return;
  draft = loaded?.content || '';
  if (editor) editor.setDoc(draft);
  setDirty(false);
  if (loaded) renderPreview(draft, readOnlyNote(loaded));
  setEditorOpen(false);
}

function confirmDiscard() {
  if (!dirty) return true;
  return window.confirm('当前修改还没保存，要离开这个文件吗？');
}

function blockStartLines(text) {
  const lexer = window.marked && window.marked.lexer;
  if (typeof lexer !== 'function') return null;
  let tokens;
  try {
    tokens = lexer(String(text || ''));
  } catch {
    return null;
  }
  let line = 1;
  const starts = [];
  tokens.forEach((token) => {
    if (token.type !== 'space') starts.push(line);
    const breaks = String(token.raw || '').match(/\n/g);
    line += breaks ? breaks.length : 0;
  });
  return starts;
}

function stampPreviewLines(text) {
  const md = previewBody.querySelector('.md');
  if (!md) return false;
  const starts = blockStartLines(text);
  const children = [...md.children];
  if (!starts || !children.length || children.length !== starts.length) return false;
  children.forEach((el, index) => {
    el.dataset.line = String(starts[index]);
  });
  return true;
}

function renderPreview(text, note) {
  if (isCodeSupport(loaded)) {
    previewBody.replaceChildren();
    if (note) {
      const noteEl = document.createElement('p');
      noteEl.className = 'af-readonly-note';
      noteEl.textContent = note;
      previewBody.appendChild(noteEl);
    }
    const pre = document.createElement('pre');
    pre.className = 'af-code-preview';
    pre.textContent = text || '';
    previewBody.appendChild(pre);
    previewLineSync = false;
    if (editorOpen) syncPreviewFromEditor();
    return;
  }
  const html = markedParse(text);
  const noteHtml = note ? `<p class="af-readonly-note">${note}</p>` : '';
  previewBody.innerHTML = `${noteHtml}<div class="md">${html || '<p class="af-empty">这个文件是空的</p>'}</div>`;
  previewLineSync = stampPreviewLines(text);
  if (editorOpen) syncPreviewFromEditor();
}

let previewLineSync = false;
let scrollLock = '';
let scrollUnlock = 0;

function lockScroll(source) {
  scrollLock = source;
  clearTimeout(scrollUnlock);
  scrollUnlock = setTimeout(() => {
    if (scrollLock === source) scrollLock = '';
  }, 80);
}

function previewPad() {
  return parseFloat(getComputedStyle(previewBody).paddingTop) || 0;
}

function elementTop(el) {
  return el.getBoundingClientRect().top - previewBody.getBoundingClientRect().top + previewBody.scrollTop;
}

function scrollPreviewToLine(line) {
  const blocks = [...previewBody.querySelectorAll('.md [data-line]')];
  if (!blocks.length) return;
  let index = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    if (Number(blocks[i].dataset.line) <= line) index = i;
    else break;
  }
  const el = blocks[index];
  const start = Number(el.dataset.line) || 1;
  const next = blocks[index + 1];
  const end = next ? Number(next.dataset.line) : start + 1;
  const span = Math.max(1, end - start);
  const into = Math.min(1, Math.max(0, (line - start) / span));
  const nextTop = elementTop(el) - previewPad() + into * el.offsetHeight;
  if (Math.abs(previewBody.scrollTop - nextTop) < 2) return;
  previewBody.scrollTop = nextTop;
}

function previewAnchor() {
  const blocks = [...previewBody.querySelectorAll('.md [data-line]')];
  if (!blocks.length) return 1;
  const top = previewBody.scrollTop + previewPad();
  let index = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    if (elementTop(blocks[i]) <= top + 2) index = i;
    else break;
  }
  const el = blocks[index];
  const start = Number(el.dataset.line) || 1;
  const next = blocks[index + 1];
  const lastLine = Math.max(start + 1, String(draft || '').split('\n').length + 1);
  const end = next ? Number(next.dataset.line) : lastLine;
  const height = Math.max(1, el.offsetHeight);
  const into = Math.min(1, Math.max(0, (top - elementTop(el)) / height));
  return Math.round(start + into * Math.max(0, end - start - 1));
}

function scrollRatio(el) {
  const max = el.scrollHeight - el.clientHeight;
  return max <= 0 ? 0 : el.scrollTop / max;
}

function syncPreviewFromEditor() {
  if (!editorOpen || !editor || scrollLock === 'preview') return;
  lockScroll('editor');
  if (previewLineSync && editor.topLine) scrollPreviewToLine(editor.topLine());
  else if (editor.scrollRatio) {
    const max = previewBody.scrollHeight - previewBody.clientHeight;
    previewBody.scrollTop = editor.scrollRatio() * Math.max(0, max);
  }
}

function syncEditorFromPreview() {
  if (!editorOpen || !editor || scrollLock === 'editor') return;
  lockScroll('preview');
  if (previewLineSync && editor.scrollToLine) editor.scrollToLine(previewAnchor());
  else if (editor.setScrollRatio) editor.setScrollRatio(scrollRatio(previewBody));
}

function renderEmpty(message) {
  previewTitle.textContent = '未选择文件';
  previewBody.replaceChildren();
  const empty = document.createElement('p');
  empty.className = 'af-empty';
  empty.textContent = message || '请从左侧选择一份头脑记忆或技能进行查看';
  previewBody.appendChild(empty);
  editBtn.hidden = true;
}

function applyLoaded(file, data) {
  loaded = {
    ...file,
    content: data.content || '',
    hash: data.hash || null,
    workspace: data.workspace || null,
    writable: data.writable === true,
    missing: data.missing === true,
    displayPath: data.displayPath || file.displayPath || file.label || file.name,
  };
  draft = loaded.content;
  activeKey = fileKey(file);
  previewTitle.textContent = loaded.kind === 'memory' ? loaded.name : (loaded.displayPath || loaded.name);
  editBtn.hidden = false;
  const note = readOnlyNote(loaded);
  renderPreview(draft, note);
  editor?.setDoc(draft);
  editor?.relayout?.();
  setDirty(false);
  renderSidebar();
}

async function selectFile(file) {
  if (fileKey(file) === activeKey) {
    if (!editorOpen) setEditorOpen(false);
    return;
  }
  if (!confirmDiscard()) return;
  previewTitle.textContent = file.label || file.name || '读取中…';
  previewBody.innerHTML = '<p class="af-empty">正在读取…</p>';
  editBtn.hidden = true;
  const result = await window.qiziAgentFiles.read(file);
  if (!result?.ok) {
    loaded = null;
    activeKey = '';
    setDirty(false);
    renderEmpty(result?.error || '读取失败');
    renderSidebar();
    return;
  }
  applyLoaded(file, result);
}

function folderKey(scope, names) {
  return `${agentId}:${scope}:${names.join('/')}`;
}

function nodePath(parents, node) {
  if (node.skill?.supportPath) return [...parents, node.skill.supportPath];
  if (node.skill?.skillKey && !node.skill.supportPath) return [...parents, node.skill.skillKey];
  return [...parents, node.name];
}

function renderGuides(li, guides) {
  if (!guides.length) return;
  const wrap = document.createElement('span');
  wrap.className = 'af-guides';
  wrap.setAttribute('aria-hidden', 'true');
  guides.forEach((kind) => {
    const cell = document.createElement('i');
    cell.className = `af-guide is-${kind}`;
    wrap.appendChild(cell);
  });
  li.appendChild(wrap);
}

function renderNodes(nodes, scope, parents, ancestorGuides) {
  const ul = document.createElement('ul');
  ul.className = parents.length ? 'af-tree' : 'af-tree af-tree-root';
  nodes.forEach((node, index) => {
    const li = document.createElement('li');
    li.className = 'af-node';
    const nested = parents.length > 0;
    const last = index === nodes.length - 1;
    const guides = nested ? [...ancestorGuides, last ? 'last' : 'elbow'] : [];
    renderGuides(li, guides);

    const pathNames = nodePath(parents, node);
    const hasChildren = node.type === 'folder' && node.children?.length > 0;
    const key = folderKey(scope, pathNames);
    const open = hasChildren && expandedFolders.has(key);
    const isSkillRoot = Boolean(node.skill && !node.skill.supportPath);

    const row = document.createElement('div');
    row.className = 'af-row';
    if (guides.length) row.style.paddingLeft = `${guides.length * 16}px`;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = isSkillRoot ? 'af-file af-dot' : 'af-file';
    if (node.skill && !node.skill.readable) button.classList.add('is-missing');
    if (node.skill && fileKey(node.skill) === activeKey) button.classList.add('is-active');
    button.textContent = node.name;
    if (hasChildren) button.title = open ? '收起' : '展开';
    button.addEventListener('click', () => {
      if (hasChildren && isSkillRoot) {
        const showing = fileKey(node.skill) === activeKey;
        if (!open) expandedFolders.add(key);
        else if (showing) expandedFolders.delete(key);
        if (showing) renderSidebar();
        else void selectFile(node.skill);
        return;
      }
      if (hasChildren) {
        if (open) expandedFolders.delete(key);
        else expandedFolders.add(key);
        renderSidebar();
        return;
      }
      if (node.skill) void selectFile(node.skill);
    });
    row.appendChild(button);
    li.appendChild(row);
    if (open) {
      const childGuides = nested ? [...ancestorGuides, last ? 'blank' : 'line'] : [];
      li.appendChild(renderNodes(node.children, scope, pathNames, childGuides));
    }
    ul.appendChild(li);
  });
  return ul;
}

function renderMemory(memories) {
  const group = document.createElement('section');
  group.className = 'af-group';
  const title = document.createElement('div');
  title.className = 'af-section-title';
  title.textContent = '头脑记忆';
  group.appendChild(title);
  memories.forEach((file) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'af-file af-dot';
    if (file.missing) button.classList.add('is-missing');
    if (fileKey(file) === activeKey) button.classList.add('is-active');
    button.textContent = file.missing ? `${file.label}（未创建）` : file.label;
    button.addEventListener('click', () => { void selectFile(file); });
    group.appendChild(button);
  });
  return group;
}

function renderSkillGroup(label, nodes, scope) {
  const group = document.createElement('section');
  group.className = 'af-group';
  const title = document.createElement('div');
  title.className = 'af-group-title';
  title.textContent = label;
  group.appendChild(title);
  if (!nodes?.length) {
    const empty = document.createElement('p');
    empty.className = 'af-status';
    empty.textContent = '没有技能';
    group.appendChild(empty);
    return group;
  }
  group.appendChild(renderNodes(nodes, scope, [], []));
  return group;
}

function renderSidebar() {
  sideScroll.innerHTML = '';
  if (!catalog) {
    const status = document.createElement('p');
    status.className = 'af-status';
    status.id = 'af-status';
    status.textContent = statusEl?.textContent || '正在读取…';
    sideScroll.appendChild(status);
    return;
  }
  sideScroll.appendChild(renderMemory(catalog.memories || []));
  const skillsTitle = document.createElement('div');
  skillsTitle.className = 'af-section-title';
  skillsTitle.textContent = '技能清单';
  sideScroll.appendChild(skillsTitle);
  if (catalog.showGlobalSkills) {
    sideScroll.appendChild(renderSkillGroup('全局技能', catalog.skills?.global, 'global'));
  }
  sideScroll.appendChild(renderSkillGroup('私人技能', catalog.skills?.private, 'private'));
}

async function loadCatalog() {
  try {
    const context = await window.qiziAgentFiles.getContext();
    agentId = context?.agentId || '';
    agentLabel = context?.agentLabel || agentId || '当前 Agent';
    agentEl.textContent = agentLabel;
    document.title = `${agentLabel} · 头脑与技能`;
    sideScroll.innerHTML = '<p class="af-status">正在读取…</p>';
    const result = await window.qiziAgentFiles.list();
    if (!result?.ok) {
      catalog = null;
      sideScroll.replaceChildren();
      const failed = document.createElement('p');
      failed.className = 'af-status';
      failed.textContent = result?.error || '读取失败';
      sideScroll.appendChild(failed);
      return;
    }
    catalog = result;
    renderSidebar();
  } catch (err) {
    catalog = null;
    sideScroll.replaceChildren();
    const failed = document.createElement('p');
    failed.className = 'af-status';
    failed.textContent = err?.message || '读取失败';
    sideScroll.appendChild(failed);
  }
}

async function save() {
  if (!loaded) return false;
  const content = editorOpen && editor ? editor.getDoc() : draft;
  saveBtn.disabled = true;
  const result = await window.qiziAgentFiles.save({
    ...loaded,
    content,
    hash: loaded.hash,
  });
  saveBtn.disabled = false;
  if (!result?.ok) {
    showToast(result?.error || '保存失败');
    if (result?.conflict) {
      dirty = true;
      setDirty(true);
    }
    return false;
  }
  loaded.hash = result.hash || loaded.hash;
  loaded.content = content;
  loaded.missing = false;
  draft = content;
  setDirty(false);
  if (catalog && loaded.kind === 'memory') {
    const memory = (catalog.memories || []).find((file) => file.name === loaded.name);
    if (memory) memory.missing = false;
    renderSidebar();
  }
  showToast(result.backupName ? `已保存。上一版备份为 ${result.backupName}` : '已保存');
  if (editorOpen) await setEditorOpen(false);
  return true;
}

function ensureEditor() {
  if (editor) return true;
  if (!window.QiziMarkdownEditor?.mount) return false;
  try {
    editor = window.QiziMarkdownEditor.mount(editorHost, {
      onChange(text) {
        draft = text;
        setDirty(text !== (loaded?.content || ''));
        if (loaded) renderPreview(text, readOnlyNote(loaded));
      },
      onSave() { void save(); },
      onScroll() { syncPreviewFromEditor(); },
    });
  } catch (err) {
    console.error(err);
    editor = null;
    return false;
  }
  return true;
}

sideToggle.addEventListener('click', () => setSidebar(!sidebarOpen));
editBtn.addEventListener('click', () => {
  if ((editorOpen || paneWidth) && editorColumnWidth() >= 80) {
    abandonEdit();
    return;
  }
  const first = !editor;
  void setEditorOpen(true).then(() => {
    if (!editorOpen) return;
    if (!ensureEditor()) {
      showToast('编辑器没有加载起来');
      void setEditorOpen(false);
      return;
    }
    if (first) editor.setDoc(draft);
    revealEditor();
    editor.relayout?.();
    editor.focus();
  });
});
window.addEventListener('resize', () => {
  if (paneWidth) layoutPanes();
  editor?.relayout?.();
  syncPreviewFromEditor();
});
previewBody.addEventListener('scroll', () => {
  syncEditorFromPreview();
}, { passive: true });
helpBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  helpCard.hidden = !helpCard.hidden;
});
saveBtn.addEventListener('click', () => { void save(); });
document.addEventListener('click', (event) => {
  if (!helpCard.hidden && !event.target.closest('#af-help') && !event.target.closest('#af-help-btn')) {
    helpCard.hidden = true;
  }
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void save();
  }
});
window.qiziAgentFiles.onRequestSave(async () => {
  const ok = await save();
  window.qiziAgentFiles.saveResult(ok);
});

window.qiziAgentFiles.onReload(() => {
  if (!confirmDiscard()) return;
  loaded = null;
  activeKey = '';
  draft = '';
  setDirty(false);
  setEditorOpen(false);
  renderEmpty();
  void loadCatalog();
});

void loadCatalog();
