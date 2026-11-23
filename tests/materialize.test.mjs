import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decryptValue, historyForNote, makeOp, materialize, wins } from '../web/core.mjs';

async function reference(ops, key) {
  const notes = new Map();
  let maxClock = 0;
  for (const op of ops) {
    maxClock = Math.max(maxClock, op.clock);
    let note = notes.get(op.noteId);
    if (!note) {
      note = { id: op.noteId, title: '', body: '', folder: '', pinned: false, deleted: false, purged: false, kind: 'note', reminderAt: 0, reminderRule: 'none', reminderLunar: false, background: 'paper', updatedAt: 0, stamps: {} };
      notes.set(op.noteId, note);
    }
    if (wins(op, note.stamps[op.field])) {
      note[op.field] = await decryptValue(key, op.ciphertext);
      note.stamps[op.field] = { clock: op.clock, actor: op.actor };
    }
  }
  for (const note of notes.values()) if (note.purged) { note.title = ''; note.body = ''; }
  return { notes, maxClock };
}

test('current state matches sequential replay with unordered edits and ties', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const specs = [
    ['a', 'title', 1, 'a', 'old'], ['a', 'body', 5, 'a', 'body'],
    ['a', 'title', 4, 'a', 'new'], ['b', 'title', 1, 'a', 'removed'],
    ['a', 'title', 4, 'b', 'tie winner'], ['a', 'title', 4, 'b', 'duplicate stamp'],
    ['a', 'folder', 2, 'a', 'work'], ['b', 'purged', 3, 'b', true],
    ['a', 'body', 2, 'b', 'older body'], ['a', 'updatedAt', 6, 'a', 1234],
  ];
  const ops = await Promise.all(specs.map(([id, field, clock, actor, value]) => makeOp(key, actor, clock, id, field, value)));
  for (const order of [ops, [...ops].reverse(), [ops[4], ops[1], ops[7], ops[0], ops[5], ops[2], ops[9], ops[3], ops[8], ops[6]]]) {
    assert.deepEqual(await materialize(order, key), await reference(order, key));
  }
  const history = await historyForNote(ops, key, 'a');
  assert.ok(history.some(version => version.title === 'old'));
  assert.ok(history.some(version => version.title === 'tie winner'));
  const wrongKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await assert.rejects(() => materialize(ops, wrongKey), { name: 'OperationError' });
});
