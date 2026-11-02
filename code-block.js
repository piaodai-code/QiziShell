/**
 * 聊天气泡里的黑底代码框：复制、折行切换。
 * 默认不折行。三横线进入折行，双向箭头回到不折行。
 */
(function initCodeBlocks(global) {
  const COPY_ICON = 'assets/icons/code-copy.png';
  const LINES_ICON = 'assets/icons/code-lines.png';
  const ARROWS_ICON = 'assets/icons/code-arrows.png';
  const wrappedKeys = new Set();

  function blockKey(text) {
    const value = String(text || '');
    return `${value.length}:${value.slice(0, 120)}`;
  }

  function codeText(pre) {
    const code = pre.querySelector('code');
    const raw = code ? code.textContent : pre.textContent;
    return String(raw || '').replace(/\n$/, '');
  }

  function setWrapButton(button, wrapped) {
    const img = button.querySelector('img');
    if (img) img.src = wrapped ? ARROWS_ICON : LINES_ICON;
    const label = wrapped ? '不折行' : '折行';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', wrapped ? 'true' : 'false');
  }

  async function copyText(text) {
    const value = String(text ?? '');
    if (!value) return false;
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      try {
        const area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.left = '-9999px';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        return ok;
      } catch {
        return false;
      }
    }
  }

  function decorate(root) {
    if (!root || !root.querySelectorAll) return;
    const pres = [...root.querySelectorAll('.msg-bubble pre')];
    pres.forEach((pre) => {
      if (pre.classList.contains('msg-stream-plain')) return;
      if (pre.closest('.msg-code-block')) return;
      const text = codeText(pre);
      const block = document.createElement('div');
      block.className = 'msg-code-block';
      const toolbar = document.createElement('div');
      toolbar.className = 'msg-code-toolbar';
      toolbar.innerHTML = `
        <button type="button" class="msg-code-btn msg-code-wrap">
          <img src="${LINES_ICON}" alt="" aria-hidden="true">
        </button>
        <button type="button" class="msg-code-btn msg-code-copy" title="复制" aria-label="复制代码">
          <img src="${COPY_ICON}" alt="" aria-hidden="true">
        </button>
      `;
      pre.parentNode.insertBefore(block, pre);
      block.appendChild(toolbar);
      block.appendChild(pre);
      const wrapped = wrappedKeys.has(blockKey(text));
      block.classList.toggle('is-wrapped', wrapped);
      setWrapButton(toolbar.querySelector('.msg-code-wrap'), wrapped);
    });
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('.msg-code-btn');
    if (!button) return;
    const block = button.closest('.msg-code-block');
    const pre = block?.querySelector('pre');
    if (!block || !pre) return;
    event.preventDefault();
    event.stopPropagation();
    if (button.classList.contains('msg-code-copy')) {
      const text = codeText(pre);
      void copyText(text).then((ok) => {
        button.classList.toggle('is-copied', ok);
        button.title = ok ? '已复制' : '复制失败';
        window.setTimeout(() => {
          button.classList.remove('is-copied');
          button.title = '复制';
        }, 1200);
      });
      return;
    }
    if (!button.classList.contains('msg-code-wrap')) return;
    const wrapped = !block.classList.contains('is-wrapped');
    block.classList.toggle('is-wrapped', wrapped);
    const key = blockKey(codeText(pre));
    if (wrapped) wrappedKeys.add(key);
    else wrappedKeys.delete(key);
    setWrapButton(button, wrapped);
  }, true);

  global.QiziCodeBlocks = { decorate };
})(window);
