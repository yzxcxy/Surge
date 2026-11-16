import { bytesToUrl, decryptValue, deriveKey, downloadBlob, encryptValue, exchange, fetchInfo, historyForNote, makeOp, materialize, reencryptOps, uploadBlob, urlToBytes } from './core.mjs';
import { allBlobs, allOps, getBlob, getMeta, openDb, putBlobs, putMeta, putOps, replaceVault } from './db.mjs';
import { attachmentNode, tableNode, renderInlineMarkdown, renderMarkdown, serializeMarkdown } from './rich-editor.mjs';
import { APP_VERSION, DEFAULT_REPOSITORY, compareVersions, latestRelease } from './updates.mjs';

const $ = id => document.getElementById(id);
if (window.Capacitor?.isNativePlatform?.()) document.documentElement.classList.add('native-app');

let db, key, server = null, token = null, actor, clock = 0, cursor = 0;
let notes = new Map(), current = null, draftId = null, view = 'all', tab = 'notes', query = '';
let syncing = false, syncTimer, writeQueue = Promise.resolve();
let folderCatalog = [], folderDialogMode = 'create', renameFrom = '', folderAssignId = null;
let attachmentUrls = [];
let bodyRange = null;
let attachmentTarget = null, attachmentPayload = null;
let selectMode = false, selectedNotes = new Set(), moveTargets = [];
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
const backgrounds = [
  ['paper', '白纸'], ['warm', '米色'], ['rose', '浅粉'], ['sage', '浅绿'], ['sky', '浅蓝'], ['lavender', '浅紫']
];

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
  $('tabbar').hidden = view === 'trash' || selectMode;
  $('batch-bar').hidden = !selectMode;
  $('batch-count').textContent = `已选 ${selectedNotes.size} 项`;
  if (selectMode) $('fab').hidden = true;
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
    button.dataset.background = note.background || 'paper';
    button.classList.toggle('selecting', selectMode);
    button.classList.toggle('selected', selectedNotes.has(note.id));
    if (selectMode) button.setAttribute('aria-pressed', String(selectedNotes.has(note.id)));
    if (selectMode) { const circle = document.createElement('span'); circle.className = 'select-circle'; circle.setAttribute('aria-hidden', 'true'); button.append(circle); }
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
    let hold, held = false, startX = 0, startY = 0;
    button.onpointerdown = event => {
      if (selectMode || view === 'trash') return;
      startX = event.clientX; startY = event.clientY;
      hold = setTimeout(() => { held = true; selectMode = true; selectedNotes.add(note.id); navigator.vibrate?.(25); render(); }, 480);
    };
    button.onpointermove = event => { if (Math.abs(event.clientX - startX) > 12 || Math.abs(event.clientY - startY) > 12) clearTimeout(hold); };
    button.onpointerup = button.onpointercancel = () => clearTimeout(hold);
    button.oncontextmenu = event => { event.preventDefault(); clearTimeout(hold); held = true; selectMode = true; selectedNotes.add(note.id); render(); };
    button.onclick = () => {
      if (held) { held = false; return; }
      if (selectMode) { selectedNotes.has(note.id) ? selectedNotes.delete(note.id) : selectedNotes.add(note.id); if (!selectedNotes.size) exitSelection(); render(); }
      else openEditor(note.id);
    };
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
  exitSelection();
  view = next;
  if (next === 'trash') tab = 'notes';
  current = null;
  $('editor').hidden = true;
  closeMobileNav();
  render();
}
function setTab(next) {
  discardDraft();
  exitSelection();
  tab = next;
  current = null;
  $('editor').hidden = true;
  render();
}
function exitSelection() {
  selectMode = false;
  selectedNotes.clear();
}
function openMoveDialog(ids) {
  moveTargets = ids.filter(id => notes.has(id));
  if (!moveTargets.length) return;
  const options = ['', ...allFolders()];
  $('move-folder').replaceChildren(...options.map(folder => {
    const option = document.createElement('option');
    option.value = folder;
    option.textContent = folder || '未分类';
    return option;
  }));
  $('move-folder').value = notes.get(moveTargets[0])?.folder || '';
  $('more-menu').hidden = true;
  $('move-dialog').showModal();
}
function save(id, field, value) {
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    if (!key) return;
    const op = await makeOp(key, actor, ++clock, id, field, value);
    await putOps(db, [{ ...op, localPending: true }]);
    const note = notes.get(id) || { id, title: '', body: '', folder: '', pinned: false, deleted: false, background: 'paper', updatedAt: 0 };
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
  notes.set(id, { id, title: '', body: '', folder: ['all', 'pinned', 'trash'].includes(view) ? '' : view, pinned: false, deleted: false, background: 'paper', updatedAt: Date.now() });
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
  $('editor').dataset.background = note.background || 'paper';
  $('background-strip').hidden = true;
  $('attachment-actions').hidden = true;
  $('format-toolbar').hidden = true;
  $('editor-toolbar').hidden = false;
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
  const last = body.lastElementChild;
  end.selectNodeContents(last?.matches('p, li, h1, h2, h3, blockquote') ? last : body);
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
  const range = editorRange();
  range.deleteContents();
  const node = document.createTextNode(value);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  focusRange(range);
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
  const nonEditable = node.matches('.rich-attachment');
  const after = nonEditable ? document.createElement('p') : null;
  if (after) node.after(after);
  const target = after || node.querySelector('td, li') || node;
  caret.selectNodeContents(target);
  caret.collapse(target.tagName !== 'LI');
  focusRange(caret);
  saveEditorBody();
}
function insertTask() {
  const list = document.createElement('ul');
  const item = document.createElement('li');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.contentEditable = 'false';
  item.append(checkbox, document.createTextNode('\u00a0'));
  list.append(item);
  insertBlock(list);
}
function continueTask(event) {
  if (composingBody || event.isComposing || event.target.closest('input')) return;
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const node = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
  const item = node?.closest('li');
  const existingCheckbox = item?.querySelector(':scope > input[type="checkbox"]');
  if (!item || !$('note-body').contains(item) || !item.parentElement?.matches('ul, ol') || !existingCheckbox) return;
  event.preventDefault();
  const tail = document.createRange();
  tail.selectNodeContents(item);
  if (range.startContainer === item && range.startOffset === 0) tail.setStartAfter(existingCheckbox);
  else tail.setStart(range.startContainer, range.startOffset);
  const remainder = tail.extractContents();
  const next = document.createElement('li');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.contentEditable = 'false';
  const spacer = document.createTextNode('\u00a0');
  next.append(checkbox, spacer, remainder);
  item.after(next);
  const caret = document.createRange();
  caret.setStart(spacer, spacer.length);
  caret.collapse(true);
  focusRange(caret);
  saveEditorBody();
}
function applyFormat(kind) {
  if (!current) return;
  if (kind === 'bold' || kind === 'italic') {
    focusRange();
    document.execCommand(kind === 'bold' ? 'bold' : 'italic');
    saveEditorBody();
    return;
  }
  const body = $('note-body');
  const range = editorRange();
  let block = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
  while (block && block.parentElement !== body) block = block.parentElement;
  if (!block || block.matches('.rich-attachment, table')) return;
  const next = document.createElement(kind === 'list' ? 'ul' : kind === 'quote' ? 'blockquote' : kind);
  const target = kind === 'list' ? document.createElement('li') : next;
  while (block.firstChild) target.append(block.firstChild);
  if (kind === 'list') next.append(target);
  block.replaceWith(next);
  const caret = document.createRange();
  caret.selectNodeContents(target); caret.collapse(false); focusRange(caret);
  saveEditorBody();
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
      if (payload.kind === 'password') {
        const label = document.createElement('span');
        label.textContent = payload.name || '密码条目';
        card.append(label);
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
        card.classList.add('image-attachment');
        card.style.setProperty('--image-scale', String(payload.scale || 1));
        const image = document.createElement('img');
        image.src = url;
        image.alt = payload.caption || (payload.kind === 'mindmap' ? '思维导图' : payload.kind === 'drawing' ? '绘图' : '图片');
        card.append(image);
        if (payload.caption) { const caption = document.createElement('figcaption'); caption.textContent = payload.caption; card.append(caption); }
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', payload.kind === 'drawing' ? '绘图操作' : payload.kind === 'mindmap' ? '导图操作' : '图片操作');
        let pointerHandledAt = -Infinity;
        card.onpointerdown = event => { event.preventDefault(); event.stopPropagation(); pointerHandledAt = performance.now(); showAttachmentActions(card, payload); };
        card.onclick = event => { event.stopPropagation(); if (performance.now() - pointerHandledAt > 500) showAttachmentActions(card, payload); };
      } else if (payload.kind === 'audio') {
        const label = document.createElement('span'); label.textContent = payload.name || '录音'; card.append(label);
        const player = document.createElement('audio');
        player.controls = true;
        player.src = url;
        card.append(player);
      } else {
        const label = document.createElement('span'); label.textContent = payload.name || '附件'; card.append(label);
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
function hideAttachmentActions() { $('attachment-actions').hidden = true; attachmentTarget = attachmentPayload = null; }
function showAttachmentActions(card, payload) {
  if (attachmentTarget === card && !$('attachment-actions').hidden) { hideAttachmentActions(); return; }
  attachmentTarget = card;
  attachmentPayload = payload;
  const actions = $('attachment-actions');
  actions.hidden = false;
  actions.querySelector('[data-attachment-action="mindmap"]').hidden = payload.kind !== 'mindmap' || !payload.outline;
  const rect = card.getBoundingClientRect();
  const width = actions.offsetWidth || 290;
  actions.style.left = Math.max(10, Math.min(rect.left, window.innerWidth - width - 10)) + 'px';
  const below = rect.bottom + 8;
  const above = rect.top - actions.offsetHeight - 8;
  actions.style.top = (below + actions.offsetHeight < window.innerHeight - 8 ? below : above >= 8 ? above : Math.max(8, window.innerHeight - actions.offsetHeight - 8)) + 'px';
}
async function replaceAttachmentPayload(card, payload) {
  if (!card?.isConnected || !current) return;
  const id = crypto.randomUUID();
  await putBlobs(db, [{ id, ciphertext: await encryptValue(key, payload), localPending: true }]);
  const name = (payload.name || '图片').replace(/[\]\n]/g, '_');
  card.dataset.marker = `![${name}](surge-blob:${id})`;
  card.dataset.blobId = id;
  delete card.dataset.loaded;
  card.classList.remove('image-attachment');
  card.replaceChildren();
  hideAttachmentActions();
  await saveEditorBody();
  await renderAttachments(current);
  scheduleSync();
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
function outlineToSvg(items) {
  const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const nodes = items.filter(item => item.text.trim()).slice(0, 80).map((item, index) => ({ level: Math.min(4, item.depth), label: item.text.trim().length > 12 ? item.text.trim().slice(0, 11) + '…' : item.text.trim(), y: 35 + index * 66 }));
  const width = 900, height = Math.max(180, nodes.length * 66 + 35);
  const edges = nodes.map((node, index) => {
    if (!index || !node.level) return '';
    const parent = nodes.slice(0, index).reverse().find(item => item.level < node.level);
    return parent ? `<path d="M${172 + parent.level * 170} ${parent.y + 17} H${25 + node.level * 170 - 12} V${node.y + 17} H${25 + node.level * 170}" stroke="#c8c8c8" stroke-width="2" fill="none"/>` : '';
  }).join('');
  const boxes = nodes.map(node => `<rect x="${25 + node.level * 170}" y="${node.y}" width="148" height="35" rx="11" fill="${node.level ? '#f8f8f8' : '#fff8df'}" stroke="${node.level ? '#e6e6e6' : '#f3d278'}"/><text x="${36 + node.level * 170}" y="${node.y + 23}" font-family="sans-serif" font-size="14" fill="#252525">${escape(node.label)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/>${edges}${boxes}</svg>`;
}
let mindmapItems = [], mindmapTarget = null, mindmapActive = 0;
function focusMindmap(index) {
  const input = $('mindmap-items').children[index]?.querySelector('input');
  input?.focus();
  input?.setSelectionRange(input.value.length, input.value.length);
}
function renderMindmapItems(focusIndex = -1) {
  $('mindmap-items').replaceChildren(...mindmapItems.map((item, index) => {
    const row = document.createElement('div');
    row.className = 'mindmap-row';
    row.style.setProperty('--depth', item.depth);
    const dot = document.createElement('span'); dot.className = 'mindmap-dot'; dot.setAttribute('aria-hidden', 'true');
    const input = document.createElement('input');
    input.value = item.text;
    input.placeholder = index ? '新主题' : '中心主题';
    input.setAttribute('aria-label', `第 ${index + 1} 个主题`);
    input.onfocus = () => { mindmapActive = index; };
    input.oninput = () => { item.text = input.value; if (!$('mindmap-preview').hidden) updateMindmapPreview(); };
    input.onkeydown = event => {
      if (event.key === 'Enter') { event.preventDefault(); addMindmapItem(index); }
      else if (event.key === 'Tab') { event.preventDefault(); shiftMindmapItem(index, event.shiftKey ? -1 : 1); }
      else if (event.key === 'Backspace' && !input.value && mindmapItems.length > 1) {
        event.preventDefault(); mindmapItems.splice(index, 1); renderMindmapItems(Math.max(0, index - 1));
      } else if (event.key === 'ArrowUp' && index > 0 && input.selectionStart === 0) { event.preventDefault(); focusMindmap(index - 1); }
      else if (event.key === 'ArrowDown' && index < mindmapItems.length - 1 && input.selectionStart === input.value.length) { event.preventDefault(); focusMindmap(index + 1); }
    };
    row.append(dot, input);
    return row;
  }));
  if (focusIndex >= 0) focusMindmap(focusIndex);
}
function addMindmapItem(after = mindmapActive) {
  const index = Math.min(after + 1, mindmapItems.length);
  mindmapItems.splice(index, 0, { depth: mindmapItems[after]?.depth || 0, text: '' });
  renderMindmapItems(index);
}
function shiftMindmapItem(index, direction) {
  const item = mindmapItems[index];
  if (!item) return;
  item.depth = Math.max(0, Math.min(4, item.depth + direction, index ? mindmapItems[index - 1].depth + 1 : 0));
  renderMindmapItems(index);
}
function updateMindmapPreview() { $('mindmap-preview').innerHTML = outlineToSvg(mindmapItems); }
function openMindmapEditor(payload = null, card = null, noteId = current) {
  if (!noteId) return;
  mindmapTarget = card ? { card, noteId, payload } : null;
  mindmapItems = payload?.outline?.length ? payload.outline.map(item => ({ depth: Number(item.depth) || 0, text: String(item.text || '') })) : [{ depth: 0, text: '' }];
  mindmapActive = 0;
  $('mindmap-items').hidden = false;
  $('mindmap-add').hidden = false;
  $('mindmap-preview').hidden = true;
  renderMindmapItems();
  $('mindmap-dialog').showModal();
  focusMindmap(0);
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
$('check-update').onclick = async () => {
  const statusNode = $('update-status');
  const button = $('check-update');
  updateUrl = null;
  $('open-update').hidden = true;
  button.disabled = true;
  statusNode.textContent = '正在检查…';
  try {
    const release = await latestRelease(DEFAULT_REPOSITORY);
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
  const modal = document.querySelector('dialog[open]');
  if (modal) {
    if (modal.id === 'record-dialog' && recorder?.state === 'recording') $('record-cancel').click();
    else modal.close();
    return true;
  }
  if (!$('settings-panel').hidden) { closeSettings(); return true; }
  if (!$('history').hidden) { $('history').hidden = true; return true; }
  if (!$('editor').hidden) { $('back').click(); return true; }
  if (selectMode) { exitSelection(); render(); return true; }
  if (!$('mobile-nav').hidden) { closeMobileNav(); return true; }
  return false;
};
$('new-note').onclick = createForTab;
$('fab').onclick = createForTab;
$('back').onclick = () => { discardDraft(); $('editor').hidden = true; current = null; render(); };
$('batch-cancel').onclick = () => { exitSelection(); render(); };
$('batch-pin').onclick = async () => {
  const ids = [...selectedNotes];
  const pin = !ids.every(id => notes.get(id)?.pinned);
  for (const id of ids) await changeNote(id, 'pinned', pin);
  exitSelection(); render();
};
$('batch-move').onclick = () => openMoveDialog([...selectedNotes]);
$('batch-delete').onclick = async () => {
  for (const id of [...selectedNotes]) await changeNote(id, 'deleted', true);
  exitSelection(); render();
};
$('move-note').onclick = () => openMoveDialog([current]);
$('move-cancel').onclick = () => $('move-dialog').close();
$('move-save').onclick = async () => {
  const folder = $('move-folder').value;
  $('move-dialog').close();
  for (const id of moveTargets) if (notes.get(id)?.folder !== folder) await changeNote(id, 'folder', folder);
  moveTargets = [];
  exitSelection(); render();
};
$('show-format').onclick = () => { $('editor-toolbar').hidden = true; $('format-toolbar').hidden = false; };
$('hide-format').onclick = () => { $('format-toolbar').hidden = true; $('editor-toolbar').hidden = false; };
document.querySelectorAll('[data-format]').forEach(button => button.onclick = () => applyFormat(button.dataset.format));
for (const [id, label] of backgrounds) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.background = id;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.onclick = async () => {
    if (!current) return;
    $('editor').dataset.background = id;
    $('background-strip').hidden = true;
    await changeNote(current, 'background', id);
  };
  $('background-strip').append(button);
}
$('background-button').onclick = () => {
  $('background-strip').hidden = !$('background-strip').hidden;
  for (const button of $('background-strip').children) button.classList.toggle('active', button.dataset.background === $('editor').dataset.background);
  $('more-menu').hidden = true;
};
$('note-body').addEventListener('scroll', hideAttachmentActions);
$('note-body').addEventListener('click', event => { if (!event.target.closest('.rich-attachment')) hideAttachmentActions(); });
document.querySelectorAll('[data-attachment-action]').forEach(button => button.onclick = async () => {
  const card = attachmentTarget, payload = attachmentPayload;
  if (!card || !payload || !card.isConnected) return;
  const action = button.dataset.attachmentAction;
  hideAttachmentActions();
  if (action === 'caption') {
    const input = document.createElement('input');
    input.className = 'attachment-caption-input';
    input.value = payload.caption || '';
    input.placeholder = '添加注释';
    input.setAttribute('aria-label', '图片注释');
    card.append(input);
    input.focus();
    input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); input.blur(); } };
    input.onblur = () => { const caption = input.value.trim(); input.remove(); if (caption !== (payload.caption || '')) replaceAttachmentPayload(card, { ...payload, caption }); };
  } else if (action === 'draw') openDrawingEditor(payload, card, current);
  else if (action === 'mindmap') openMindmapEditor(payload, card, current);
  else if (action === 'resize') {
    const sizes = [1, .75, .5];
    const next = sizes[(sizes.indexOf(payload.scale || 1) + 1) % sizes.length];
    await replaceAttachmentPayload(card, { ...payload, scale: next });
    toast(`大小 ${Math.round(next * 100)}%`);
  } else if (action === 'copy') {
    const clone = attachmentNode(card.dataset.marker);
    const after = document.createElement('p');
    card.after(clone, after);
    const range = document.createRange(); range.selectNodeContents(after); range.collapse(true); focusRange(range);
    await saveEditorBody();
    await renderAttachments(current);
  } else if (action === 'delete') {
    const after = card.nextElementSibling?.matches('p') ? card.nextElementSibling : document.createElement('p');
    if (!after.isConnected) card.after(after);
    card.remove();
    const range = document.createRange(); range.selectNodeContents(after); range.collapse(true); focusRange(range);
    await saveEditorBody();
  }
});
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
$('note-body').addEventListener('keydown', event => { if (event.key === 'Enter') continueTask(event); });
$('note-body').addEventListener('beforeinput', event => { if (['insertParagraph', 'insertLineBreak'].includes(event.inputType)) continueTask(event); });
document.addEventListener('selectionchange', () => {
  const selection = window.getSelection();
  if (selection.rangeCount && $('note-body').contains(selection.anchorNode)) bodyRange = selection.getRangeAt(0).cloneRange();
});
$('note-body').addEventListener('change', event => { if (event.target.matches('input[type="checkbox"]')) saveEditorBody(); });
$('note-title').oninput = event => { if (current && !composingTitle) changeNote(current, 'title', event.target.value); };
$('note-body').oninput = () => { if (current && !composingBody) { applyMarkdownShortcut(); saveEditorBody(); } };
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
  else if (action === 'image') $('image-source-dialog').showModal();
  else if (action === 'file') $('pick-file').click();
  else if (action === 'audio') $('record-dialog').showModal();
  else if (action === 'drawing') openDrawingEditor();
  else if (action === 'mindmap') openMindmapEditor();
  else if (action === 'emoji') { $('emoji-search').value = ''; renderEmojis(); $('emoji-dialog').showModal(); $('emoji-search').focus(); }
});
$('image-from-album').onclick = () => { $('image-source-dialog').close(); $('pick-image').click(); };
$('image-from-camera').onclick = () => { $('image-source-dialog').close(); $('pick-camera').click(); };
$('image-source-cancel').onclick = () => $('image-source-dialog').close();
const emojis = [
  ['😀','开心 笑脸'],['😄','大笑 开心'],['😊','微笑 温暖'],['🥹','感动'],['😂','笑哭'],['🤣','爆笑'],['😅','尴尬'],['🥰','喜欢 爱'],['😍','心动'],['😘','亲亲'],['😎','酷'],['🤔','思考'],['😮','惊讶'],['🥲','苦笑'],['😢','难过'],['😭','大哭'],['😤','生气'],['😴','睡觉'],['🤒','生病'],['🥳','庆祝'],['🤗','拥抱'],['🫠','融化'],['🙃','无奈'],['😇','天使'],
  ['👍','赞 好'],['👎','不赞'],['👏','鼓掌'],['🙌','万岁'],['👌','可以'],['✌️','胜利'],['🤞','好运'],['🙏','谢谢 拜托'],['💪','加油 力量'],['👀','看'],['🫶','爱心'],['👋','你好 再见'],
  ['❤️','爱心 红心'],['🧡','橙心'],['💛','黄心'],['💚','绿心'],['💙','蓝心'],['💜','紫心'],['💔','心碎'],['✨','闪亮'],['⭐','星星'],['🌟','发光'],['🔥','火 热门'],['🎉','庆祝'],['🎂','生日 蛋糕'],['🎁','礼物'],['🌸','花'],['🌿','植物'],['🌈','彩虹'],['☀️','太阳'],['🌙','月亮'],['☁️','云'],['☔','雨'],['❄️','雪'],
  ['✅','完成 对'],['❌','错误 不'],['⚠️','提醒 警告'],['❗','注意'],['❓','问题'],['💡','想法 灵感'],['📌','置顶 标记'],['📅','日期 日历'],['📝','笔记 记录'],['📚','学习 书'],['📷','拍照 图片'],['🎵','音乐'],['🎧','耳机'],['📍','地点'],['💬','聊天'],['🔒','锁 隐私'],['🔔','提醒'],['⏰','时间 闹钟'],['🚀','进步 出发'],['☕','咖啡'],['🍵','茶'],['🍎','苹果'],['🍜','面条'],['🏠','家'],['🚗','车']
];
function renderEmojis() {
  const query = $('emoji-search').value.trim().toLowerCase();
  $('emoji-grid').replaceChildren(...emojis.filter(([emoji, words]) => !query || emoji.includes(query) || words.toLowerCase().includes(query)).map(([emoji, words]) => {
    const button = document.createElement('button');
    button.textContent = emoji;
    button.title = words.split(' ')[0];
    button.setAttribute('aria-label', words.split(' ')[0]);
    button.onclick = () => { $('emoji-dialog').close(); insertText(emoji); };
    return button;
  }));
}
$('emoji-search').oninput = renderEmojis;
renderEmojis();
$('emoji-close').onclick = () => $('emoji-dialog').close();
$('mindmap-cancel').onclick = () => $('mindmap-dialog').close();
$('mindmap-add').onclick = () => addMindmapItem();
$('mindmap-indent').onclick = () => shiftMindmapItem(mindmapActive, 1);
$('mindmap-outdent').onclick = () => shiftMindmapItem(mindmapActive, -1);
$('mindmap-preview-toggle').onclick = () => {
  const show = $('mindmap-preview').hidden;
  $('mindmap-preview').hidden = !show;
  $('mindmap-items').hidden = show;
  $('mindmap-add').hidden = show;
  if (show) { document.activeElement?.blur(); updateMindmapPreview(); }
  else focusMindmap(mindmapActive);
};
$('mindmap-save').onclick = async () => {
  const outline = mindmapItems.filter(item => item.text.trim()).map(item => ({ depth: item.depth, text: item.text.trim() }));
  if (!outline.length) { toast('输入主题'); return; }
  outline[0].depth = 0;
  const data = bytesToUrl(new TextEncoder().encode(outlineToSvg(outline)));
  const payload = { kind: 'mindmap', name: '思维导图.svg', mime: 'image/svg+xml', data, outline, caption: mindmapTarget?.payload?.caption || '', scale: mindmapTarget?.payload?.scale || 1 };
  $('mindmap-dialog').close();
  if (mindmapTarget?.card?.isConnected) await replaceAttachmentPayload(mindmapTarget.card, payload);
  else await storePayload(payload, mindmapTarget?.noteId || current);
  mindmapTarget = null;
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
  drawingTarget = card ? { card, noteId, payload } : null;
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
      await replaceAttachmentPayload(drawingTarget.card, { kind: 'drawing', name: '绘图.png', mime: 'image/png', data, caption: drawingTarget.payload?.caption || '', scale: drawingTarget.payload?.scale || 1 });
    } else await storePayload({ kind: 'drawing', name: '绘图.png', mime: 'image/png', data }, noteId);
    $('drawing-dialog').close();
  } catch (error) { toast(error.message || '绘图保存失败'); }
  finally { $('drawing-save').disabled = false; }
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
