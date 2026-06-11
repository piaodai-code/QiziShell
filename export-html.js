const { marked } = require('marked');
const DOMPurify = require('isomorphic-dompurify');

const EXPORT_WORD_STYLES = `
body { font-family: "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 14px; line-height: 1.7; color: #222; }
.export-entry { margin-bottom: 22px; page-break-inside: avoid; }
.export-entry-header { margin: 0 0 10px 0; font-size: 13px; }
.export-entry-header strong { font-weight: 600; }
.export-entry-time { color: #888; font-size: 12px; }
.export-entry-body { font-size: 14px; line-height: 1.7; }
.export-quote { margin: 0 0 10px 0; padding: 8px 10px; border: 1px solid #ddd; border-radius: 8px; background: #f7f7f7; }
.export-quote-author { font-size: 11px; font-weight: 600; color: #666; margin-bottom: 6px; }
.export-body p { margin: 0 0 8px 0; }
.export-body p:last-child { margin-bottom: 0; }
.export-body strong { font-weight: 600; }
.export-body em { font-style: italic; }
.export-body code { font-family: Menlo, Consolas, monospace; font-size: 12px; background: #f0f0f0; padding: 1px 4px; border-radius: 3px; }
.export-body pre { margin: 8px 0; padding: 10px 12px; background: #f5f5f5; border: 1px solid #ddd; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
.export-body pre code { background: transparent; padding: 0; }
.export-body table { border-collapse: collapse; margin: 8px 0; font-size: 12px; width: 100%; }
.export-body th, .export-body td, .export-quote th, .export-quote td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
.export-body th, .export-quote th { background: #f5f5f5; font-weight: 600; }
.export-body blockquote, .export-quote blockquote { border-left: 3px solid #ccc; margin: 8px 0; padding: 4px 12px; color: #666; }
.export-body ul, .export-body ol, .export-quote ul, .export-quote ol { margin: 4px 0; padding-left: 22px; }
.export-body li, .export-quote li { margin: 2px 0; }
.export-body h1, .export-body h2, .export-body h3, .export-quote h1, .export-quote h2, .export-quote h3 { margin: 12px 0 6px 0; font-weight: 600; }
.export-body h1, .export-quote h1 { font-size: 16px; }
.export-body h2, .export-quote h2 { font-size: 15px; }
.export-body h3, .export-quote h3 { font-size: 14px; }
.export-body a, .export-quote a { color: #1976d2; text-decoration: underline; }
.export-divider { border: none; border-top: 1px solid #ddd; margin: 18px 0; }
`;

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'a', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4',
    'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'span', 'strong', 'table', 'tbody',
    'td', 'th', 'thead', 'tr', 'ul',
  ],
  ALLOWED_ATTR: ['href', 'title', 'alt', 'src', 'class', 'colspan', 'rowspan'],
  ALLOW_DATA_ATTR: false,
};

function escapeExportHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapMarkdownTables(html) {
  return String(html || '').replace(/<table\b[\s\S]*?<\/table>/gi, (tableHtml) => (
    `<div class="msg-table-wrap">${tableHtml}</div>`
  ));
}

function sanitizeRichHtml(html) {
  return DOMPurify.sanitize(String(html || ''), PURIFY_CONFIG);
}

function parseMarkdownSafe(text) {
  const source = String(text || '');
  if (!source.trim()) return '';
  try {
    const parsed = marked.parse(source, { async: false, gfm: true, breaks: true });
    if (typeof parsed === 'string' && parsed.trim()) {
      return sanitizeRichHtml(wrapMarkdownTables(parsed));
    }
  } catch {
    // fall through
  }
  return sanitizeRichHtml(
    escapeExportHtml(source)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\r?\n/g, '<br/>'),
  );
}

function renderQuoteBlock(label, text) {
  const author = escapeExportHtml(label || '未知');
  const bodyHtml = parseMarkdownSafe(text);
  return `<div class="export-quote"><div class="export-quote-author">${author}</div>${bodyHtml}</div>`;
}

function renderExportEntryBody(entry) {
  const parts = [];
  if (entry?.forward?.text) {
    parts.push(renderQuoteBlock(
      `转发 · ${entry.forward.authorLabel || '未知'}`,
      entry.forward.text,
    ));
  } else if (entry?.quote?.text) {
    parts.push(renderQuoteBlock(
      `引用 · ${entry.quote.authorLabel || '未知'}`,
      entry.quote.text,
    ));
  }
  const bodySource = String(entry?.text || '')
    .replace(/\n?[A-Za-z0-9+/=\s]{800,}\n?/g, '\n')
    .trim();
  if (bodySource) {
    parts.push(`<div class="export-body">${parseMarkdownSafe(bodySource)}</div>`);
  }
  return parts.join('');
}

function buildExportWordHtml(entries) {
  const blocks = (Array.isArray(entries) ? entries : []).map((entry) => {
    const author = escapeExportHtml(entry?.author || '未知');
    const time = entry?.time
      ? `<span class="export-entry-time"> ${escapeExportHtml(entry.time)}</span>`
      : '';
    const body = renderExportEntryBody(entry);
    return [
      '<div class="export-entry">',
      `<p class="export-entry-header"><strong>${author}</strong>${time}</p>`,
      `<div class="export-entry-body">${body}</div>`,
      '</div>',
    ].join('');
  });
  return [
    '<!DOCTYPE html>',
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>QiziShell Export</title>',
    `<style>${EXPORT_WORD_STYLES}</style>`,
    '</head>',
    '<body>',
    blocks.join('<hr class="export-divider"/>'),
    '</body></html>',
  ].join('');
}

module.exports = {
  buildExportWordHtml,
  parseMarkdownSafe,
  sanitizeRichHtml,
};
