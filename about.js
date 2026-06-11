const params = new URLSearchParams(window.location.search);
const versionEl = document.getElementById('about-version');
if (versionEl) {
  versionEl.textContent = params.get('version') || '—';
}
