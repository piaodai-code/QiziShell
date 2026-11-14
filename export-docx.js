const { marked } = require('marked');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = ~0;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (~crc) >>> 0;
}

function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, eocd]);
}

function xmlEscape(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeHref(href) {
  const value = String(href || '').trim();
  if (/^(https?:|mailto:)/i.test(value)) return value;
  return '';
}

function mergeStyle(base, extra) {
  return { ...base, ...extra };
}

function renderInline(tokens, style = {}) {
  const parts = [];
  for (const token of tokens || []) {
    if (!token) continue;
    if (token.type === 'text' || token.type === 'escape') {
      if (token.text) parts.push({ kind: 'text', text: token.text, style });
    } else if (token.type === 'br') {
      parts.push({ kind: 'br', style });
    } else if (token.type === 'strong') {
      parts.push(...renderInline(token.tokens, mergeStyle(style, { bold: true })));
    } else if (token.type === 'em') {
      parts.push(...renderInline(token.tokens, mergeStyle(style, { italics: true })));
    } else if (token.type === 'del') {
      parts.push(...renderInline(token.tokens, mergeStyle(style, { strike: true })));
    } else if (token.type === 'codespan') {
      parts.push({ kind: 'text', text: token.text || '', style: mergeStyle(style, { code: true }) });
    } else if (token.type === 'link') {
      const href = safeHref(token.href);
      const children = renderInline(token.tokens || [{ type: 'text', text: token.text || href }], mergeStyle(style, { underline: true, color: '174EA6' }));
      if (href) parts.push({ kind: 'link', href, children });
      else parts.push(...children);
    } else if (token.type === 'image') {
      const label = token.text || token.href || '';
      if (label) parts.push({ kind: 'text', text: label, style });
    } else if (token.tokens) {
      parts.push(...renderInline(token.tokens, style));
    } else if (token.text) {
      parts.push({ kind: 'text', text: token.text, style });
    }
  }
  return parts;
}

function runXml(part) {
  if (part.kind === 'br') return '<w:r><w:br/></w:r>';
  const style = part.style || {};
  const props = [];
  if (style.bold) props.push('<w:b/>');
  if (style.italics) props.push('<w:i/>');
  if (style.strike) props.push('<w:strike/>');
  if (style.code) {
    props.push('<w:rFonts w:ascii="Menlo" w:hAnsi="Menlo" w:cs="Menlo"/>');
    props.push('<w:shd w:val="clear" w:color="auto" w:fill="F3F3F3"/>');
  }
  if (style.color) props.push(`<w:color w:val="${style.color}"/>`);
  if (style.underline) props.push('<w:u w:val="single"/>');
  if (style.size) props.push(`<w:sz w:val="${style.size}"/><w:szCs w:val="${style.size}"/>`);
  const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
  return `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(part.text)}</w:t></w:r>`;
}

function partsXml(parts, ctx) {
  return (parts || []).map((part) => {
    if (part.kind === 'link') {
      const id = `rId${ctx.rels.length + 2}`;
      ctx.rels.push({ id, href: part.href });
      return `<w:hyperlink r:id="${id}">${partsXml(part.children, ctx)}</w:hyperlink>`;
    }
    return runXml(part);
  }).join('');
}

function paragraphXml(block, ctx) {
  const props = [];
  if (block.styleName) props.push(`<w:pStyle w:val="${block.styleName}"/>`);
  const left = ((block.indent || 0) * 420) + (block.quote ? 180 : 0);
  if (left) props.push(`<w:ind w:left="${left}"/>`);
  if (block.quote) {
    props.push('<w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="D7D4F0"/></w:pBdr>');
  }
  if (block.fill) props.push(`<w:shd w:val="clear" w:color="auto" w:fill="${block.fill}"/>`);
  if (block.rule) {
    props.push('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="DDDDDD"/></w:pBdr>');
  }
  const pPr = props.length ? `<w:pPr>${props.join('')}</w:pPr>` : '';
  const inlines = block.prefix
    ? [{ kind: 'text', text: block.prefix, style: block.prefixStyle || {} }, ...(block.inlines || [])]
    : (block.inlines || []);
  return `<w:p>${pPr}${partsXml(inlines, ctx)}</w:p>`;
}

function paragraph(inlines, opts = {}) {
  return { type: 'p', inlines, ...opts };
}

function renderBlocks(tokens, opts = {}) {
  const blocks = [];
  for (const token of tokens || []) {
    if (!token || token.type === 'space') continue;
    if (token.type === 'paragraph' || token.type === 'text') {
      blocks.push(paragraph(renderInline(token.tokens || [{ type: 'text', text: token.text || '' }]), opts));
    } else if (token.type === 'heading') {
      const depth = Math.min(Math.max(token.depth || 1, 1), 3);
      blocks.push(paragraph(renderInline(token.tokens), { ...opts, styleName: `Heading${depth}` }));
    } else if (token.type === 'blockquote') {
      blocks.push(...renderBlocks(token.tokens, { ...opts, quote: true, indent: (opts.indent || 0) + 1 }));
    } else if (token.type === 'code') {
      const lines = String(token.text || '').replace(/\n$/, '').split('\n');
      const inlines = [];
      lines.forEach((line, index) => {
        if (index) inlines.push({ kind: 'br' });
        inlines.push({ kind: 'text', text: line || ' ', style: { code: true } });
      });
      blocks.push(paragraph(inlines, { ...opts, fill: 'F6F6F6' }));
    } else if (token.type === 'hr') {
      blocks.push(paragraph([], { ...opts, rule: true }));
    } else if (token.type === 'list') {
      token.items.forEach((item, index) => {
        const marker = item.task
          ? `${item.checked ? '☑' : '☐'} `
          : (token.ordered ? `${(Number(token.start) || 1) + index}. ` : '• ');
        const itemBlocks = renderBlocks(item.tokens, { ...opts, indent: (opts.indent || 0) + 1 });
        if (!itemBlocks.length) itemBlocks.push(paragraph([], opts));
        itemBlocks[0] = { ...itemBlocks[0], prefix: marker };
        blocks.push(...itemBlocks);
      });
    } else if (token.type === 'table') {
      blocks.push({ type: 'table', token, opts });
    } else if (token.type === 'html') {
      const text = String(token.text || '').replace(/<[^>]+>/g, '').trim();
      if (text) blocks.push(paragraph([{ kind: 'text', text, style: {} }], opts));
    }
  }
  return blocks;
}

function cellXml(cell, ctx, header) {
  const inlines = renderInline(cell?.tokens || [{ type: 'text', text: cell?.text || '' }], header ? { bold: true } : {});
  const shade = header ? '<w:shd w:val="clear" w:color="auto" w:fill="F7F7F5"/>' : '';
  return `<w:tc><w:tcPr>${shade}</w:tcPr>${paragraphXml(paragraph(inlines), ctx)}</w:tc>`;
}

function tableXml(block, ctx) {
  const token = block.token;
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((edge) => `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="DDDDDD"/>`)
    .join('');
  const header = `<w:tr>${(token.header || []).map((cell) => cellXml(cell, ctx, true)).join('')}</w:tr>`;
  const rows = (token.rows || []).map((row) => (
    `<w:tr>${row.map((cell) => cellXml(cell, ctx, false)).join('')}</w:tr>`
  )).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>${header}${rows}</w:tbl>`;
}

function blockXml(block, ctx) {
  if (block.type === 'table') return tableXml(block, ctx);
  return paragraphXml(block, ctx);
}

function markdownBlocks(source, opts) {
  return renderBlocks(marked.lexer(String(source || ''), { gfm: true, breaks: true }), opts);
}

function entryBlocks(entry) {
  const blocks = [];
  const author = String(entry?.author || '未知').replace(/\r?\n/g, ' ');
  const inlines = [{ kind: 'text', text: author, style: { bold: true } }];
  if (entry?.time) inlines.push({ kind: 'text', text: ` ${entry.time}`, style: { color: '888888', size: 18 } });
  blocks.push(paragraph(inlines));
  if (entry?.forward?.text) {
    blocks.push(paragraph(
      [{ kind: 'text', text: `转发 · ${entry.forward.authorLabel || '未知'}`, style: { bold: true, size: 18, color: '666666' } }],
      { quote: true },
    ));
    blocks.push(...markdownBlocks(entry.forward.text, { quote: true }));
  } else if (entry?.quote?.text) {
    blocks.push(paragraph(
      [{ kind: 'text', text: `引用 · ${entry.quote.authorLabel || '未知'}`, style: { bold: true, size: 18, color: '666666' } }],
      { quote: true },
    ));
    blocks.push(...markdownBlocks(entry.quote.text, { quote: true }));
  }
  const body = String(entry?.text || '').trim();
  if (body) blocks.push(...markdownBlocks(body));
  return blocks;
}

function documentXml(entries) {
  const ctx = { rels: [] };
  const blocks = [];
  (Array.isArray(entries) ? entries : []).forEach((entry, index) => {
    if (index) blocks.push(paragraph([], { rule: true }));
    blocks.push(...entryBlocks(entry));
  });
  if (!blocks.length) blocks.push(paragraph([]));
  const body = blocks.map((block) => blockXml(block, ctx)).join('');
  const xml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    `<w:body>${body}`,
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="720" w:footer="720"/></w:sectPr>',
    '</w:body></w:document>',
  ].join('');
  return { xml, rels: ctx.rels };
}

function stylesXml() {
  const heading = (id, size) => `
    <w:style w:type="paragraph" w:styleId="${id}">
      <w:name w:val="${id}"/>
      <w:basedOn w:val="Normal"/>
      <w:qFormat/>
      <w:pPr><w:spacing w:before="200" w:after="80"/></w:pPr>
      <w:rPr><w:b/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>
    </w:style>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr>
      <w:rFonts w:ascii="PingFang SC" w:hAnsi="PingFang SC" w:eastAsia="PingFang SC" w:cs="PingFang SC"/>
      <w:sz w:val="21"/><w:szCs w:val="21"/>
    </w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  ${heading('Heading1', 32)}
  ${heading('Heading2', 28)}
  ${heading('Heading3', 24)}
</w:styles>`;
}

function contentTypesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;
}

function packageRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
}

function documentRelsXml(rels) {
  const links = (rels || []).map((rel) => (
    `<Relationship Id="${rel.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(rel.href)}" TargetMode="External"/>`
  )).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  ${links}
</Relationships>`;
}

function buildExportDocx(entries) {
  const { xml, rels } = documentXml(entries);
  return zipStore([
    { name: '[Content_Types].xml', data: contentTypesXml() },
    { name: '_rels/.rels', data: packageRelsXml() },
    { name: 'word/document.xml', data: xml },
    { name: 'word/styles.xml', data: stylesXml() },
    { name: 'word/_rels/document.xml.rels', data: documentRelsXml(rels) },
  ]);
}

module.exports = { buildExportDocx };
