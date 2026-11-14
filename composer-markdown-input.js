(function composerMarkdownInput(global) {
  function bindComposerMarkdownInput(textarea) {
    if (!textarea || textarea.qiziMarkdown) return textarea?.qiziMarkdown || null;
    if (!global.QiziMarkdownEditor?.mount) return null;
    const parent = textarea.parentElement;
    if (!parent) return null;

    const nativeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    const nativeStart = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'selectionStart');
    const nativeEnd = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'selectionEnd');
    const nativeDisabled = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'disabled');
    const nativePlaceholder = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'placeholder');
    const nativeFocus = textarea.focus.bind(textarea);
    const nativeSelect = textarea.select.bind(textarea);
    const nativeSetRange = textarea.setSelectionRange.bind(textarea);
    if (!nativeValue || !nativeStart || !nativeEnd || !nativeDisabled || !nativePlaceholder) return null;

    const host = textarea.ownerDocument.createElement('div');
    host.className = 'composer-md';
    parent.insertBefore(host, textarea);
    textarea.classList.add('composer-md-source');
    textarea.setAttribute('aria-hidden', 'true');
    textarea.tabIndex = -1;

    let editor = null;

    function syncHostBox() {
      host.style.height = textarea.style.height;
      host.style.maxHeight = textarea.style.maxHeight;
      host.classList.toggle('is-stt-pending', textarea.classList.contains('is-stt-pending'));
      host.classList.toggle('is-disabled', Boolean(textarea.disabled));
      editor?.relayout();
    }

    function keyboardEvent(source) {
      const event = new KeyboardEvent('keydown', {
        bubbles: false,
        cancelable: true,
        key: source.key,
        code: source.code,
        shiftKey: source.shiftKey,
        altKey: source.altKey,
        metaKey: source.metaKey,
        ctrlKey: source.ctrlKey,
        repeat: source.repeat,
        isComposing: source.isComposing,
      });
      try {
        Object.defineProperty(event, 'keyCode', { get: () => source.keyCode });
        Object.defineProperty(event, 'which', { get: () => source.which });
      } catch { /* synthetic key codes are optional */ }
      return event;
    }

    function mountEditor() {
      const doc = editor ? editor.getDoc() : nativeValue.get.call(textarea);
      const selection = editor ? editor.getSelection() : null;
      const focused = Boolean(editor?.hasFocus?.());
      try { editor?.destroy(); } catch { /* the view may already have moved documents */ }
      editor = null;
      host.replaceChildren();
      editor = global.QiziMarkdownEditor.mount(host, {
        live: true,
        variant: 'composer',
        doc,
        placeholder: nativePlaceholder.get.call(textarea),
        editable: !nativeDisabled.get.call(textarea),
        onChange(text) {
          nativeValue.set.call(textarea, text);
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        },
        onKeyDown(event) {
          if (event.isComposing || event.keyCode === 229) return false;
          const forwarded = keyboardEvent(event);
          textarea.dispatchEvent(forwarded);
          if (!forwarded.defaultPrevented) return false;
          event.preventDefault();
          event.stopPropagation();
          return true;
        },
        onPaste(event) {
          const forwarded = new Event('paste', { bubbles: false, cancelable: true });
          Object.defineProperty(forwarded, 'clipboardData', { value: event.clipboardData });
          textarea.dispatchEvent(forwarded);
          if (!forwarded.defaultPrevented) return false;
          event.preventDefault();
          return true;
        },
        onBlur() {
          textarea.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
        },
        onContextMenu(event) {
          event.preventDefault();
          event.stopPropagation();
          textarea.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: false,
            cancelable: true,
            clientX: event.clientX,
            clientY: event.clientY,
          }));
          return true;
        },
        onFiles(files) {
          textarea.dispatchEvent(new CustomEvent('qizi-composer-files', {
            bubbles: true,
            detail: { files },
          }));
        },
      });
      if (selection) editor.setSelection(selection.from, selection.to);
      if (focused) editor.focus();
      syncHostBox();
    }

    const api = {
      remount() { mountEditor(); },
      focus() { editor?.focus(); },
      contentHeight() { return editor ? editor.contentHeight() : textarea.scrollHeight; },
      isCaretOnFirstLine() { return editor ? editor.isCaretOnFirstLine() : true; },
      isCaretOnLastLine() { return editor ? editor.isCaretOnLastLine() : true; },
    };

    try {
      Object.defineProperty(textarea, 'value', {
        configurable: true,
        get() { return editor ? editor.getDoc() : nativeValue.get.call(textarea); },
        set(next) {
          const text = String(next ?? '');
          nativeValue.set.call(textarea, text);
          if (!editor || editor.getDoc() === text) return;
          editor.setDoc(text);
          editor.setSelection(text.length, text.length);
        },
      });
      Object.defineProperty(textarea, 'selectionStart', {
        configurable: true,
        get() { return editor ? editor.getSelection().from : nativeStart.get.call(textarea); },
        set(next) {
          const pos = Number(next) || 0;
          if (!editor) nativeStart.set.call(textarea, pos);
          else editor.setSelection(pos, pos);
        },
      });
      Object.defineProperty(textarea, 'selectionEnd', {
        configurable: true,
        get() { return editor ? editor.getSelection().to : nativeEnd.get.call(textarea); },
        set(next) {
          const pos = Number(next) || 0;
          if (!editor) nativeEnd.set.call(textarea, pos);
          else editor.setSelection(editor.getSelection().from, pos);
        },
      });
      Object.defineProperty(textarea, 'disabled', {
        configurable: true,
        get() { return nativeDisabled.get.call(textarea); },
        set(next) {
          nativeDisabled.set.call(textarea, Boolean(next));
          editor?.setEditable(!next);
          syncHostBox();
        },
      });
      Object.defineProperty(textarea, 'placeholder', {
        configurable: true,
        get() { return nativePlaceholder.get.call(textarea); },
        set(next) {
          nativePlaceholder.set.call(textarea, next == null ? '' : String(next));
          editor?.setPlaceholder(next == null ? '' : String(next));
        },
      });
      textarea.focus = () => { editor ? editor.focus() : nativeFocus(); };
      textarea.select = () => { editor ? editor.selectAll() : nativeSelect(); };
      textarea.setSelectionRange = (start, end) => {
        if (!editor) nativeSetRange(start, end);
        else editor.setSelection(start, end ?? start);
      };
    } catch (err) {
      console.error('[qizi] markdown input unavailable', err);
      host.remove();
      textarea.classList.remove('composer-md-source');
      textarea.removeAttribute('aria-hidden');
      return null;
    }

    textarea.qiziMarkdown = api;
    try {
      mountEditor();
    } catch (err) {
      console.error('[qizi] markdown input failed', err);
      try { editor?.destroy(); } catch { /* ignore */ }
      delete textarea.qiziMarkdown;
      host.remove();
      textarea.classList.remove('composer-md-source');
      textarea.removeAttribute('aria-hidden');
      return null;
    }

    const observer = new MutationObserver(syncHostBox);
    observer.observe(textarea, { attributes: true, attributeFilter: ['style', 'class', 'disabled'] });
    return api;
  }

  global.bindComposerMarkdownInput = bindComposerMarkdownInput;
}(window));
