/**
 * 纯文本修订模型。
 * baseText 是已经接受过的正文；originalText 永远是打开时的原稿。
 * 未解决的修订用相对 baseText 的偏移表示。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.CopyEditModel = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function copyEditModelFactory() {
  let seq = 0;
  const idSalt = Math.random().toString(36).slice(2, 8);

  // 暂存草稿重新载入后会和新修订混在一起，id 不能只靠本次会话的计数器。
  function nextId(prefix) {
    seq += 1;
    return `${prefix}_${Date.now().toString(36)}${idSalt}${seq.toString(36)}`;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function createDocument(text) {
    const source = String(text ?? '').replace(/\r\n/g, '\n');
    return {
      originalText: source,
      baseText: source,
      patches: [],
    };
  }

  function restoreDocument(saved) {
    const originalText = String(saved?.originalText ?? '').replace(/\r\n/g, '\n');
    const baseText = typeof saved?.baseText === 'string' ? saved.baseText : originalText;
    const patches = Array.isArray(saved?.patches)
      ? saved.patches
        .filter((patch) => patch && typeof patch === 'object' && typeof patch.id === 'string')
        .map((patch) => ({
          ...patch,
          comments: Array.isArray(patch.comments) ? patch.comments.map((note) => ({ ...note })) : [],
        }))
      : [];
    return { originalText, baseText, patches };
  }

  function pendingPatches(doc) {
    return doc.patches.filter((patch) => patch.status === 'pending');
  }

  function makePatch(fields) {
    return {
      id: nextId('rev'),
      type: fields.type,
      author: 'User',
      timestamp: Date.now(),
      startOffset: fields.startOffset ?? 0,
      endOffset: fields.endOffset ?? fields.startOffset ?? 0,
      oldText: fields.oldText || '',
      newText: fields.newText || '',
      moveTargetOffset: fields.type === 'move' ? (fields.moveTargetOffset ?? 0) : undefined,
      comments: [],
      status: 'pending',
      hostPatchId: fields.hostPatchId || '',
      hostStart: fields.hostStart,
      hostEnd: fields.hostEnd,
    };
  }

  function getPatch(doc, id) {
    return doc.patches.find((patch) => patch.id === id) || null;
  }

  function comparePatch(a, b) {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return String(a.id).localeCompare(String(b.id));
  }

  function buildPieces(doc) {
    const base = doc.baseText || '';
    const pending = pendingPatches(doc);
    const inserts = pending.filter((patch) => patch.type === 'insert').sort(comparePatch);
    const ranges = pending
      .filter((patch) => patch.type === 'delete' || patch.type === 'replace' || patch.type === 'move')
      .sort((a, b) => a.startOffset - b.startOffset || comparePatch(a, b));
    const pieces = [];
    const emittedInserts = new Set();
    const emittedMoveDest = new Set();

    function emitInsertsAt(offset) {
      for (const patch of inserts) {
        if (patch.startOffset !== offset || emittedInserts.has(patch.id)) continue;
        pieces.push({
          kind: 'ins',
          text: patch.newText || '',
          patchId: patch.id,
          baseStart: offset,
          baseEnd: offset,
        });
        emittedInserts.add(patch.id);
      }
    }

    function emitMoveDestAt(offset) {
      for (const patch of pending) {
        if (patch.type !== 'move' || patch.moveTargetOffset !== offset || emittedMoveDest.has(patch.id)) continue;
        if (offset > patch.startOffset && offset < patch.endOffset) continue;
        pieces.push({
          kind: 'moveDst',
          text: patch.oldText || '',
          patchId: patch.id,
          baseStart: offset,
          baseEnd: offset,
        });
        emittedMoveDest.add(patch.id);
      }
    }

    let index = 0;
    while (index < base.length) {
      emitMoveDestAt(index);
      emitInsertsAt(index);
      const starting = ranges.find((patch) => patch.startOffset === index);
      if (!starting) {
        const covering = ranges.find((patch) => patch.startOffset < index && patch.endOffset > index);
        if (covering) {
          index = covering.endOffset;
          continue;
        }
        let next = base.length;
        for (const patch of ranges) {
          if (patch.startOffset > index && patch.startOffset < next) next = patch.startOffset;
        }
        for (const patch of inserts) {
          if (patch.startOffset > index && patch.startOffset < next) next = patch.startOffset;
        }
        for (const patch of pending) {
          if (patch.type === 'move' && patch.moveTargetOffset > index && patch.moveTargetOffset < next) {
            next = patch.moveTargetOffset;
          }
        }
        pieces.push({
          kind: 'base',
          text: base.slice(index, next),
          patchId: null,
          baseStart: index,
          baseEnd: next,
        });
        index = next;
        continue;
      }

      if (starting.type === 'move') {
        pieces.push({
          kind: 'moveSrc',
          text: '[ ↗ 从此处移出 ]',
          patchId: starting.id,
          baseStart: starting.startOffset,
          baseEnd: starting.endOffset,
          moved: starting.oldText || '',
        });
        index = starting.endOffset;
        continue;
      }

      const end = starting.endOffset;
      let cursor = index;
      while (cursor < end) {
        let next = end;
        for (const patch of inserts) {
          if (patch.startOffset > cursor && patch.startOffset < end && patch.startOffset < next) {
            next = patch.startOffset;
          }
        }
        if (next > cursor) {
          pieces.push({
            kind: 'del',
            text: base.slice(cursor, next),
            patchId: starting.id,
            baseStart: cursor,
            baseEnd: next,
          });
        }
        if (next < end) {
          emitInsertsAt(next);
          cursor = next;
        } else {
          cursor = end;
        }
      }
      if (starting.type === 'replace') {
        pieces.push({
          kind: 'repl',
          text: starting.newText || '',
          patchId: starting.id,
          baseStart: end,
          baseEnd: end,
        });
      }
      index = end;
    }
    emitMoveDestAt(base.length);
    emitInsertsAt(base.length);
    if (!pieces.length) {
      pieces.push({
        kind: 'base',
        text: '',
        patchId: null,
        baseStart: 0,
        baseEnd: 0,
      });
    }
    return pieces;
  }

  function commentRangesInPiece(doc, piece) {
    const textLength = (piece.text || '').length;
    if (!textLength) return [];
    const ranges = [];
    for (const patch of pendingPatches(doc)) {
      if (patch.type !== 'comment') continue;
      let start = 0;
      let end = 0;
      if (patch.hostPatchId) {
        if (piece.patchId !== patch.hostPatchId) continue;
        const hostStart = Number.isFinite(patch.hostStart) ? patch.hostStart : 0;
        const hostEnd = Number.isFinite(patch.hostEnd) ? patch.hostEnd : textLength;
        start = clamp(hostStart, 0, textLength);
        end = clamp(hostEnd, 0, textLength);
      } else if (piece.kind === 'ins' || piece.kind === 'repl' || piece.kind === 'moveDst') {
        const point = piece.baseStart ?? 0;
        if (point <= patch.startOffset || point >= patch.endOffset) continue;
        start = 0;
        end = textLength;
      } else if (piece.kind === 'moveSrc') {
        const pieceStart = piece.baseStart ?? 0;
        const pieceEnd = piece.baseEnd ?? pieceStart;
        if (pieceStart >= patch.endOffset || pieceEnd <= patch.startOffset) continue;
        start = 0;
        end = textLength;
      } else {
        const pieceStart = piece.baseStart ?? 0;
        start = Math.max(0, patch.startOffset - pieceStart);
        end = Math.min(textLength, (patch.endOffset ?? patch.startOffset) - pieceStart);
      }
      if (end > start) ranges.push({ start, end, id: patch.id });
    }
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range.start < last.end) {
        last.end = Math.max(last.end, range.end);
        if (!last.ids.includes(range.id)) last.ids.push(range.id);
      } else {
        merged.push({ start: range.start, end: range.end, ids: [range.id] });
      }
    }
    return merged;
  }

  function pieceCommentIds(doc, piece) {
    const ids = [];
    for (const range of commentRangesInPiece(doc, piece)) {
      for (const id of range.ids) {
        if (!ids.includes(id)) ids.push(id);
      }
    }
    return ids;
  }

  function resolvePos(pieces, pos) {
    if (!pos || !pieces.length) return { pieceIndex: 0, offset: 0 };
    const pieceIndex = clamp(pos.pieceIndex || 0, 0, pieces.length - 1);
    const piece = pieces[pieceIndex];
    return {
      pieceIndex,
      offset: clamp(pos.offset || 0, 0, piece.text.length),
    };
  }

  function comparePos(a, b) {
    if (a.pieceIndex !== b.pieceIndex) return a.pieceIndex - b.pieceIndex;
    return a.offset - b.offset;
  }

  function placeCaret(pieces, spec) {
    if (!pieces.length) return { pieceIndex: 0, offset: 0 };
    if (!spec) {
      const last = pieces.length - 1;
      return { pieceIndex: last, offset: pieces[last].text.length };
    }
    if (Number.isInteger(spec.pieceIndex)) return resolvePos(pieces, spec);
    if (spec.pieceKind === 'ins' || spec.pieceKind === 'repl' || spec.pieceKind === 'moveDst' || spec.pieceKind === 'moveSrc') {
      const index = pieces.findIndex((piece) => piece.kind === spec.pieceKind && piece.patchId === spec.patchId);
      if (index >= 0) {
        return {
          pieceIndex: index,
          offset: clamp(spec.offset || 0, 0, pieces[index].text.length),
        };
      }
    }
    if (spec.pieceKind === 'del') {
      const base = spec.base ?? 0;
      const index = pieces.findIndex((piece) => (
        piece.kind === 'del'
        && (!spec.patchId || piece.patchId === spec.patchId)
        && base >= piece.baseStart
        && base <= piece.baseEnd
      ));
      if (index >= 0) {
        return { pieceIndex: index, offset: clamp(base - pieces[index].baseStart, 0, pieces[index].text.length) };
      }
    }
    const offset = spec.offset ?? 0;
    for (let index = pieces.length - 1; index >= 0; index -= 1) {
      const piece = pieces[index];
      if (piece.kind === 'base' && offset >= piece.baseStart && offset <= piece.baseEnd) {
        return { pieceIndex: index, offset: offset - piece.baseStart };
      }
    }
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      if ((piece.kind === 'del' || piece.kind === 'moveSrc') && piece.baseStart === offset) {
        return { pieceIndex: index, offset: 0 };
      }
    }
    const last = pieces.length - 1;
    return { pieceIndex: last, offset: pieces[last].text.length };
  }

  function orderedRange(pieces, startPos, endPos) {
    const start = resolvePos(pieces, startPos);
    const end = resolvePos(pieces, endPos);
    if (comparePos(start, end) <= 0) return { start, end };
    return { start: end, end: start };
  }

  function iterSlices(pieces, range) {
    const slices = [];
    for (let index = range.start.pieceIndex; index <= range.end.pieceIndex; index += 1) {
      const piece = pieces[index];
      const from = index === range.start.pieceIndex ? range.start.offset : 0;
      const to = index === range.end.pieceIndex ? range.end.offset : piece.text.length;
      if (to <= from) continue;
      slices.push({
        piece,
        pieceIndex: index,
        charStart: from,
        charEnd: to,
        baseStart: piece.kind === 'base' || piece.kind === 'del' || piece.kind === 'moveSrc'
          ? piece.baseStart + from
          : piece.baseStart,
        baseEnd: piece.kind === 'base' || piece.kind === 'del' || piece.kind === 'moveSrc'
          ? piece.baseStart + to
          : piece.baseEnd,
      });
    }
    return slices;
  }

  function selectedFragment(doc, startPos, endPos) {
    const pieces = buildPieces(doc);
    const range = orderedRange(pieces, startPos, endPos);
    return iterSlices(pieces, range).map((slice) => {
      if (slice.piece.kind === 'moveSrc') return slice.piece.moved || '';
      return slice.piece.text.slice(slice.charStart, slice.charEnd);
    }).join('');
  }

  function rangeConflict(doc, start, end) {
    return pendingPatches(doc).find((patch) => {
      if (patch.type !== 'delete' && patch.type !== 'replace' && patch.type !== 'move') return false;
      return start < patch.endOffset && end > patch.startOffset;
    }) || null;
  }

  function addDeletion(doc, start, end) {
    if (end <= start) return null;
    const conflict = pendingPatches(doc).find((patch) => (
      (patch.type === 'replace' || patch.type === 'move')
      && start < patch.endOffset
      && end > patch.startOffset
    ));
    if (conflict) {
      if (start < conflict.startOffset) addDeletion(doc, start, Math.min(end, conflict.startOffset));
      if (end > conflict.endOffset) addDeletion(doc, Math.max(start, conflict.endOffset), end);
      return null;
    }
    let mergedStart = start;
    let mergedEnd = end;
    const absorbed = [];
    for (const patch of pendingPatches(doc)) {
      if (patch.type !== 'delete') continue;
      if (patch.endOffset < mergedStart || patch.startOffset > mergedEnd) continue;
      absorbed.push(patch);
      mergedStart = Math.min(mergedStart, patch.startOffset);
      mergedEnd = Math.max(mergedEnd, patch.endOffset);
    }
    if (absorbed.length) {
      doc.patches = doc.patches.filter((patch) => !absorbed.includes(patch));
    }
    const patch = makePatch({
      type: 'delete',
      startOffset: mergedStart,
      endOffset: mergedEnd,
      oldText: doc.baseText.slice(mergedStart, mergedEnd),
    });
    doc.patches.push(patch);
    return patch;
  }

  function insertText(doc, pos, text) {
    const value = String(text ?? '').replace(/\r\n/g, '\n');
    const pieces = buildPieces(doc);
    if (!value) return resolvePos(pieces, pos);
    let caret = resolvePos(pieces, pos);
    let piece = pieces[caret.pieceIndex];
    if (piece.kind === 'base' && caret.offset === 0 && caret.pieceIndex > 0) {
      const prev = pieces[caret.pieceIndex - 1];
      if (prev.kind === 'ins' && prev.baseStart === piece.baseStart) {
        caret = { pieceIndex: caret.pieceIndex - 1, offset: prev.text.length };
        piece = prev;
      }
    }
    if (piece.kind === 'ins' || piece.kind === 'repl' || piece.kind === 'moveDst') {
      const patch = getPatch(doc, piece.patchId);
      if (!patch || patch.status !== 'pending') {
        return { pieceKind: 'base', offset: piece.baseStart };
      }
      const field = piece.kind === 'moveDst' ? 'oldText' : 'newText';
      const current = patch[field] || '';
      const offset = clamp(caret.offset, 0, current.length);
      patch[field] = current.slice(0, offset) + value + current.slice(offset);
      if (piece.kind === 'moveDst') patch.oldText = patch[field];
      return { pieceKind: piece.kind, patchId: patch.id, offset: offset + value.length };
    }
    const baseAt = piece.kind === 'base'
      ? piece.baseStart + caret.offset
      : (piece.kind === 'del' ? piece.baseStart + caret.offset : piece.baseStart);
    const patch = makePatch({
      type: 'insert',
      startOffset: baseAt,
      endOffset: baseAt,
      newText: value,
    });
    doc.patches.push(patch);
    return { pieceKind: 'ins', patchId: patch.id, offset: value.length };
  }

  function editPatchText(doc, piece, charStart, charEnd) {
    const patch = getPatch(doc, piece.patchId);
    if (!patch || patch.status !== 'pending') return null;
    const field = piece.kind === 'moveDst' ? 'oldText' : 'newText';
    const current = patch[field] || '';
    patch[field] = current.slice(0, charStart) + current.slice(charEnd);
    if (patch.type === 'insert' && !patch.newText) {
      doc.patches = doc.patches.filter((item) => item.id !== patch.id);
      return { pieceKind: 'base', offset: piece.baseStart };
    }
    if (patch.type === 'move' && !patch.oldText) {
      doc.patches = doc.patches.filter((item) => item.id !== patch.id);
      return { pieceKind: 'base', offset: piece.baseStart };
    }
    return { pieceKind: piece.kind, patchId: patch.id, offset: charStart };
  }

  function deleteCharAt(doc, pieces, pieceIndex, charOffset) {
    const piece = pieces[pieceIndex];
    if (!piece || charOffset < 0 || charOffset >= piece.text.length) return null;
    if (piece.kind === 'base') {
      const base = piece.baseStart + charOffset;
      addDeletion(doc, base, base + 1);
      return { pieceKind: 'del', base: base + 1 };
    }
    if (piece.kind === 'ins' || piece.kind === 'repl' || piece.kind === 'moveDst') {
      return editPatchText(doc, piece, charOffset, charOffset + 1);
    }
    if (piece.kind === 'del') {
      return { pieceKind: 'del', patchId: piece.patchId, base: piece.baseStart + charOffset };
    }
    return { pieceKind: piece.kind, patchId: piece.patchId, offset: 0 };
  }

  function deleteBackward(doc, pos) {
    const pieces = buildPieces(doc);
    let caret = resolvePos(pieces, pos);
    if (caret.offset > 0) {
      return deleteCharAt(doc, pieces, caret.pieceIndex, caret.offset - 1) || caret;
    }
    let previous = caret.pieceIndex - 1;
    while (previous >= 0 && (pieces[previous].kind === 'moveSrc' || !pieces[previous].text.length)) {
      previous -= 1;
    }
    if (previous < 0) return { pieceKind: 'base', offset: 0 };
    return deleteCharAt(doc, pieces, previous, pieces[previous].text.length - 1) || caret;
  }

  function deleteForward(doc, pos) {
    const pieces = buildPieces(doc);
    let caret = resolvePos(pieces, pos);
    const piece = pieces[caret.pieceIndex];
    if (caret.offset < piece.text.length && piece.kind !== 'moveSrc') {
      return deleteCharAt(doc, pieces, caret.pieceIndex, caret.offset) || caret;
    }
    let next = caret.pieceIndex + (caret.offset >= piece.text.length ? 1 : 0);
    while (next < pieces.length && (pieces[next].kind === 'moveSrc' || !pieces[next].text.length)) next += 1;
    if (next >= pieces.length) return placeCaret(pieces, caret);
    return deleteCharAt(doc, pieces, next, 0) || caret;
  }

  function cleanBaseSelection(doc, startPos, endPos) {
    const pieces = buildPieces(doc);
    const range = orderedRange(pieces, startPos, endPos);
    if (comparePos(range.start, range.end) === 0) return { ok: false };
    const slices = iterSlices(pieces, range);
    if (!slices.length || slices.some((slice) => slice.piece.kind !== 'base')) return { ok: false };
    const start = slices[0].baseStart;
    const end = slices[slices.length - 1].baseEnd;
    const covered = slices.reduce((sum, slice) => sum + (slice.baseEnd - slice.baseStart), 0);
    if (covered !== end - start) return { ok: false };
    if (rangeConflict(doc, start, end)) return { ok: false };
    return { ok: true, start, end };
  }

  function deleteSelection(doc, startPos, endPos) {
    const pieces = buildPieces(doc);
    const range = orderedRange(pieces, startPos, endPos);
    if (comparePos(range.start, range.end) === 0) return { pieceKind: 'base', offset: 0 };
    const slices = iterSlices(pieces, range);
    const textEdits = [];
    const baseCuts = [];
    let caretBase = null;
    for (const slice of slices) {
      if (slice.piece.kind === 'base') {
        baseCuts.push([slice.baseStart, slice.baseEnd]);
        if (caretBase == null) caretBase = slice.baseEnd;
      } else if (slice.piece.kind === 'ins' || slice.piece.kind === 'repl' || slice.piece.kind === 'moveDst') {
        textEdits.push({
          patchId: slice.piece.patchId,
          field: slice.piece.kind === 'moveDst' ? 'oldText' : 'newText',
          start: slice.charStart,
          end: slice.charEnd,
          kind: slice.piece.kind,
          base: slice.piece.baseStart,
        });
        if (caretBase == null) caretBase = slice.piece.baseStart;
      }
    }
    textEdits.sort((a, b) => b.start - a.start);
    let textCaret = null;
    for (const edit of textEdits) {
      const piece = { kind: edit.kind, patchId: edit.patchId, baseStart: edit.base };
      textCaret = editPatchText(doc, piece, edit.start, edit.end) || textCaret;
    }
    baseCuts.sort((a, b) => b[0] - a[0]);
    const merged = [];
    for (const cut of baseCuts) {
      const last = merged[merged.length - 1];
      if (last && cut[1] >= last[0]) last[0] = Math.min(last[0], cut[0]);
      else merged.push([...cut]);
    }
    for (const [start, end] of merged) addDeletion(doc, start, end);
    if (baseCuts.length) return { pieceKind: 'del', base: caretBase ?? baseCuts[0][1] };
    return textCaret || { pieceKind: 'base', offset: slices[0]?.baseStart || 0 };
  }

  function replaceSelection(doc, startPos, endPos, text) {
    const value = String(text ?? '').replace(/\r\n/g, '\n');
    const clean = cleanBaseSelection(doc, startPos, endPos);
    if (clean.ok) {
      if (!value) {
        addDeletion(doc, clean.start, clean.end);
        return { pieceKind: 'del', base: clean.end };
      }
      const patch = makePatch({
        type: 'replace',
        startOffset: clean.start,
        endOffset: clean.end,
        oldText: doc.baseText.slice(clean.start, clean.end),
        newText: value,
      });
      doc.patches.push(patch);
      return { pieceKind: 'repl', patchId: patch.id, offset: value.length };
    }
    const caret = deleteSelection(doc, startPos, endPos);
    if (!value) return caret;
    const pieces = buildPieces(doc);
    return insertText(doc, placeCaret(pieces, caret), value);
  }

  function moveSelection(doc, startPos, endPos, targetPos) {
    const clean = cleanBaseSelection(doc, startPos, endPos);
    if (!clean.ok) return { ok: false, error: '只能移动还没有修订过的连续原文' };
    const pieces = buildPieces(doc);
    const targetCaret = resolvePos(pieces, targetPos);
    const targetPiece = pieces[targetCaret.pieceIndex];
    let target = targetPiece.baseStart;
    if (targetPiece.kind === 'base') target = targetPiece.baseStart + targetCaret.offset;
    else if (targetPiece.kind === 'del') target = targetPiece.baseStart + targetCaret.offset;
    if (target > clean.start && target < clean.end) {
      return { ok: false, error: '不能移动到选区里面' };
    }
    const patch = makePatch({
      type: 'move',
      startOffset: clean.start,
      endOffset: clean.end,
      oldText: doc.baseText.slice(clean.start, clean.end),
      moveTargetOffset: target,
    });
    doc.patches.push(patch);
    return { ok: true, caret: { pieceKind: 'moveDst', patchId: patch.id, offset: patch.oldText.length } };
  }

  function addComment(doc, startPos, endPos, content, hostPatchId) {
    const note = String(content || '').trim();
    if (!note) return { ok: false, error: '批注不能为空' };
    const fragment = selectedFragment(doc, startPos, endPos).trim();
    const host = hostPatchId ? getPatch(doc, hostPatchId) : null;
    if (host && host.status === 'pending') {
      host.comments.push({
        id: nextId('com'),
        author: 'User',
        content: note,
        timestamp: Date.now(),
      });
      return { ok: true, patchId: host.id };
    }
    if (!fragment) return { ok: false, error: '请先选中要批注的文字' };
    const pieces = buildPieces(doc);
    const range = orderedRange(pieces, startPos, endPos);
    const slices = iterSlices(pieces, range);
    const only = slices.length === 1 ? slices[0] : null;
    let startOffset = 0;
    let endOffset = 0;
    let hostId = '';
    let hostStart;
    let hostEnd;
    if (only && (only.piece.kind === 'ins' || only.piece.kind === 'repl' || only.piece.kind === 'moveDst')) {
      startOffset = only.piece.baseStart;
      endOffset = only.piece.baseStart;
      hostId = only.piece.patchId || '';
      hostStart = only.charStart;
      hostEnd = only.charEnd;
    } else if (slices.length) {
      startOffset = Math.min(...slices.map((slice) => slice.baseStart));
      endOffset = Math.max(...slices.map((slice) => (
        slice.piece.kind === 'base' || slice.piece.kind === 'del' || slice.piece.kind === 'moveSrc'
          ? slice.baseEnd
          : slice.baseStart
      )));
      if (endOffset <= startOffset) endOffset = startOffset + fragment.length;
    }
    const patch = makePatch({
      type: 'comment',
      startOffset,
      endOffset,
      oldText: fragment,
      hostPatchId: hostId,
      hostStart,
      hostEnd,
    });
    patch.comments.push({
      id: nextId('com'),
      author: 'User',
      content: note,
      timestamp: Date.now(),
    });
    doc.patches.push(patch);
    return { ok: true, patchId: patch.id };
  }

  function mapOffsetAfterDelete(offset, start, end) {
    const length = end - start;
    if (offset >= end) return offset - length;
    if (offset > start) return start;
    return offset;
  }

  function shiftPatchAfterDelete(patch, start, end) {
    patch.startOffset = mapOffsetAfterDelete(patch.startOffset, start, end);
    patch.endOffset = mapOffsetAfterDelete(patch.endOffset, start, end);
    if (patch.endOffset < patch.startOffset) patch.endOffset = patch.startOffset;
    if (patch.type === 'move') {
      patch.moveTargetOffset = mapOffsetAfterDelete(patch.moveTargetOffset, start, end);
    }
  }

  function shiftPatchAfterInsert(patch, at, length, stickBefore) {
    if (!length) return;
    const move = (offset) => {
      if (offset > at) return offset + length;
      if (offset < at) return offset;
      return stickBefore ? offset : offset + length;
    };
    patch.startOffset = move(patch.startOffset);
    patch.endOffset = move(patch.endOffset);
    if (patch.type === 'move') patch.moveTargetOffset = move(patch.moveTargetOffset);
  }

  function spliceDelete(doc, start, end, skipId) {
    if (end <= start) return;
    doc.baseText = doc.baseText.slice(0, start) + doc.baseText.slice(end);
    for (const patch of doc.patches) {
      if (patch.status !== 'pending' || patch.id === skipId) continue;
      if (patch.type === 'delete' || patch.type === 'replace' || patch.type === 'move') {
        if (patch.startOffset >= start && patch.endOffset <= end) {
          patch.status = 'rejected';
          continue;
        }
      }
      shiftPatchAfterDelete(patch, start, end);
      if ((patch.type === 'delete' || patch.type === 'replace' || patch.type === 'move') && patch.endOffset <= patch.startOffset) {
        patch.status = 'rejected';
      }
    }
  }

  function spliceInsert(doc, at, text, skipId, stickBeforeIds) {
    const value = text || '';
    doc.baseText = doc.baseText.slice(0, at) + value + doc.baseText.slice(at);
    if (!value) return;
    for (const patch of doc.patches) {
      if (patch.status !== 'pending' || patch.id === skipId) continue;
      shiftPatchAfterInsert(patch, at, value.length, Boolean(stickBeforeIds && stickBeforeIds.has(patch.id)));
    }
  }

  function pointIdsAt(doc, offset, skipId) {
    const ids = new Set();
    for (const patch of pendingPatches(doc)) {
      if (patch.id === skipId) continue;
      if (patch.type === 'insert' && patch.startOffset === offset) ids.add(patch.id);
      if (patch.type === 'move' && patch.moveTargetOffset === offset) ids.add(patch.id);
      if (patch.type === 'comment' && patch.startOffset === offset && patch.endOffset === offset) ids.add(patch.id);
    }
    return ids;
  }

  function undoPatch(doc, id) {
    const patch = doc.patches.find((item) => item.id === id && item.status === 'pending');
    if (!patch || patch.type === 'comment') return false;
    const removeIds = new Set([id]);
    for (const item of doc.patches) {
      if (item.status === 'pending' && item.type === 'comment' && item.hostPatchId === id) {
        removeIds.add(item.id);
      }
    }
    doc.patches = doc.patches.filter((item) => !removeIds.has(item.id));
    return true;
  }

  function acceptPatch(doc, id) {
    const patch = doc.patches.find((item) => item.id === id && item.status === 'pending');
    if (!patch) return false;
    if (patch.type === 'comment') {
      patch.status = 'accepted';
      return true;
    }
    if (patch.type === 'insert') {
      spliceInsert(doc, patch.startOffset, patch.newText || '', patch.id);
    } else if (patch.type === 'delete') {
      spliceDelete(doc, patch.startOffset, patch.endOffset, patch.id);
    } else if (patch.type === 'replace') {
      const start = patch.startOffset;
      const end = patch.endOffset;
      const beforeIds = pointIdsAt(doc, start, patch.id);
      spliceDelete(doc, start, end, patch.id);
      spliceInsert(doc, start, patch.newText || '', patch.id, beforeIds);
    } else if (patch.type === 'move') {
      const start = patch.startOffset;
      const end = patch.endOffset;
      let target = patch.moveTargetOffset;
      if (target >= end) target -= (end - start);
      else if (target > start) target = start;
      const beforeIds = pointIdsAt(doc, target <= start ? target : end, patch.id);
      spliceDelete(doc, start, end, patch.id);
      spliceInsert(doc, target, patch.oldText || '', patch.id, beforeIds);
    }
    patch.status = 'accepted';
    return true;
  }

  function rejectPatch(doc, id) {
    const patch = doc.patches.find((item) => item.id === id && item.status === 'pending');
    if (!patch) return false;
    patch.status = 'rejected';
    return true;
  }

  function acceptAll(doc) {
    let guard = 0;
    while (guard < 10000) {
      const next = doc.patches.find((patch) => patch.status === 'pending');
      if (!next) break;
      acceptPatch(doc, next.id);
      guard += 1;
    }
  }

  function rejectAll(doc) {
    for (const patch of doc.patches) {
      if (patch.status === 'pending') patch.status = 'rejected';
    }
  }

  function finalText(doc) {
    return buildPieces(doc)
      .filter((piece) => piece.kind === 'base' || piece.kind === 'ins' || piece.kind === 'repl' || piece.kind === 'moveDst')
      .map((piece) => piece.text)
      .join('');
  }

  function markupText(doc) {
    return buildPieces(doc).map((piece) => piece.text).join('');
  }

  function escapeText(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeAttr(value) {
    return escapeText(value).replace(/"/g, '&quot;');
  }

  function replaceIsSplit(pieces, patchId) {
    const related = pieces.filter((piece) => piece.patchId === patchId && (piece.kind === 'del' || piece.kind === 'ins'));
    const dels = pieces.filter((piece) => piece.patchId === patchId && piece.kind === 'del');
    return dels.length > 1 || related.some((piece) => piece.kind === 'ins');
  }

  function flowFromDocument(doc) {
    const pieces = buildPieces(doc);
    let out = '';
    let index = 0;
    while (index < pieces.length) {
      const piece = pieces[index];
      if (piece.kind === 'base') {
        out += escapeText(piece.text);
      } else if (piece.kind === 'ins') {
        out += `<ins>${escapeText(piece.text)}</ins>`;
      } else if (piece.kind === 'del') {
        const patch = getPatch(doc, piece.patchId);
        if (patch?.type === 'replace' && !replaceIsSplit(pieces, patch.id)) {
          out += `<replace from="${escapeAttr(patch.oldText)}" to="${escapeAttr(patch.newText)}"/>`;
          while (index + 1 < pieces.length && pieces[index + 1].patchId === patch.id && (pieces[index + 1].kind === 'del' || pieces[index + 1].kind === 'repl')) {
            index += 1;
          }
        } else {
          out += `<del>${escapeText(piece.text)}</del>`;
        }
      } else if (piece.kind === 'repl') {
        const patch = getPatch(doc, piece.patchId);
        if (patch && replaceIsSplit(pieces, patch.id)) {
          out += `<ins>${escapeText(patch.newText || '')}</ins>`;
        }
      } else if (piece.kind === 'moveSrc') {
        const patch = getPatch(doc, piece.patchId);
        out += `<move-out>${escapeText(patch?.oldText || piece.moved || '')}</move-out>`;
      } else if (piece.kind === 'moveDst') {
        const patch = getPatch(doc, piece.patchId);
        out += `<move-in>${escapeText(patch?.oldText || piece.text)}</move-in>`;
      }
      index += 1;
    }
    return out;
  }

  function commentBlocks(patches) {
    const blocks = [];
    for (const patch of patches) {
      if (patch.status === 'rejected') continue;
      const notes = Array.isArray(patch.comments) ? patch.comments : [];
      if (!notes.length) continue;
      if (patch.type === 'comment' && patch.status !== 'pending') continue;
      if (patch.type !== 'comment' && patch.status !== 'pending' && patch.status !== 'accepted') continue;
      const fragment = patch.type === 'insert'
        ? (patch.newText || '')
        : (patch.oldText || patch.newText || '');
      for (const note of notes) {
        blocks.push({
          content: note.content || '',
          fragment,
          timestamp: note.timestamp || patch.timestamp || 0,
        });
      }
    }
    blocks.sort((a, b) => a.timestamp - b.timestamp);
    if (!blocks.length) return '（无）';
    return blocks.map((block) => (
      `<comment target="${escapeAttr(block.content)}">\n关联的正文局部片段：${escapeText(block.fragment)}\n</comment>`
    )).join('\n\n');
  }

  function exportToAgentPrompt(documentText, patches) {
    const doc = {
      originalText: String(documentText ?? ''),
      baseText: String(documentText ?? ''),
      patches: Array.isArray(patches) ? patches : [],
    };
    const flow = flowFromDocument(doc);
    const comments = commentBlocks(doc.patches);
    return [
      '请根据以下用户在编辑器中留下的修订痕迹、精确修改以及开放式批注，对文案进行重写优化：',
      '',
      '<del> 内的文字是用户已明确砍掉的，重写时严禁再次出现。',
      '<ins> 内的文字是用户手动补充的核心文案，后续润色必须保留。',
      '<replace from="..." to="..."/> 是用户已完成的定点纠错，直接按此替换。',
      '<move-out> 与同文的 <move-in> 成对，表示用户把这段从原位移到了新位置，请按新位置保留。',
      '<comment target="..."> 是用户没有给出标准答案的开放式批注，请按 target 重写关联片段。',
      '',
      '[上下文正文流]',
      flow,
      '',
      '而最重要的是以下用户的开放式批注（用户不知道怎么改，要求你结合上下文自行发挥）：',
      comments,
    ].join('\n');
  }

  function pendingCount(doc) {
    return pendingPatches(doc).length;
  }

  return {
    createDocument,
    restoreDocument,
    buildPieces,
    commentRangesInPiece,
    pieceCommentIds,
    placeCaret,
    insertText,
    deleteBackward,
    deleteForward,
    deleteSelection,
    replaceSelection,
    moveSelection,
    addComment,
    undoPatch,
    acceptPatch,
    rejectPatch,
    acceptAll,
    rejectAll,
    finalText,
    markupText,
    selectedFragment,
    exportToAgentPrompt,
    pendingCount,
  };
});
