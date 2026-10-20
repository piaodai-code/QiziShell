(function initMeetingHelp() {
  const doc = document.getElementById('help-doc');
  const button = document.getElementById('help-copy-btn');
  const status = document.getElementById('help-copy-status');
  if (!doc || !button) return;

  let timer = null;

  button.addEventListener('click', () => {
    const text = doc.innerText.replace(/\n{3,}/g, '\n\n').trim();
    void (async () => {
      try {
        const result = await window.qiziMeetingHelp.copyText(text);
        if (!result?.ok) throw new Error(result?.error || 'copy failed');
        if (status) status.textContent = '已复制全文';
      } catch (err) {
        if (status) status.textContent = '复制失败';
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (status) status.textContent = '';
      }, 1600);
    })();
  });
})();
