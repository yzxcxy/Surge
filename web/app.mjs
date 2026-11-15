import { bytesToUrl, decryptValue, deriveKey, downloadBlob, encryptValue, exchange, fetchInfo, historyForNote, makeOp, materialize, reencryptOps, uploadBlob, urlToBytes } from './core.mjs';
import { allBlobs, allOps, getBlob, getMeta, openDb, putBlobs, putMeta, putOps, replaceVault } from './db.mjs';
import { attachmentNode, formulaNode, tableNode, renderInlineMarkdown, renderMarkdown, serializeMarkdown } from './rich-editor.mjs';
import { APP_VERSION, DEFAULT_REPOSITORY, compareVersions, latestRelease, parseRepository } from './updates.mjs';

const $ = id => document.getElementById(id);
if (window.Capacitor?.isNativePlatform?.()) document.documentElement.classList.add('native-app');

let db, key, server = null, token = null, actor, clock = 0, cursor = 0;
let notes = new Map(), current = null, draftId = null, view = 'all', tab = 'notes', query = '';
let syncing = false, syncTimer, writeQueue = Promise.resolve();
let folderCatalog = [], folderDialogMode = 'create', renameFrom = '', folderAssignId = null;
let attachmentUrls = [];
let bodyRange = null, editingFormula = null;
let nativeVisibleHeight = Infinity;
let layout = localStorage.getItem('surge-layout') === 'grid' ? 'grid' : 'list';
const vaultMarker = 'surge-vault-v1';
const folderRecordBody = 'surge-internal-category-record-v1';
const isFolderRecord = note => note.body === folderRecordBody;
const syncConfigured = () => {
  const choice = localStorage.getItem('surge-sync-enabled');
  return choice === '1' || (choice === null && Boolean(localStorage.getItem('surge-server') && localStorage.getItem('surge-token')));
};
const cleanOp = op => ({ id: op.id, noteId: op.noteId, field: op.field, clock: op.clock, actor: op.actor, ciphertext: op.ciphertext });
const editableBody = value => value.replace(/\n?!?\[[^\]]*\]\(surge-blob:[a-f0-9-]{36}\)/g, '');
const previewBody = value => editableBody(value)
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/^\s*[-*]\s+\[([ xX])\]\s*/gm, (_, checked) => checked.toLowerCase() === 'x' ? '☑ ' : '☐ ')
  .replace(/^\s*[-*]\s+/gm, '• ')
  .replace(/\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g, (_, strong, emphasis, code) => strong || emphasis || code)
  .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')
  .trim();
const gridIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
const listIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16M4 12h16M4 19h16"/></svg>';

function status(message, kind = '') {
  $('sync-label').textContent = message;
  $('sync-dot').className = kind;
}
function setGlass(enabled) {
  document.body.classList.toggle('glass', enabled);
  $('glass-toggle').checked = enabled;
  localStorage.setItem('surge-glass', enabled ? '1' : '0');
}
function showLegacy(error = '') {
  $('app').hidden = true;
  $('setup').hidden = false;
  $('editor').hidden = true;
  $('history').hidden = true;
  $('setup-error').textContent = error;
}
function showSettings() {
  if (!$('settings-panel').hidden) return;
  closeMobileNav();
  $('server').value = localStorage.getItem('surge-server') || '';
  $('token').value = localStorage.getItem('surge-token') || '';
  $('sync-passphrase').value = '';
  $('settings-error').textContent = '';
  $('settings-sync-state').textContent = server ? '已开启' : '未开启';
  $('disable-sync').hidden = !server;
  $('sync-details').open = false;
  $('current-version').textContent = APP_VERSION;
  $('update-repo').value = localStorage.getItem('surge-update-repo') || DEFAULT_REPOSITORY;
  $('settings-panel').hidden = false;
  history.pushState({ surgeSettings: true }, '', location.href);
}
function closeSettings() {
  if ($('settings-panel').hidden) return;
  $('settings-panel').hidden = true;
  if (history.state?.surgeSettings) history.back();
}
function niceDate(ms) {
  return ms ? new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(ms) : '刚刚';
}
function editDate(ms, length) {
  return `${ms ? new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms) : '刚刚'}　|　${length} 字`;
}
function viewName() {
  return view === 'all' ? '笔记' : view === 'pinned' ? '置顶' : view === 'trash' ? '回收站' : view;
}
function activeNotes() {
  return [...notes.values()]
    .filter(n => n.id !== draftId)
    .filter(n => !isFolderRecord(n))
    .filter(n => view === 'trash' ? n.deleted : !n.deleted && (view === 'all' || (view === 'pinned' ? n.pinned : n.folder === view)))
    .filter(n => (n.title + '\n' + n.body).toLowerCase().includes(query))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}
function tasksFrom(list) {
  return list.flatMap(note => note.body.split('\n').flatMap((line, index) => {
    const match = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
    return match ? [{ note, index, text: match[2], done: match[1].toLowerCase() === 'x' }] : [];
  }));
}
function allFolders() {
  return [...new Set([
    ...folderCatalog,
    ...[...notes.values()].filter(note => !note.deleted && isFolderRecord(note) && note.title).map(note => note.title),
    ...[...notes.values()].filter(note => !note.deleted && !isFolderRecord(note) && note.folder).map(note => note.folder)
  ])].sort();
}
function updateFolderSelect(folders) {
  const select = $('note-folder');
  const value = current ? notes.get(current)?.folder || '' : '';
  select.replaceChildren(...['', ...folders, '__new__'].map(folder => {
    const option = document.createElement('option');
    option.value = folder;
    option.textContent = folder === '__new__' ? '新建分类…' : folder || '未分类';
    return option;
  }));
  select.value = value;
  const mobile = $('mobile-folder');
  mobile.replaceChildren(...['', ...folders, '__new__'].map(folder => {
    const option = document.createElement('option');
    option.value = folder;
    option.textContent = folder === '__new__' ? '新建文件夹…' : folder || '文件夹';
    return option;
  }));
  mobile.value = folders.includes(view) ? view : '';
  mobile.classList.toggle('active', folders.includes(view));
}
function render() {
  const folders = allFolders();
  $('folders').replaceChildren(...folders.map(folder => {
    const button = document.createElement('button');
    button.className = 'folder-item' + (view === folder ? ' active' : '');
    button.textContent = '▱  ' + folder;
    button.onclick = () => setView(folder);
    return button;
  }));
  document.querySelectorAll('.nav').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  document.querySelectorAll('[data-mobile-view]').forEach(button => button.classList.toggle('active', button.dataset.mobileView === view));
  $('category-strip').replaceChildren(...[['all', '全部'], ...folders.map(folder => [folder, folder])].map(([value, label]) => {
    const button = document.createElement('button');
    button.textContent = label;
    button.classList.toggle('active', view === value);
    button.onclick = () => setView(value);
    return button;
  }));
  document.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  const name = tab === 'todos' ? '待办' : viewName();
  $('view-title').textContent = name;
  $('breadcrumbs').textContent = name;
  $('trash-back').hidden = view !== 'trash';
  $('category-strip').parentElement.hidden = view === 'trash';
  $('new-note').hidden = view === 'trash';
  $('fab').hidden = view === 'trash';
  $('tabbar').hidden = view === 'trash';
  $('notes').hidden = tab !== 'notes';
  $('todos').hidden = tab !== 'todos';
  $('fab').setAttribute('aria-label', tab === 'todos' ? '新建待办' : '新建笔记');
  const list = activeNotes();
  const tasks = tasksFrom(list);
  $('count').textContent = (tab === 'todos' ? tasks.length : list.length) + (tab === 'todos' ? ' 项待办' : ' 条笔记');
  $('empty').hidden = (tab === 'todos' ? tasks.length : list.length) > 0;
  $('empty').textContent = tab === 'todos' ? '还没有待办' : '还没有笔记';
  $('notes').classList.toggle('list', layout === 'list');
  $('layout-toggle').innerHTML = layout === 'list' ? gridIcon : listIcon;
  $('layout-toggle').title = layout === 'list' ? '切换为宫格' : '切换为列表';
  $('layout-toggle').setAttribute('aria-label', $('layout-toggle').title);
  $('layout-toggle').setAttribute('aria-pressed', String(layout === 'grid'));
  $('layout-toggle').hidden = tab === 'todos';
  $('sync-now').hidden = !server;
  $('notes').replaceChildren(...list.map(note => {
    const button = document.createElement('button');
    button.className = 'note-card';
    const title = document.createElement('h3');
    title.textContent = note.title || '未命名笔记';
    const preview = document.createElement('p');
    preview.textContent = previewBody(note.body) || (note.body.includes('surge-blob:') ? '附件' : '空白笔记');
    const footer = document.createElement('footer');
    const date = document.createElement('span');
    date.textContent = niceDate(note.updatedAt);
    const tag = document.createElement('span');
    tag.className = note.pinned ? 'pin' : '';
    if (note.pinned) { tag.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 3 8 0-1 6 3 3v2H6v-2l3-3-1-6Zm4 11v7"/></svg>'; tag.setAttribute('aria-label', '置顶'); }
    else tag.textContent = note.folder;
    footer.append(date, tag);
    button.append(title, preview, footer);
    button.onclick = () => openEditor(note.id);
    return button;
  }));
  $('todos').replaceChildren(...tasks.map(task => {
    const row = document.createElement('div');
    row.className = 'todo-item';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = task.done;
    check.setAttribute('aria-label', task.text || '待办');
    check.onchange = () => {
      const lines = task.note.body.split('\n');
      lines[task.index] = lines[task.index].replace(/^(\s*-\s*)\[[ xX]\]/, `$1[${check.checked ? 'x' : ' '}]`);
      changeNote(task.note.id, 'body', lines.join('\n'));
    };
    const button = document.createElement('button');
    const title = document.createElement('span');
    title.textContent = task.text || '未命名待办';
    const source = document.createElement('small');
    source.textContent = task.note.title === task.text ? niceDate(task.note.updatedAt) : task.note.title || niceDate(task.note.updatedAt);
    button.append(title, source);
    button.onclick = () => openEditor(task.note.id);
    row.append(check, button);
    return row;
  }));
  updateFolderSelect(folders);
}
function closeMobileNav() {
  $('mobile-nav').hidden = true;
  $('mobile-folders').setAttribute('aria-expanded', 'false');
}
async function persistFolders() {
  await putMeta(db, 'folders', await encryptValue(key, folderCatalog));
}
async function createFolderRecord(name) {
  const id = crypto.randomUUID();
  await save(id, 'body', folderRecordBody);
  await save(id, 'title', name);
  await save(id, 'updatedAt', Date.now());
}
function openFolderDialog(mode = 'create', oldName = '', assignId = null) {
  folderDialogMode = mode;
  renameFrom = oldName;
  folderAssignId = assignId;
  $('folder-dialog-title').textContent = mode === 'rename' ? '重命名分类' : '新建分类';
  $('folder-name').value = mode === 'rename' ? oldName : '';
  $('folder-error').textContent = '';
  $('folder-manage-list').replaceChildren(...allFolders().map(folder => {
    const row = document.createElement('div');
    row.className = 'folder-manage-row';
    const name = document.createElement('span');
    name.textContent = folder;
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = '重命名';
    edit.onclick = () => openFolderDialog('rename', folder);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'delete';
    remove.textContent = '删除';
    remove.onclick = () => deleteFolder(folder);
    row.append(name, edit, remove);
    return row;
  }));
  if (!$('folder-dialog').open) $('folder-dialog').showModal();
  $('folder-name').focus();
}
async function saveFolder(event) {
  event.preventDefault();
  if (!$('folder-dialog').open) return;
  const name = $('folder-name').value.trim();
  if (!name) { $('folder-error').textContent = '输入分类名称'; return; }
  if (['all', 'pinned', 'trash', '__new__'].includes(name)) { $('folder-error').textContent = '请换一个分类名称'; return; }
  if (allFolders().includes(name) && name !== renameFrom) { $('folder-error').textContent = '分类已存在'; return; }
  if (folderDialogMode === 'rename') {
    folderCatalog = folderCatalog.filter(folder => folder !== renameFrom);
    const records = [...notes.values()].filter(note => !note.deleted && isFolderRecord(note) && note.title === renameFrom);
    if (records.length) {
      for (const record of records) await changeNote(record.id, 'title', name);
    } else await createFolderRecord(name);
    if (view === renameFrom) view = name;
    await persistFolders();
    for (const note of [...notes.values()].filter(note => !isFolderRecord(note) && note.folder === renameFrom)) await changeNote(note.id, 'folder', name);
    render();
  } else {
    await createFolderRecord(name);
    if (folderAssignId) await changeNote(folderAssignId, 'folder', name); else setView(name);
  }
  $('folder-dialog').close();
}
async function deleteFolder(folder) {
  if (!confirm(`删除“${folder}”分类？其中的笔记会移到未分类。`)) return;
  folderCatalog = folderCatalog.filter(name => name !== folder);
  await persistFolders();
  for (const record of [...notes.values()].filter(note => !note.deleted && isFolderRecord(note) && note.title === folder)) await changeNote(record.id, 'deleted', true);
  for (const note of [...notes.values()].filter(note => !isFolderRecord(note) && note.folder === folder)) await changeNote(note.id, 'folder', '');
  if (view === folder) view = 'all';
  $('folder-dialog').close();
  render();
}
function setView(next) {
  discardDraft();
  view = next;
  if (next === 'trash') tab = 'notes';
  current = null;
  $('editor').hidden = true;
  closeMobileNav();
  render();
}
function setTab(next) {
  discardDraft();
  tab = next;
  current = null;
  $('editor').hidden = true;
  render();
}
function save(id, field, value) {
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    if (!key) return;
    const op = await makeOp(key, actor, ++clock, id, field, value);
    await putOps(db, [{ ...op, localPending: true }]);
    const note = notes.get(id) || { id, title: '', body: '', folder: '', pinned: false, deleted: false, updatedAt: 0 };
    note[field] = value;
    notes.set(id, note);
    $('save-state').textContent = '已保存在本机';
    render();
    scheduleSync();
  });
  return writeQueue;
}
function scheduleSync() {
  if (!server) { status('仅本机'); return; }
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 1200);
}
async function changeNote(id, field, value) {
  if (draftId === id) {
    if (field !== 'title' && field !== 'body') {
      notes.get(id)[field] = value;
      render();
      return;
    }
    if (!String(value).trim()) return;
    draftId = null;
    const folder = notes.get(id)?.folder;
    if (folder && field !== 'folder') await save(id, 'folder', folder);
    const pinned = notes.get(id)?.pinned;
    if (pinned) await save(id, 'pinned', true);
  }
  await save(id, field, value);
  if (field !== 'updatedAt') await save(id, 'updatedAt', Date.now());
  if (current === id) {
    const note = notes.get(id);
    $('edit-date').textContent = editDate(note.updatedAt, $('note-body').textContent.length);
  }
}
function discardDraft() {
  if (draftId) notes.delete(draftId);
  draftId = null;
}
function createNote() {
  const id = crypto.randomUUID();
  discardDraft();
  draftId = id;
  notes.set(id, { id, title: '', body: '', folder: ['all', 'pinned', 'trash'].includes(view) ? '' : view, pinned: false, deleted: false, updatedAt: Date.now() });
  openEditor(id);
  $('note-title').focus();
}
async function createTodo() {
  const text = prompt('待办内容')?.trim();
  if (!text) return;
  const id = crypto.randomUUID();
  await save(id, 'title', text);
  await save(id, 'body', '- [ ] ' + text);
  await save(id, 'updatedAt', Date.now());
}
function createForTab() { return tab === 'todos' ? createTodo() : createNote(); }
function openEditor(id) {
  current = id;
  const note = notes.get(id);
  if (!note) return;
  closeMobileNav();
  $('editor').hidden = false;
  $('note-title').value = note.title;
  clearAttachmentUrls();
  renderMarkdown(note.body, $('note-body'));
  bodyRange = null;
  $('edit-date').textContent = editDate(note.updatedAt, $('note-body').textContent.length);
  $('pin-note').textContent = note.pinned ? '取消置顶' : '置顶';
  $('delete-note').hidden = note.deleted;
  $('restore-note').hidden = !note.deleted;
  $('more-menu').hidden = true;
  updateFolderSelect(allFolders());
  renderAttachments(id);
  updateEditorViewport();
}
function updateEditorViewport() {
  const viewport = window.visualViewport;
  $('editor').style.height = Math.min(viewport?.height || window.innerHeight, nativeVisibleHeight) + 'px';
  $('editor').style.top = (viewport?.offsetTop || 0) + 'px';
}
window.surgeSetVisibleHeight = height => {
  nativeVisibleHeight = Number.isFinite(height) && height > 0 ? height : Infinity;
  updateEditorViewport();
};
async function sync() {
  if (syncing || !server || !token || !key) return;
  syncing = true;
  status('正在同步…');
  try {
    await writeQueue;
    const pendingBlobs = (await allBlobs(db)).filter(blob => blob.localPending);
    for (const blob of pendingBlobs) {
      await uploadBlob(server, token, blob);
      await putBlobs(db, [{ ...blob, localPending: false }]);
    }
    const all = await allOps(db);
    const pending = all.filter(op => op.localPending);
    const result = await exchange(server, token, cursor, pending.map(cleanOp));
    await writeQueue;
    const latest = await allOps(db);
    const known = new Set(latest.map(op => op.id));
    const fresh = result.ops.filter(op => !known.has(op.id));
    const nextState = fresh.length ? await materialize([...latest, ...fresh], key) : null;
    if (pending.length) await putOps(db, pending.map(op => ({ ...op, localPending: false })));
    if (fresh.length) await putOps(db, fresh);
    cursor = result.cursor;
    await putMeta(db, 'cursor', cursor);
    if (nextState) {
      notes = nextState.notes;
      clock = Math.max(clock, nextState.maxClock);
      render();
      if (current && !$('editor').contains(document.activeElement)) openEditor(current);
    }
    status('已同步', 'online');
  } catch (error) {
    if (error.name === 'OperationError') {
      server = null;
      token = null;
      localStorage.setItem('surge-sync-enabled', '0');
      status('同步密钥不匹配', 'error');
    } else {
      status(navigator.onLine ? '同步失败' : '离线可用', navigator.onLine ? 'error' : '');
    }
    console.warn(error);
  } finally { syncing = false; }
}
async function activateVault(candidateKey, ops) {
  const state = await materialize(ops, candidateKey);
  key = candidateKey;
  notes = state.notes;
  const folders = await getMeta(db, 'folders');
  folderCatalog = folders ? await decryptValue(key, folders) : [];
  clock = Math.max(state.maxClock, (await getMeta(db, 'clock')) || 0);
  actor = await getMeta(db, 'actor');
  if (!actor) { actor = crypto.randomUUID(); await putMeta(db, 'actor', actor); }
  cursor = (await getMeta(db, 'cursor')) || 0;
  if (folderCatalog.length) {
    const previous = folderCatalog;
    folderCatalog = [];
    await persistFolders();
    for (const name of previous) {
      if (![...notes.values()].some(note => !note.deleted && isFolderRecord(note) && note.title === name)) await createFolderRecord(name);
    }
  }
  server = syncConfigured() ? localStorage.getItem('surge-server') : null;
  token = syncConfigured() ? localStorage.getItem('surge-token') : null;
  $('setup').hidden = true;
  $('app').hidden = false;
  render();
  if (server && token) sync(); else status('仅本机');
}
async function bootstrap() {
  db = await openDb();
  setGlass(localStorage.getItem('surge-glass-default-v2') === '1' ? localStorage.getItem('surge-glass') !== '0' : true);
  localStorage.setItem('surge-glass-default-v2', '1');
  const ops = await allOps(db);
  let storedKey = await getMeta(db, 'deviceKey');
  if (!storedKey) {
    if (ops.length || ((await getMeta(db, 'salt')) && syncConfigured())) { showLegacy(); return; }
    storedKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await putMeta(db, 'deviceKey', storedKey);
  }
  await activateVault(storedKey, ops);
}
async function migrateLegacy() {
  $('setup-error').textContent = '';
  try {
    const passphrase = $('passphrase').value;
    if (!passphrase) throw new Error('请输入旧口令');
    const salt = await getMeta(db, 'salt');
    if (!salt) throw new Error('旧笔记缺少解密盐值');
    const candidateKey = await deriveKey(passphrase, salt);
    const check = await getMeta(db, 'check');
    if (check && await decryptValue(candidateKey, check) !== vaultMarker) throw new Error('旧口令错误');
    const ops = await allOps(db);
    await materialize(ops, candidateKey);
    await putMeta(db, 'deviceKey', candidateKey);
    $('passphrase').value = '';
    await activateVault(candidateKey, ops);
  } catch (error) {
    $('setup-error').textContent = error.name === 'OperationError' ? '旧口令错误' : error.message;
  }
}
async function connectSync() {
  $('settings-error').textContent = '';
  try {
    if (syncing) throw new Error('请等待当前同步完成');
    const candidateServer = $('server').value.trim().replace(/\/$/, '');
    const candidateToken = $('token').value.trim();
    const passphrase = $('sync-passphrase').value;
    if (!candidateServer || candidateToken.length < 24 || !passphrase) throw new Error('请填写服务器、令牌和同步口令');
    await writeQueue;
    const info = await fetchInfo(candidateServer);
    const remoteKey = await deriveKey(passphrase, info.salt);
    const remote = await exchange(candidateServer, candidateToken, 0, []);
    await materialize(remote.ops, remoteKey);
    const migrated = await reencryptOps(await allOps(db), key, remoteKey);
    const migratedBlobs = [];
    for (const blob of await allBlobs(db)) migratedBlobs.push({ ...blob, ciphertext: await encryptValue(remoteKey, await decryptValue(key, blob.ciphertext)), localPending: true });
    await replaceVault(db, migrated, { deviceKey: remoteKey, salt: info.salt, cursor: 0, folders: await encryptValue(remoteKey, folderCatalog) }, migratedBlobs);
    key = remoteKey;
    cursor = 0;
    server = candidateServer;
    token = candidateToken;
    localStorage.setItem('surge-server', server);
    localStorage.setItem('surge-token', token);
    localStorage.setItem('surge-sync-enabled', '1');
    $('sync-passphrase').value = '';
    $('settings-sync-state').textContent = '已开启';
    $('disable-sync').hidden = false;
    await sync();
  } catch (error) {
    $('settings-error').textContent = error.name === 'OperationError' ? '同步口令不匹配' : error.message;
  }
}
function disableSync() {
  server = null;
  token = null;
  clearTimeout(syncTimer);
  localStorage.setItem('surge-sync-enabled', '0');
  $('settings-sync-state').textContent = '未开启';
  $('disable-sync').hidden = true;
  status('仅本机');
}
function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, 2800);
}
function editorRange() {
  const body = $('note-body');
  const range = bodyRange?.cloneRange();
  if (range && body.contains(range.commonAncestorContainer)) return range;
  const end = document.createRange();
  end.selectNodeContents(body);
  end.collapse(false);
  return end;
}
function focusRange(range = editorRange()) {
  $('note-body').focus();
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}
function saveEditorBody() {
  if (current) return changeNote(current, 'body', serializeMarkdown($('note-body')));
}
function insertText(value) {
  if (!current) return;
  focusRange();
  document.execCommand('insertText', false, value);
  saveEditorBody();
}
function insertBlock(node) {
  if (!current) return;
  const body = $('note-body');
  const range = editorRange();
  let block = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
  while (block && block.parentElement !== body) block = block.parentElement;
  if (block?.tagName === 'P' && !block.textContent.trim()) block.replaceWith(node);
  else if (block) block.after(node);
  else body.append(node);
  const caret = document.createRange();
  const target = node.querySelector('td, li') || node;
  caret.selectNodeContents(target);
  caret.collapse(target !== node);
  focusRange(caret);
  saveEditorBody();
}
function insertTask() {
  const list = document.createElement('ul');
  const item = document.createElement('li');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.contentEditable = 'false';
  item.append(checkbox, document.createTextNode(' '));
  list.append(item);
  insertBlock(list);
}
async function payloadFor(id) {
  let blob = await getBlob(db, id);
  if (!blob && server && token) {
    blob = { id, ciphertext: await downloadBlob(server, token, id), localPending: false };
    await putBlobs(db, [blob]);
  }
  if (!blob) throw new Error('附件暂不可用');
  return decryptValue(key, blob.ciphertext);
}
function clearAttachmentUrls() {
  for (const url of attachmentUrls) URL.revokeObjectURL(url);
  attachmentUrls = [];
}
async function renderAttachments(id) {
  for (const card of $('note-body').querySelectorAll('.rich-attachment[data-blob-id]')) {
    const blobId = card.dataset.blobId;
    if (card.dataset.loaded === 'true') continue;
    try {
      const payload = await payloadFor(blobId);
      if (current !== id || !card.isConnected) return;
      card.replaceChildren();
      card.dataset.loaded = 'true';
      const label = document.createElement('span');
      label.textContent = payload.name || '附件';
      card.append(label);
      if (payload.kind === 'password') {
        const account = document.createElement('small');
        account.textContent = payload.username || '';
        const copy = document.createElement('button');
        copy.textContent = '复制密码';
        copy.onclick = async () => { await navigator.clipboard.writeText(payload.secret); toast('已复制'); };
        card.append(account, copy);
        continue;
      }
      const file = new Blob([urlToBytes(payload.data)], { type: payload.mime || 'application/octet-stream' });
      const url = URL.createObjectURL(file);
      attachmentUrls.push(url);
      if (['image', 'camera', 'drawing', 'mindmap'].includes(payload.kind)) {
        const image = document.createElement('img');
        image.src = url;
        image.alt = payload.name || '';
        card.prepend(image);
        if (payload.kind === 'drawing') {
          const edit = document.createElement('button');
          edit.textContent = '编辑绘图';
          edit.onclick = () => openDrawingEditor(payload, card, id);
          card.append(edit);
        }
      } else if (payload.kind === 'audio') {
        const player = document.createElement('audio');
        player.controls = true;
        player.src = url;
        card.append(player);
      } else {
        const link = document.createElement('a');
        link.href = url;
        link.download = payload.name || '附件';
        link.textContent = '下载';
        card.append(link);
      }
    } catch {
      card.textContent = '附件暂不可用';
    }
  }
}
async function storePayload(payload, noteId = current) {
  if (!noteId) return;
  const id = crypto.randomUUID();
  await putBlobs(db, [{ id, ciphertext: await encryptValue(key, payload), localPending: true }]);
  const name = (payload.name || '附件').replace(/[\]\n]/g, '_');
  const image = ['image', 'camera', 'drawing', 'mindmap'].includes(payload.kind);
  const marker = `${image ? '!' : ''}[${name}](surge-blob:${id})`;
  if (current === noteId) insertBlock(attachmentNode(marker));
  else {
    const stored = notes.get(noteId)?.body || '';
    await changeNote(noteId, 'body', stored + (stored && !stored.endsWith('\n') ? '\n' : '') + marker);
  }
  scheduleSync();
  if (current === noteId) await renderAttachments(noteId);
}
async function storeFile(file, kind) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast('单个文件不超过 5 MB'); return; }
  const noteId = current;
  try {
    await storePayload({ kind, name: file.name || kind, mime: file.type || 'application/octet-stream', data: bytesToUrl(new Uint8Array(await file.arrayBuffer())) }, noteId);
  } catch (error) { toast(error.message || '附件保存失败'); }
}
function outlineToSvg(text) {
  const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lines = text.split('\n').filter(line => line.trim()).slice(0, 40);
  const nodes = lines.map((line, index) => ({ level: Math.min(4, Math.floor((line.match(/^\s*/)[0].replace(/\t/g, '  ').length) / 2)), label: line.trim().slice(0, 24), y: 35 + index * 66 }));
  const width = 760, height = Math.max(180, nodes.length * 66 + 35);
  const edges = nodes.map((node, index) => {
    if (!index || !node.level) return '';
    const parent = nodes.slice(0, index).reverse().find(item => item.level < node.level);
    return parent ? `<path d="M${80 + parent.level * 135} ${parent.y + 15} L${35 + node.level * 135} ${node.y + 15}" stroke="#a8b2bf" stroke-width="2" fill="none"/>` : '';
  }).join('');
  const boxes = nodes.map(node => `<rect x="${25 + node.level * 135}" y="${node.y}" width="115" height="31" rx="12" fill="#eff3f8" stroke="#cfd8e2"/><text x="${36 + node.level * 135}" y="${node.y + 21}" font-family="sans-serif" font-size="13" fill="#25313f">${escape(node.label)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/>${edges}${boxes}</svg>`;
}
async function showHistory() {
  if (!current) return;
  const id = current;
  const versions = await historyForNote(await allOps(db), key, id);
  $('history-list').replaceChildren(...versions.map(version => {
    const article = document.createElement('article');
    const date = document.createElement('small');
    date.textContent = version.timestamp ? editDate(version.timestamp, version.body.length) : '较早版本';
    const title = document.createElement('h3');
    title.textContent = version.title || '未命名笔记';
    const preview = document.createElement('p');
    preview.textContent = previewBody(version.body) || (version.body.includes('surge-blob:') ? '附件' : '空白笔记');
    const restore = document.createElement('button');
    restore.textContent = '恢复此版本';
    restore.onclick = async () => {
      if (notes.get(id)?.title !== version.title) await changeNote(id, 'title', version.title);
      if (notes.get(id)?.body !== version.body) await changeNote(id, 'body', version.body);
      $('history').hidden = true;
      openEditor(id);
    };
    article.append(date, title, preview, restore);
    return article;
  }));
  if (!versions.length) $('history-list').textContent = '还没有历史版本';
  $('more-menu').hidden = true;
  $('history').hidden = false;
}
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('/sw.js').catch(console.warn);
$('connect').onclick = migrateLegacy;
$('enable-sync').onclick = connectSync;
$('disable-sync').onclick = disableSync;
$('passphrase').onkeydown = event => { if (event.key === 'Enter') $('connect').click(); };
$('glass-toggle').onchange = event => setGlass(event.target.checked);
$('settings-back').onclick = closeSettings;
$('open-trash').onclick = () => { closeSettings(); setView('trash'); };
let updateUrl = null;
$('update-repo').onchange = event => {
  try {
    const repo = parseRepository(event.target.value);
    localStorage.setItem('surge-update-repo', repo);
    event.target.value = repo;
    $('update-status').textContent = '';
  } catch (error) { $('update-status').textContent = error.message; }
};
$('check-update').onclick = async () => {
  const statusNode = $('update-status');
  const button = $('check-update');
  updateUrl = null;
  $('open-update').hidden = true;
  button.disabled = true;
  statusNode.textContent = '正在检查…';
  try {
    const repo = parseRepository($('update-repo').value);
    localStorage.setItem('surge-update-repo', repo);
    const release = await latestRelease(repo);
    const comparison = compareVersions(release.version, APP_VERSION);
    if (comparison === null) statusNode.textContent = `最新版本：${release.version}`;
    else statusNode.textContent = comparison > 0 ? `发现新版本 ${release.version}` : `已是最新版本（${APP_VERSION}）`;
    if (comparison === null || comparison > 0) {
      updateUrl = release.apk || release.page;
      $('open-update').textContent = release.apk ? '下载 Android 安装包' : '查看 GitHub 版本';
      $('open-update').hidden = !updateUrl;
    }
  } catch (error) { statusNode.textContent = error.message || '检查失败，请确认网络连接'; }
  finally { button.disabled = false; }
};
$('open-update').onclick = async () => {
  if (!updateUrl) return;
  try {
    if (window.Capacitor?.isNativePlatform?.() && window.Capacitor.Plugins?.Browser) await window.Capacitor.Plugins.Browser.open({ url: updateUrl });
    else window.open(updateUrl, '_blank', 'noopener,noreferrer');
  } catch { $('update-status').textContent = '无法打开下载页'; }
};
window.surgeHandleBack = () => {
  if (!$('settings-panel').hidden) { closeSettings(); return true; }
  if (!$('history').hidden) { $('history').hidden = true; return true; }
  if (!$('editor').hidden) { $('back').click(); return true; }
  if (!$('mobile-nav').hidden) { closeMobileNav(); return true; }
  return false;
};
$('new-note').onclick = createForTab;
$('fab').onclick = createForTab;
$('back').onclick = () => { discardDraft(); $('editor').hidden = true; current = null; render(); };
$('trash-back').onclick = () => setView('all');
$('mobile-folders').onclick = () => { const open = $('mobile-nav').hidden; $('mobile-nav').hidden = !open; $('mobile-folders').setAttribute('aria-expanded', String(open)); };
$('mobile-settings').onclick = showSettings;
$('layout-toggle').onclick = () => { layout = layout === 'list' ? 'grid' : 'list'; localStorage.setItem('surge-layout', layout); render(); };
$('manage-categories').onclick = () => openFolderDialog();
let folderComposing = false, saveAfterComposition = false;
$('folder-name').addEventListener('compositionstart', () => { folderComposing = true; });
$('folder-name').addEventListener('compositionend', () => {
  folderComposing = false;
  if (saveAfterComposition) {
    saveAfterComposition = false;
    queueMicrotask(() => saveFolder(new Event('submit')));
  }
});
$('folder-dialog').querySelector('form').onsubmit = event => {
  if (folderComposing) { event.preventDefault(); saveAfterComposition = true; }
  else saveFolder(event);
};
$('folder-cancel').onclick = () => $('folder-dialog').close();
$('search').onfocus = closeMobileNav;
$('search').oninput = event => { query = event.target.value.toLowerCase().trim(); render(); };
document.querySelectorAll('.nav').forEach(button => button.onclick = () => setView(button.dataset.view));
document.querySelectorAll('[data-mobile-view]').forEach(button => button.onclick = () => setView(button.dataset.mobileView));
document.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => setTab(button.dataset.tab));
$('mobile-folder').onchange = event => {
  if (event.target.value === '__new__') {
    openFolderDialog();
    render();
  } else setView(event.target.value || 'all');
};
$('add-folder').onclick = () => openFolderDialog();
let composingTitle = false, composingBody = false;
function applyMarkdownShortcut() {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return false;
  const anchor = selection.anchorNode;
  if (!anchor || (anchor.nodeType === Node.TEXT_NODE && selection.anchorOffset < anchor.textContent.length)) return false;
  const element = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
  const block = element?.closest('p, li');
  const body = $('note-body');
  if (!block || !body.contains(block)) return false;
  const value = (block.textContent || '').replace(/\u00a0/g, ' ');
  const placeCaret = target => {
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    focusRange(range);
  };
  if (block.tagName === 'LI' && /^\s*\[([ xX])\] $/.test(value) && !block.querySelector('input')) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.contentEditable = 'false';
    checkbox.checked = /^\s*\[[xX]\]/.test(value);
    block.replaceChildren(checkbox, document.createTextNode(' '));
    placeCaret(block);
    return true;
  }
  if (block.tagName !== 'P' || block.parentElement !== body || block.childNodes.length !== 1) return false;
  const task = /^[-*] \[([ xX])\] $/.exec(value);
  const list = /^([-*]|\d+\.) $/.exec(value);
  if (task || list) {
    const ordered = Boolean(list && /\d/.test(list[1]));
    const wrapper = document.createElement(ordered ? 'ol' : 'ul');
    if (ordered) wrapper.start = Number(list[1].slice(0, -1));
    const item = document.createElement('li');
    if (task) {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.contentEditable = 'false';
      checkbox.checked = task[1].toLowerCase() === 'x';
      item.append(checkbox, document.createTextNode(' '));
    }
    wrapper.append(item);
    block.replaceWith(wrapper);
    placeCaret(item);
    return true;
  }
  const heading = /^(#{1,6}) $/.exec(value);
  if (heading || value === '> ') {
    const replacement = document.createElement(heading ? `h${heading[1].length}` : 'blockquote');
    block.replaceWith(replacement);
    placeCaret(replacement);
    return true;
  }
  if (/(?:\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)]+\))$/.test(value)) {
    renderInlineMarkdown(value, block);
    placeCaret(block);
    return true;
  }
  return false;
}
$('note-title').addEventListener('compositionstart', () => { composingTitle = true; });
$('note-title').addEventListener('compositionend', event => { composingTitle = false; if (current) changeNote(current, 'title', event.target.value); });
$('note-body').addEventListener('compositionstart', () => { composingBody = true; });
$('note-body').addEventListener('compositionend', () => { composingBody = false; applyMarkdownShortcut(); saveEditorBody(); });
document.addEventListener('selectionchange', () => {
  const selection = window.getSelection();
  if (selection.rangeCount && $('note-body').contains(selection.anchorNode)) bodyRange = selection.getRangeAt(0).cloneRange();
});
$('note-body').addEventListener('change', event => { if (event.target.matches('input[type="checkbox"]')) saveEditorBody(); });
$('note-title').oninput = event => { if (current && !composingTitle) changeNote(current, 'title', event.target.value); };
$('note-body').oninput = () => { if (current && !composingBody) { applyMarkdownShortcut(); saveEditorBody(); } };
$('note-body').ondblclick = event => {
  editingFormula = event.target.closest('.rich-formula');
  if (editingFormula) { $('formula-source').value = editingFormula.dataset.formula || ''; $('formula-dialog').showModal(); }
};
$('note-folder').onchange = event => {
  if (!current) return;
  if (event.target.value === '__new__') { const id = current; render(); openFolderDialog('create', '', id); }
  else changeNote(current, 'folder', event.target.value);
};
$('pin-note').onclick = async () => { const id = current; await changeNote(id, 'pinned', !notes.get(id).pinned); openEditor(id); };
$('delete-note').onclick = async () => { const id = current; await changeNote(id, 'deleted', true); $('editor').hidden = true; current = null; };
$('restore-note').onclick = async () => { const id = current; await changeNote(id, 'deleted', false); $('more-menu').hidden = true; openEditor(id); };
$('history-note').onclick = showHistory;
$('history-close').onclick = () => { $('history').hidden = true; };
$('more').onclick = () => $('more-menu').hidden = !$('more-menu').hidden;
$('sync-now').onclick = sync;
$('settings').onclick = showSettings;
for (const input of ['image', 'camera', 'file', 'audio']) {
  const picker = $('pick-' + input);
  picker.onchange = async () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (file) await storeFile(file, input);
  };
}
document.querySelectorAll('[data-insert]').forEach(button => button.onclick = () => {
  const action = button.dataset.insert;
  if (action === 'text') focusRange();
  else if (action === 'task') insertTask();
  else if (action === 'table') insertBlock(tableNode());
  else if (action === 'formula') { editingFormula = null; $('formula-source').value = ''; $('formula-dialog').showModal(); }
  else if (['image', 'camera', 'file'].includes(action)) $('pick-' + action).click();
  else if (action === 'audio') $('record-dialog').showModal();
  else if (action === 'drawing') openDrawingEditor();
  else if (action === 'mindmap') $('mindmap-dialog').showModal();
  else if (action === 'emoji') $('emoji-dialog').showModal();
  else if (action === 'password') $('password-dialog').showModal();
});
const emojis = ['😀', '😊', '😂', '🥰', '👍', '👏', '🎉', '💡', '✅', '⭐', '❤️', '🔥', '📌', '📚', '🌿', '☕', '🚀', '📝', '💬', '🙏'];
$('emoji-grid').replaceChildren(...emojis.map(emoji => {
  const button = document.createElement('button');
  button.textContent = emoji;
  button.onclick = () => { insertText(emoji); $('emoji-dialog').close(); };
  return button;
}));
$('emoji-close').onclick = () => $('emoji-dialog').close();
$('mindmap-cancel').onclick = () => $('mindmap-dialog').close();
$('formula-cancel').onclick = () => $('formula-dialog').close();
$('formula-save').onclick = () => {
  const source = $('formula-source').value.trim();
  if (!source) return;
  const node = formulaNode(source);
  $('formula-dialog').close();
  if (editingFormula?.isConnected) { editingFormula.replaceWith(node); saveEditorBody(); }
  else insertBlock(node);
  editingFormula = null;
};
$('mindmap-save').onclick = async () => {
  const outline = $('mindmap-outline').value.trim();
  if (!outline) { toast('输入导图内容'); return; }
  const file = new File([outlineToSvg(outline)], '思维导图.svg', { type: 'image/svg+xml' });
  $('mindmap-dialog').close();
  await storeFile(file, 'mindmap');
  $('mindmap-outline').value = '';
};
const canvas = $('drawing-canvas');
const context = canvas.getContext('2d');
let drawing = false, drawingTool = 'pencil', drawingTarget = null, drawingHistory = [], drawingHistoryIndex = -1, drawingRestoring = false;
function setDrawingPopover(name = null) {
  for (const type of ['color', 'size']) {
    const shown = name === type;
    $('drawing-' + type + '-popover').hidden = !shown;
    $('drawing-' + type + '-button').setAttribute('aria-expanded', String(shown));
    $('drawing-' + type + '-button').classList.toggle('active', shown);
  }
}
function setDrawingColor(value) {
  $('drawing-color').value = value;
  $('drawing-color-indicator').style.background = value;
  document.querySelectorAll('[data-drawing-color]').forEach(button => button.classList.toggle('active', button.dataset.drawingColor === value));
}
function setDrawingTool(tool) {
  drawingTool = tool;
  setDrawingPopover();
  document.querySelectorAll('[data-drawing-tool]').forEach(button => {
    const active = button.dataset.drawingTool === tool;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}
function updateDrawingHistoryButtons() {
  $('drawing-undo').disabled = drawingHistoryIndex <= 0;
  $('drawing-redo').disabled = drawingHistoryIndex >= drawingHistory.length - 1;
}
function snapshotDrawing() {
  drawingHistory = drawingHistory.slice(0, drawingHistoryIndex + 1);
  drawingHistory.push(canvas.toDataURL('image/png'));
  if (drawingHistory.length > 16) drawingHistory.shift();
  drawingHistoryIndex = drawingHistory.length - 1;
  updateDrawingHistoryButtons();
}
async function restoreDrawing(index) {
  if (drawingRestoring || index < 0 || index >= drawingHistory.length) return;
  drawingRestoring = true;
  try {
    const image = new Image();
    image.src = drawingHistory[index];
    await image.decode();
    context.globalAlpha = 1;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    drawingHistoryIndex = index;
    updateDrawingHistoryButtons();
  } finally { drawingRestoring = false; }
}
async function openDrawingEditor(payload = null, card = null, noteId = current) {
  if (!noteId) return;
  document.activeElement?.blur();
  drawingTarget = card ? { card, noteId } : null;
  setDrawingTool('pencil');
  setDrawingColor($('drawing-color').value);
  await new Promise(resolve => setTimeout(resolve, 160));
  if (current !== noteId) return;
  $('drawing-dialog').showModal();
  await new Promise(requestAnimationFrame);
  const rect = document.querySelector('.drawing-canvas-shell').getBoundingClientRect();
  const scale = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.min(1800, Math.round(rect.width * scale)));
  canvas.height = Math.max(1, Math.min(2400, Math.round(rect.height * scale)));
  context.globalAlpha = 1;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (payload?.data) {
    const url = URL.createObjectURL(new Blob([urlToBytes(payload.data)], { type: payload.mime || 'image/png' }));
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const ratio = Math.min(canvas.width / image.width, canvas.height / image.height);
      const width = image.width * ratio, height = image.height * ratio;
      context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    } catch { toast('绘图加载失败'); }
    finally { URL.revokeObjectURL(url); }
  }
  drawingHistory = [];
  drawingHistoryIndex = -1;
  snapshotDrawing();
}
const canvasPoint = event => {
  const rect = canvas.getBoundingClientRect();
  return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height };
};
canvas.onpointerdown = event => {
  if (drawingRestoring) return;
  event.preventDefault();
  drawing = true;
  canvas.setPointerCapture(event.pointerId);
  const point = canvasPoint(event);
  const styles = { pencil: { width: .7, alpha: .9 }, brush: { width: 2.4, alpha: .55 }, marker: { width: 3.5, alpha: .4 }, pen: { width: 1, alpha: 1 }, eraser: { width: 4, alpha: 1 } };
  const style = styles[drawingTool] || styles.pencil;
  context.globalAlpha = style.alpha;
  context.strokeStyle = drawingTool === 'eraser' ? '#fff' : $('drawing-color').value;
  context.fillStyle = context.strokeStyle;
  context.lineWidth = Number($('drawing-size').value) * style.width * canvas.width / canvas.getBoundingClientRect().width;
  context.lineCap = drawingTool === 'marker' ? 'square' : 'round';
  context.lineJoin = 'round';
  context.beginPath();
  context.arc(point.x, point.y, context.lineWidth / 2, 0, Math.PI * 2);
  context.fill();
  context.beginPath();
  context.moveTo(point.x, point.y);
};
canvas.onpointermove = event => {
  if (!drawing) return;
  event.preventDefault();
  const samples = event.getCoalescedEvents?.();
  for (const sample of samples?.length ? samples : [event]) {
    const point = canvasPoint(sample);
    context.lineTo(point.x, point.y);
    context.stroke();
  }
};
canvas.onpointerup = canvas.onpointercancel = () => { if (drawing) { drawing = false; context.globalAlpha = 1; snapshotDrawing(); } };
document.querySelectorAll('[data-drawing-tool]').forEach(button => button.onclick = () => setDrawingTool(button.dataset.drawingTool));
$('drawing-color-button').onclick = () => setDrawingPopover($('drawing-color-popover').hidden ? 'color' : null);
$('drawing-size-button').onclick = () => setDrawingPopover($('drawing-size-popover').hidden ? 'size' : null);
document.querySelectorAll('[data-drawing-color]').forEach(button => button.onclick = () => { setDrawingColor(button.dataset.drawingColor); setDrawingPopover(); });
$('drawing-color').oninput = event => { setDrawingColor(event.target.value); };
$('drawing-size').oninput = event => { $('drawing-size-value').textContent = event.target.value; };
$('drawing-undo').onclick = () => restoreDrawing(drawingHistoryIndex - 1);
$('drawing-redo').onclick = () => restoreDrawing(drawingHistoryIndex + 1);
$('drawing-clear').onclick = () => { context.globalAlpha = 1; context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); snapshotDrawing(); };
$('drawing-cancel').onclick = () => $('drawing-dialog').close();
$('drawing-save').onclick = async () => {
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) { toast('绘图保存失败'); return; }
  if (blob.size > 5 * 1024 * 1024) { toast('绘图超过 5 MB'); return; }
  const noteId = drawingTarget?.noteId || current;
  if (current !== noteId) { toast('请重新打开笔记'); return; }
  $('drawing-save').disabled = true;
  try {
    const data = bytesToUrl(new Uint8Array(await blob.arrayBuffer()));
    if (drawingTarget && !drawingTarget.card.isConnected) throw new Error('请重新打开笔记');
    if (drawingTarget) {
      const id = crypto.randomUUID();
      await putBlobs(db, [{ id, ciphertext: await encryptValue(key, { kind: 'drawing', name: '绘图.png', mime: 'image/png', data }), localPending: true }]);
      const card = drawingTarget.card;
      card.dataset.marker = `![绘图.png](surge-blob:${id})`;
      card.dataset.blobId = id;
      delete card.dataset.loaded;
      card.textContent = '绘图.png';
      await saveEditorBody();
      await renderAttachments(noteId);
      scheduleSync();
    } else await storePayload({ kind: 'drawing', name: '绘图.png', mime: 'image/png', data }, noteId);
    $('drawing-dialog').close();
  } catch (error) { toast(error.message || '绘图保存失败'); }
  finally { $('drawing-save').disabled = false; }
};
$('password-cancel').onclick = () => $('password-dialog').close();
$('password-save').onclick = async () => {
  const name = $('password-name').value.trim(), username = $('password-username').value.trim(), secret = $('password-secret').value;
  if (!name || !secret) { toast('填写名称和密码'); return; }
  $('password-dialog').close();
  await storePayload({ kind: 'password', name: '密码：' + name, username, secret });
  $('password-name').value = $('password-username').value = $('password-secret').value = '';
};
let recorder = null, recordStream = null, recordChunks = [], recordCanceled = false;
$('record-start').onclick = async () => {
  try {
    recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(recordStream);
    recordChunks = [];
    recordCanceled = false;
    recorder.ondataavailable = event => { if (event.data.size) recordChunks.push(event.data); };
    recorder.onstop = async () => {
      recordStream?.getTracks().forEach(track => track.stop());
      if (!recordCanceled) {
        const type = recorder.mimeType || 'audio/webm';
        await storeFile(new File(recordChunks, '录音.webm', { type }), 'audio');
        $('record-dialog').close();
      }
      $('record-start').hidden = false;
      $('record-stop').hidden = true;
      $('record-status').textContent = '点击开始录音';
    };
    recorder.start();
    $('record-start').hidden = true;
    $('record-stop').hidden = false;
    $('record-status').textContent = '录音中…';
  } catch { toast('录音不可用，可选择音频文件'); }
};
$('record-stop').onclick = () => { if (recorder?.state === 'recording') recorder.stop(); };
$('record-cancel').onclick = () => {
  recordCanceled = true;
  if (recorder?.state === 'recording') recorder.stop();
  recordStream?.getTracks().forEach(track => track.stop());
  $('record-dialog').close();
};
$('record-pick').onclick = () => { $('record-dialog').close(); $('pick-audio').click(); };
window.visualViewport?.addEventListener('resize', updateEditorViewport);
window.visualViewport?.addEventListener('scroll', updateEditorViewport);
window.addEventListener('online', sync);
window.addEventListener('popstate', () => { $('settings-panel').hidden = true; });
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
setInterval(sync, 30000);
await bootstrap();
