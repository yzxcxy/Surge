import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesToUrl, deriveKey, historyForNote, makeOp, materialize, reencryptOps } from '../web/core.mjs';

test('local vault can move to a server salt without losing encrypted history', async () => {
  const localSalt = bytesToUrl(crypto.getRandomValues(new Uint8Array(16)));
  const serverSalt = bytesToUrl(crypto.getRandomValues(new Uint8Array(16)));
  const localKey = await deriveKey('test passphrase', localSalt);
  const serverKey = await deriveKey('test passphrase', serverSalt);
  const actor = crypto.randomUUID();
  const noteId = crypto.randomUUID();
  const old = [
    await makeOp(localKey, actor, 1, noteId, 'title', '初稿'),
    await makeOp(localKey, actor, 2, noteId, 'body', '第一版'),
    await makeOp(localKey, actor, 3, noteId, 'updatedAt', 1000),
    await makeOp(localKey, actor, 4, noteId, 'body', '第二版'),
    await makeOp(localKey, actor, 5, noteId, 'updatedAt', 2000),
  ];
  const migrated = await reencryptOps(old, localKey, serverKey);
  assert.equal(migrated.every(op => op.localPending), true);
  assert.deepEqual(migrated.map(op => op.id), old.map(op => op.id));
  assert.notEqual(migrated[1].ciphertext, old[1].ciphertext);
  assert.equal((await materialize(migrated, serverKey)).notes.get(noteId).body, '第二版');
  await assert.rejects(() => materialize(migrated, localKey), { name: 'OperationError' });
  const history = await historyForNote(migrated, serverKey, noteId);
  assert.equal(history[0].body, '第二版');
  assert.equal(history[0].timestamp, 2000);
  assert.equal(history[1].body, '第一版');
  assert.equal(history[1].timestamp, 1000);
});
