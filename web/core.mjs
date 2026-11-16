const enc = new TextEncoder();
const dec = new TextDecoder();
export const fields = ['title', 'body', 'folder', 'pinned', 'deleted', 'purged', 'kind', 'reminderAt', 'reminderRule', 'reminderLunar', 'background', 'updatedAt'];
export const bytesToUrl = bytes => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const urlToBytes = text => {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};
export async function deriveKey(passphrase, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: urlToBytes(salt), iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function encryptValue(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value))));
  const all = new Uint8Array(iv.length + encrypted.length);
  all.set(iv); all.set(encrypted, iv.length);
  return bytesToUrl(all);
}
export async function decryptValue(key, ciphertext) {
  const all = urlToBytes(ciphertext);
  return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, key, all.slice(12))));
}
export async function makeOp(key, actor, clock, noteId, field, value) {
  if (!fields.includes(field)) throw new Error('unknown field');
  return { id: crypto.randomUUID(), noteId, field, clock, actor, ciphertext: await encryptValue(key, value) };
}
export async function reencryptOps(ops, oldKey, newKey) {
  const result = [];
  for (const op of ops) result.push({ ...op, ciphertext: await encryptValue(newKey, await decryptValue(oldKey, op.ciphertext)), localPending: true });
  return result;
}
export async function historyForNote(ops, key, noteId) {
  const ordered = ops.filter(op => op.noteId === noteId).sort((a, b) => a.clock - b.clock || a.actor.localeCompare(b.actor) || a.id.localeCompare(b.id));
  let title = '', body = '', timestamp = 0;
  const versions = [];
  for (const op of ordered) {
    if (op.field === 'updatedAt') {
      timestamp = await decryptValue(key, op.ciphertext);
      if (versions.length) versions[versions.length - 1].timestamp = timestamp;
      continue;
    }
    if (op.field !== 'title' && op.field !== 'body') continue;
    const value = await decryptValue(key, op.ciphertext);
    if (op.field === 'title' ? value === title : value === body) continue;
    if (op.field === 'title') title = value; else body = value;
    versions.push({ title, body, timestamp, opId: op.id });
  }
  return versions.reverse();
}
export function wins(next, prior) {
  return !prior || next.clock > prior.clock || (next.clock === prior.clock && next.actor > prior.actor);
}
export async function materialize(ops, key) {
  const notes = new Map();
  let maxClock = 0;
  for (const op of ops) {
    maxClock = Math.max(maxClock, op.clock);
    let note = notes.get(op.noteId);
    if (!note) { note = { id: op.noteId, title: '', body: '', folder: '', pinned: false, deleted: false, purged: false, kind: 'note', reminderAt: 0, reminderRule: 'none', reminderLunar: false, background: 'paper', updatedAt: 0, stamps: {} }; notes.set(op.noteId, note); }
    if (wins(op, note.stamps[op.field])) {
      note[op.field] = await decryptValue(key, op.ciphertext);
      note.stamps[op.field] = { clock: op.clock, actor: op.actor };
    }
  }
  for (const note of notes.values()) if (note.purged) { note.title = ''; note.body = ''; }
  return { notes, maxClock };
}
export async function fetchInfo(server) {
  const response = await fetch(server.replace(/\/$/, '') + '/api/info');
  if (!response.ok) throw new Error('Cannot reach server');
  const info = await response.json();
  if (info.protocol !== 1 || !info.salt) throw new Error('Incompatible server');
  return info;
}
export async function exchange(server, token, cursor, pending) {
  const base = server.replace(/\/$/, '');
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  for (let i = 0; i < pending.length; i += 100) {
    const response = await fetch(base + '/api/ops', { method: 'POST', headers, body: JSON.stringify({ ops: pending.slice(i, i + 100) }) });
    if (!response.ok) throw new Error('Upload failed: ' + response.status);
  }
  const received = [];
  let next = cursor, more;
  do {
    const response = await fetch(base + '/api/ops?after=' + next, { headers });
    if (!response.ok) throw new Error('Download failed: ' + response.status);
    const page = await response.json();
    received.push(...page.ops);
    next = page.cursor; more = page.hasMore;
  } while (more);
  return { ops: received, cursor: next };
}
export async function uploadBlob(server, token, blob) {
  const response = await fetch(server.replace(/\/$/, '') + '/api/blobs/' + blob.id, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ciphertext: blob.ciphertext }) });
  if (!response.ok) throw new Error('Attachment upload failed: ' + response.status);
}
export async function downloadBlob(server, token, id) {
  const response = await fetch(server.replace(/\/$/, '') + '/api/blobs/' + id, { headers: { Authorization: 'Bearer ' + token } });
  if (!response.ok) throw new Error('Attachment download failed: ' + response.status);
  return (await response.json()).ciphertext;
}
