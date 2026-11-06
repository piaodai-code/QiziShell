const assert = require('assert');
const Model = require('../copy-edit-model');

function caret(doc, pieceIndex, offset) {
  return { pieceIndex, offset };
}

function endCaret(doc) {
  const pieces = Model.buildPieces(doc);
  const last = pieces.length - 1;
  return { pieceIndex: last, offset: pieces[last].text.length };
}

function kinds(doc) {
  return Model.buildPieces(doc).map((piece) => `${piece.kind}:${piece.text}`).join('|');
}

const doc = Model.createDocument('你好世界');
let spec = Model.insertText(doc, caret(doc, 0, 2), '，');
assert.strictEqual(Model.markupText(doc), '你好，世界');
assert.strictEqual(Model.finalText(doc), '你好，世界');
assert.strictEqual(doc.originalText, '你好世界');
assert.strictEqual(doc.patches.filter((patch) => patch.type === 'insert').length, 1);
const afterFirst = Model.placeCaret(Model.buildPieces(doc), spec);
spec = Model.insertText(doc, afterFirst, '很');
const emptySpec = Model.insertText(doc, afterFirst, '');
assert.deepStrictEqual(Model.placeCaret(Model.buildPieces(doc), emptySpec), afterFirst);
assert.strictEqual(doc.patches.filter((patch) => patch.type === 'insert' && patch.status === 'pending').length, 1);
assert.strictEqual(Model.finalText(doc), '你好，很世界');

const deleted = Model.createDocument('你好世界');
Model.deleteSelection(deleted, caret(deleted, 0, 2), caret(deleted, 0, 4));
assert.strictEqual(Model.finalText(deleted), '你好');
assert.ok(Model.markupText(deleted).includes('世界'));
const deletePrompt = Model.exportToAgentPrompt(deleted.baseText, deleted.patches);
assert.ok(deletePrompt.includes('<del>世界</del>'));
assert.ok(deletePrompt.includes('严禁再次出现'));

const replaced = Model.createDocument('旧的专有名词在这里');
Model.replaceSelection(replaced, caret(replaced, 0, 0), caret(replaced, 0, 6), '更准确的技术术语');
const replacePrompt = Model.exportToAgentPrompt(replaced.baseText, replaced.patches);
assert.ok(replacePrompt.includes('<replace from="旧的专有名词" to="更准确的技术术语"/>'));
assert.strictEqual(Model.finalText(replaced), '更准确的技术术语在这里');
assert.ok(kinds(replaced).includes('del:旧的专有名词'));
assert.ok(kinds(replaced).includes('repl:更准确的技术术语'));

const commented = Model.createDocument('这段话逻辑太生硬');
const commentResult = Model.addComment(commented, caret(commented, 0, 0), endCaret(commented), '请帮我重新组织语言，使其更通顺自然');
assert.strictEqual(commentResult.ok, true);
const commentPrompt = Model.exportToAgentPrompt(commented.baseText, commented.patches);
assert.ok(commentPrompt.includes('target="请帮我重新组织语言，使其更通顺自然"'));
assert.ok(commentPrompt.includes('关联的正文局部片段：这段话逻辑太生硬'));
assert.ok(commentPrompt.includes('而最重要的是以下用户的开放式批注'));

const accepted = Model.createDocument('你好世界');
Model.insertText(accepted, caret(accepted, 0, 2), '，');
const insertId = accepted.patches.find((patch) => patch.type === 'insert').id;
Model.acceptPatch(accepted, insertId);
assert.strictEqual(accepted.baseText, '你好，世界');
assert.strictEqual(accepted.originalText, '你好世界');
assert.strictEqual(Model.finalText(accepted), '你好，世界');
assert.strictEqual(Model.pendingCount(accepted), 0);
assert.ok(!kinds(accepted).includes('ins:'));

const rejected = Model.createDocument('你好世界');
Model.deleteSelection(rejected, caret(rejected, 0, 2), caret(rejected, 0, 4));
Model.rejectAll(rejected);
assert.strictEqual(Model.finalText(rejected), '你好世界');
assert.strictEqual(kinds(rejected), 'base:你好世界');

const moved = Model.createDocument('ABCDEFG');
const moveResult = Model.moveSelection(moved, caret(moved, 0, 2), caret(moved, 0, 4), caret(moved, 0, 6));
assert.strictEqual(moveResult.ok, true);
assert.strictEqual(Model.finalText(moved), 'ABEFCDG');
assert.ok(Model.markupText(moved).includes('[ ↗ 从此处移出 ]'));
const movePrompt = Model.exportToAgentPrompt(moved.baseText, moved.patches);
assert.ok(movePrompt.includes('<move-out>CD</move-out>'));
assert.ok(movePrompt.includes('<move-in>CD</move-in>'));
const moveId = moved.patches.find((patch) => patch.type === 'move').id;
Model.acceptPatch(moved, moveId);
assert.strictEqual(moved.baseText, 'ABEFCDG');
assert.strictEqual(moved.originalText, 'ABCDEFG');

const movedHome = Model.createDocument('ABCDEFG');
const moveHome = Model.moveSelection(movedHome, caret(movedHome, 0, 2), caret(movedHome, 0, 4), caret(movedHome, 0, 0));
assert.strictEqual(moveHome.ok, true);
Model.acceptPatch(movedHome, movedHome.patches[0].id);
assert.strictEqual(movedHome.baseText, 'CDABEFG');

const merged = Model.createDocument('abcd');
Model.deleteSelection(merged, caret(merged, 0, 1), caret(merged, 0, 3));
Model.deleteSelection(merged, caret(merged, 0, 0), { pieceIndex: 0, offset: 1 });
const liveDeletes = merged.patches.filter((patch) => patch.type === 'delete' && patch.status === 'pending');
assert.strictEqual(liveDeletes.length, 1);
assert.strictEqual(liveDeletes[0].oldText, 'abc');
assert.strictEqual(Model.finalText(merged), 'd');

const replacedAll = Model.createDocument('aabbcc');
Model.replaceSelection(replacedAll, caret(replacedAll, 0, 2), caret(replacedAll, 0, 4), 'B');
Model.acceptPatch(replacedAll, replacedAll.patches[0].id);
assert.strictEqual(replacedAll.baseText, 'aaBcc');

const unsafe = Model.createDocument('安全');
Model.insertText(unsafe, caret(unsafe, 0, 2), '<script>"&');
const unsafePrompt = Model.exportToAgentPrompt(unsafe.baseText, unsafe.patches);
assert.ok(unsafePrompt.includes('<ins>&lt;script&gt;"&amp;</ins>'));
assert.ok(!unsafePrompt.includes('<script>'));

const both = Model.createDocument('保留删掉');
Model.insertText(both, caret(both, 0, 2), '，');
const pieces = Model.buildPieces(both);
const deleteFrom = pieces.findIndex((piece) => piece.kind === 'base' && piece.text.includes('删掉'));
Model.deleteSelection(both, { pieceIndex: deleteFrom, offset: 0 }, { pieceIndex: deleteFrom, offset: 2 });
Model.acceptAll(both);
assert.strictEqual(both.baseText, '保留，');
assert.strictEqual(both.originalText, '保留删掉');

const empty = Model.createDocument('');
Model.insertText(empty, caret(empty, 0, 0), '开头');
assert.strictEqual(Model.finalText(empty), '开头');

const stashed = Model.createDocument('草稿正文');
Model.insertText(stashed, caret(stashed, 0, 2), '新增');
const restored = Model.restoreDocument(JSON.parse(JSON.stringify(stashed)));
assert.strictEqual(Model.finalText(restored), '草稿新增正文');
assert.strictEqual(restored.originalText, '草稿正文');
Model.insertText(restored, endCaret(restored), '尾巴');
const ids = restored.patches.map((patch) => patch.id);
assert.strictEqual(new Set(ids).size, ids.length);
assert.strictEqual(Model.finalText(restored), '草稿新增正文尾巴');

const partial = Model.createDocument('甲乙丙丁戊己庚辛');
const partialResult = Model.addComment(partial, caret(partial, 0, 2), caret(partial, 0, 5), '只批中间三字');
assert.strictEqual(partialResult.ok, true);
assert.strictEqual(partial.patches[0].startOffset, 2);
assert.strictEqual(partial.patches[0].endOffset, 5);
assert.strictEqual(partial.patches[0].oldText, '丙丁戊');
assert.deepStrictEqual(
  Model.commentRangesInPiece(partial, Model.buildPieces(partial)[0]).map((range) => [range.start, range.end]),
  [[2, 5]],
);

const inside = Model.createDocument('你好');
Model.insertText(inside, caret(inside, 0, 1), '世界和平');
const insIndex = Model.buildPieces(inside).findIndex((piece) => piece.kind === 'ins');
Model.addComment(inside, { pieceIndex: insIndex, offset: 1 }, { pieceIndex: insIndex, offset: 3 }, '只批中间');
const insPiece = Model.buildPieces(inside).find((piece) => piece.kind === 'ins');
assert.deepStrictEqual(
  Model.commentRangesInPiece(inside, insPiece).map((range) => [range.start, range.end]),
  [[1, 3]],
);
assert.deepStrictEqual(Model.commentRangesInPiece(inside, Model.buildPieces(inside)[0]), []);

const undoInsert = Model.createDocument('你好世界');
Model.insertText(undoInsert, caret(undoInsert, 0, 2), '，很');
const undoInsertId = undoInsert.patches[0].id;
const undoInsIndex = Model.buildPieces(undoInsert).findIndex((piece) => piece.kind === 'ins');
Model.addComment(undoInsert, { pieceIndex: undoInsIndex, offset: 0 }, { pieceIndex: undoInsIndex, offset: 1 }, '这个逗号');
assert.strictEqual(undoInsert.patches.length, 2);
assert.strictEqual(Model.undoPatch(undoInsert, undoInsertId), true);
assert.strictEqual(undoInsert.patches.length, 0);
assert.strictEqual(Model.finalText(undoInsert), '你好世界');
assert.strictEqual(Model.markupText(undoInsert), '你好世界');

const undoDelete = Model.createDocument('你好世界');
Model.deleteSelection(undoDelete, caret(undoDelete, 0, 2), caret(undoDelete, 0, 4));
assert.strictEqual(Model.finalText(undoDelete), '你好');
assert.strictEqual(Model.undoPatch(undoDelete, undoDelete.patches[0].id), true);
assert.strictEqual(Model.finalText(undoDelete), '你好世界');
assert.strictEqual(Model.markupText(undoDelete), '你好世界');

const undoReplace = Model.createDocument('旧词在这里');
Model.replaceSelection(undoReplace, caret(undoReplace, 0, 0), caret(undoReplace, 0, 2), '新词');
assert.strictEqual(Model.finalText(undoReplace), '新词在这里');
assert.strictEqual(Model.undoPatch(undoReplace, undoReplace.patches[0].id), true);
assert.strictEqual(Model.finalText(undoReplace), '旧词在这里');
assert.strictEqual(kinds(undoReplace), 'base:旧词在这里');

const undoMove = Model.createDocument('ABCDEFG');
const undoMoveResult = Model.moveSelection(undoMove, caret(undoMove, 0, 2), caret(undoMove, 0, 4), caret(undoMove, 0, 6));
assert.strictEqual(undoMoveResult.ok, true);
assert.strictEqual(Model.finalText(undoMove), 'ABEFCDG');
assert.strictEqual(Model.undoPatch(undoMove, undoMove.patches[0].id), true);
assert.strictEqual(Model.finalText(undoMove), 'ABCDEFG');
assert.strictEqual(kinds(undoMove), 'base:ABCDEFG');

assert.strictEqual(Model.undoPatch(undoMove, 'missing'), false);
const commentOnly = Model.createDocument('只批注');
Model.addComment(commentOnly, caret(commentOnly, 0, 0), endCaret(commentOnly), '留着');
assert.strictEqual(Model.undoPatch(commentOnly, commentOnly.patches[0].id), false);
assert.strictEqual(commentOnly.patches.length, 1);

console.log('copy-edit model smoke ok');
