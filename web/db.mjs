const DB = 'surge-v1';
export function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('ops')) db.createObjectStore('ops', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function requestResult(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
export async function allOps(db) { return requestResult(db.transaction('ops').objectStore('ops').getAll()); }
export async function getMeta(db, key) { return requestResult(db.transaction('meta').objectStore('meta').get(key)); }
export async function putMeta(db, key, value) {
  return new Promise((resolve, reject) => { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put(value, key); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
}
export async function putOps(db, ops) {
  return new Promise((resolve, reject) => { const tx = db.transaction('ops', 'readwrite'); for (const op of ops) tx.objectStore('ops').put(op); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
}
export async function pruneNote(db, noteId, blobIds = []) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['ops', 'blobs'], 'readwrite');
    const cursor = tx.objectStore('ops').openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return;
      if (row.value.noteId === noteId && row.value.field !== 'purged') row.delete();
      row.continue();
    };
    for (const id of blobIds) tx.objectStore('blobs').delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
export async function getBlob(db, id) { return requestResult(db.transaction('blobs').objectStore('blobs').get(id)); }
export async function allBlobs(db) { return requestResult(db.transaction('blobs').objectStore('blobs').getAll()); }
export async function putBlobs(db, blobs) {
  return new Promise((resolve, reject) => { const tx = db.transaction('blobs', 'readwrite'); for (const blob of blobs) tx.objectStore('blobs').put(blob); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
}
export async function replaceVault(db, ops, metas, blobs = null) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(blobs ? ['ops', 'meta', 'blobs'] : ['ops', 'meta'], 'readwrite');
    const store = tx.objectStore('ops');
    store.clear();
    for (const op of ops) store.put(op);
    if (blobs) {
      const blobStore = tx.objectStore('blobs');
      blobStore.clear();
      for (const blob of blobs) blobStore.put(blob);
    }
    for (const [name, value] of Object.entries(metas)) tx.objectStore('meta').put(value, name);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
