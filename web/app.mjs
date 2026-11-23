import { initializePreferences, locale, setLanguage, setTheme, t } from './preferences.mjs';
import { bytesToUrl, decryptValue, deriveKey, downloadBlob, encryptValue, exchange, fetchInfo, historyForNote, makeOp, materialize, reencryptOps, uploadBlob, urlToBytes } from './core.mjs';
import { allBlobs, allOps, getBlob, getMeta, openDb, pruneNote, putBlobs, putMeta, putOps, replaceVault } from './db.mjs';
import { attachmentNode, tableNode, renderInlineMarkdown, renderMarkdown, serializeMarkdown } from './rich-editor.mjs';
import { APP_VERSION, DEFAULT_REPOSITORY, compareVersions, latestRelease } from './updates.mjs';
import { lunarDayLabel, reminderOccurrences, reminderNotificationId } from './todo-reminders.mjs';

const $ = id => document.getElementById(id);
if (window.Capacitor?.isNativePlatform?.()) document.documentElement.classList.add('native-app');

let db, key, server = null, token = null, actor, clock = 0, cursor = 0;
let notes = new Map(), current = null, draftId = null, view = 'all', tab = 'notes', query = '';
let syncing = false, syncTimer, writeQueue = Promise.resolve(), draftCommit = Promise.resolve();
let folderCatalog = [], folderDialogMode = 'create', renameFrom = '', folderAssignId = null;
let categorySelectMode = false, selectedCategories = new Set();
let attachmentUrls = [];
let bodyRange = null;
let attachmentTarget = null, attachmentPayload = null;
let selectMode = false, selectedNotes = new Set(), moveTargets = [];
let editingTodoId = null, todoExpanded = new Set(), completedTodosOpen = true;
let draftUntouched = false;
let todoReminderRule = 'none', todoReminderLunar = false, reminderSelectedDate = null, reminderMonth = null;
let notificationSyncTimer = null, notificationSync = Promise.resolve();
let exactAlarmSettingRequested = false;
let nativeVisibleHeight = Infinity;
let editorClosing = false;
let editorTransition = [];
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
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/^\s*[-*]\s+\[([ xX])\]\s*/gm, (_, checked) => checked.toLowerCase() === 'x' ? '☑ ' : '☐ ')
  .replace(/^\s*[-*]\s+/gm, '• ')
  .replace(/\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g, (_, strong, emphasis, code) => strong || emphasis || code)
  .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')
  .trim();
const mindmapPreview = value => value.split('\n').filter(line => /^\s*-\s/.test(line)).slice(0, 3).map(line => line.replace(/^\s*-\s*/, '')).join(' · ');
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
  closeCategoryPanel();
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
  return ms ? new Intl.DateTimeFormat(locale(), { month: 'long', day: 'numeric' }).format(ms) : '刚刚';
}
function editDate(ms, length) {
  return `${ms ? new Intl.DateTimeFormat(locale(), { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms) : '刚刚'}　|　${length} 字`;
}
function viewName() {
  return view === 'all' ? '笔记' : view === 'pinned' ? '置顶' : view === 'trash' ? '回收站' : view === '__uncategorized__' ? '未分类' : view;
}
function activeNotes() {
  return [...notes.values()]
    .filter(n => n.id !== draftId)
    .filter(n => !isFolderRecord(n) && !n.purged)
    .filter(n => view === 'trash' ? n.deleted : !n.deleted && (view === 'all' || (view === 'pinned' ? n.pinned : view === '__uncategorized__' ? !n.folder : n.folder === view)))
    .filter(n => view === 'trash' || (tab === 'todos' ? noteKind(n) === 'todo' : noteKind(n) !== 'todo'))
    .filter(n => (n.title + '\n' + n.body).toLowerCase().includes(query))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}
const legacyTodo = note => !note.stamps?.kind && /^- \[[ xX]\] [^\n]+$/.test(note.body) && note.title === note.body.slice(6);
const noteKind = note => ['todo', 'mindmap'].includes(note.kind) ? note.kind : (legacyTodo(note) ? 'todo' : 'note');
function todoItems(note) {
  return (note.body || '').split('\n').map(line => /^- \[([ xX])\] (.*)$/.exec(line)).filter(Boolean).map(match => ({ done: match[1].toLowerCase() === 'x', text: match[2] }));
}
const todoBody = items => items.filter(item => item.text.trim()).map(item => `- [${item.done ? 'x' : ' '}] ${item.text.trim()}`).join('\n');
const todoIsChecklist = (note, items = todoItems(note)) => items.length > 1 || (items.length === 1 && !!note.title && note.title.trim() !== items[0].text.trim());
const reminderRuleLabels = { none: '', daily: '每天', weekly: '每周', monthly: '每月', yearly: '每年' };
function todoReminderText(when, rule = 'none', lunar = false, completed = false) {
  if (!when) return '';
  const next = !completed && rule !== 'none' ? reminderOccurrences(when, rule, lunar)[0] : 0;
  const date = new Date(next || when);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const day = sameDay ? '今天' : new Intl.DateTimeFormat(locale(), { month: 'numeric', day: 'numeric' }).format(date);
  const time = new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  const repeat = reminderRuleLabels[rule] ? ` · ${reminderRuleLabels[rule]}` : '';
  return `${day} ${time}${date.getTime() < Date.now() && !next ? ' 已过期' : ''}${repeat}${lunar ? ' · 农历' : ''} ◉`;
}
const categoryRecords = name => [...notes.values()].filter(note => isFolderRecord(note) && !note.deleted && !note.purged && note.title === name);
const categoryPinned = name => categoryRecords(name).some(note => note.pinned);
function allFolders() {
  return [...new Set([
    ...folderCatalog,
    ...[...notes.values()].filter(note => !note.deleted && !note.purged && isFolderRecord(note) && note.title).map(note => note.title),
    ...[...notes.values()].filter(note => !note.deleted && !note.purged && !isFolderRecord(note) && note.folder).map(note => note.folder)
  ])].sort((a, b) => Number(categoryPinned(b)) - Number(categoryPinned(a)) || a.localeCompare(b, 'zh-CN'));
}
function updateFolderSelect() {
  const value = current ? notes.get(current)?.folder || '' : '';
  $('note-folder-label').textContent = value || t('未分类');
}
function openNoteFolderDialog() {
  if (!current) return;
  const id = current;
  const selected = notes.get(id)?.folder || '';
  const dialog = $('note-folder-dialog');
  $('note-folder-dialog-title').textContent = t('分类');
  $('note-folder-create').textContent = '＋ ' + t('新建分类');
  $('note-folder-options').replaceChildren(...['', ...allFolders()].map(folder => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preference-option';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(folder === selected));
    const label = document.createElement('span');
    label.textContent = folder || t('未分类');
    const check = document.createElement('span');
    check.className = 'preference-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = folder === selected ? '✓' : '';
    button.append(label, check);
    button.onclick = () => {
      dialog.close();
      if (current === id && folder !== selected) changeNote(id, 'folder', folder);
    };
    return button;
  }));
  dialog.showModal();
}
function renderCategoryPanel(folders) {
  const active = [...notes.values()].filter(note => note.id !== draftId && !note.deleted && !note.purged && !isFolderRecord(note));
  const entries = [
    { value: 'all', label: '全部', count: active.length },
    ...folders.map(folder => ({ value: folder, label: folder, count: active.filter(note => note.folder === folder).length })),
    { value: '__uncategorized__', label: '未分类', count: active.filter(note => !note.folder).length }
  ];
  $('category-list').replaceChildren(...entries.map(entry => {
    const button = document.createElement('button');
    const custom = !['all', '__uncategorized__'].includes(entry.value);
    button.className = 'category-list-item';
    button.classList.toggle('selecting', categorySelectMode && custom);
    button.classList.toggle('current', view === entry.value && !categorySelectMode);
    button.classList.toggle('selected', categorySelectMode && selectedCategories.has(entry.value));
    button.disabled = categorySelectMode && !custom;
    const mark = document.createElement('span');
    mark.className = 'category-list-mark';
    mark.textContent = categorySelectMode ? (selectedCategories.has(entry.value) || (!custom && view === entry.value) ? '✓' : '') : (view === entry.value ? '✓' : '');
    const label = document.createElement('span');
    label.className = 'category-list-label';
    label.textContent = custom ? entry.label : t(entry.label);
    const count = document.createElement('span');
    count.className = 'category-list-count';
    count.textContent = String(entry.count);
    button.append(mark, label, count);
    button.onclick = () => {
      if (categorySelectMode) {
        selectedCategories.has(entry.value) ? selectedCategories.delete(entry.value) : selectedCategories.add(entry.value);
        renderCategoryPanel(folders);
      } else setView(entry.value);
    };
    return button;
  }));
  $('category-title').textContent = categorySelectMode ? `已选择${selectedCategories.size}项` : '分类';
  $('category-back').textContent = categorySelectMode ? '×' : '←';
  $('category-back').setAttribute('aria-label', categorySelectMode ? '取消选择' : '返回笔记');
  $('category-select-toggle').disabled = !folders.length;
  $('category-select-toggle').setAttribute('aria-label', categorySelectMode ? (selectedCategories.size === folders.length ? '取消全选' : '全选') : '选择分类');
  $('category-select-toggle').innerHTML = categorySelectMode ? listIcon : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13"/></svg>';
  $('category-create').hidden = categorySelectMode;
  $('category-batch-bar').hidden = !categorySelectMode;
  $('category-pin').disabled = !selectedCategories.size;
  $('category-delete').disabled = !selectedCategories.size;
  $('category-edit').disabled = selectedCategories.size !== 1;
  $('category-pin-label').textContent = selectedCategories.size && [...selectedCategories].every(categoryPinned) ? '取消置顶' : '置顶';
}
function render() {
  const folders = allFolders();
  const categoryRow = (folder, mobile = false) => {
    const row = document.createElement('div');
    row.className = mobile ? 'mobile-category-row' : 'folder-item-row';
    const button = document.createElement('button');
    button.className = (mobile ? 'mobile-category-item' : 'folder-item') + (view === folder ? ' active' : '');
    button.textContent = mobile ? folder : '▱  ' + folder;
    button.onclick = () => setView(folder);
    const actions = document.createElement('button');
    actions.className = 'category-actions';
    actions.textContent = '⋯';
    actions.setAttribute('aria-label', `操作“${folder}”分类`);
    actions.onclick = () => openFolderManageDialog(folder);
    row.append(button, actions);
    return row;
  };
  $('folders').replaceChildren(...folders.map(folder => categoryRow(folder)));
  $('category-strip').replaceChildren(...[
    ['all', '全部'], ...folders.map(folder => [folder, folder]), ['__uncategorized__', '未分类']
  ].map(([value, label]) => {
    const button = document.createElement('button');
    button.textContent = ['all', '__uncategorized__'].includes(value) ? t(label) : label;
    button.classList.toggle('active', view === value);
    button.onclick = () => setView(value);
    return button;
  }));
  $('category-strip').hidden = view === 'trash' || tab === 'todos';
  renderCategoryPanel(folders);
  document.querySelectorAll('.nav').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  document.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  const name = tab === 'todos' ? '待办' : viewName();
  for (const id of ['view-title', 'breadcrumbs']) {
    $(id).toggleAttribute('data-user-content', tab === 'notes' && !['all', 'pinned', 'trash', '__uncategorized__'].includes(view));
    $(id).textContent = name;
  }
  $('trash-back').hidden = view !== 'trash';
  $('mobile-folders').hidden = tab === 'todos';
  $('search').placeholder = tab === 'todos' ? '搜索待办' : '搜索笔记';
  $('new-note').hidden = view === 'trash';
  $('new-note').textContent = tab === 'todos' ? '新建待办' : '新建笔记';
  $('fab').hidden = view === 'trash';
  $('tabbar').hidden = view === 'trash' || selectMode;
  $('batch-bar').hidden = !selectMode;
  $('batch-count').textContent = `已选 ${selectedNotes.size} 项`;
  $('batch-pin').hidden = view === 'trash';
  $('batch-move').hidden = view === 'trash';
  $('batch-restore').hidden = view !== 'trash';
  $('batch-delete').setAttribute('aria-label', view === 'trash' ? '彻底删除' : '删除');
  $('batch-delete').title = view === 'trash' ? '彻底删除' : '删除';
  if (selectMode) $('fab').hidden = true;
  $('notes').hidden = tab !== 'notes';
  $('todos').hidden = tab !== 'todos';
  $('fab').setAttribute('aria-label', tab === 'todos' ? '新建待办' : '新建笔记');
  const list = activeNotes();
  $('clear-trash').hidden = view !== 'trash' || ![...notes.values()].some(note => note.deleted && !note.purged && !isFolderRecord(note));
  $('count').textContent = list.length + (view === 'trash' ? ' 项内容' : tab === 'todos' ? ' 组待办' : ' 条笔记');
  $('empty').hidden = list.length > 0;
  $('empty').textContent = tab === 'todos' ? '还没有待办' : '还没有笔记';
  $('notes').classList.toggle('list', layout === 'list');
  $('layout-toggle').innerHTML = layout === 'list' ? gridIcon : listIcon;
  $('layout-toggle').title = layout === 'list' ? '切换为宫格' : '切换为列表';
  $('layout-toggle').setAttribute('aria-label', $('layout-toggle').title);
  $('layout-toggle').setAttribute('aria-pressed', String(layout === 'grid'));
  $('layout-toggle').hidden = tab === 'todos';
  $('sync-now').hidden = !server;
  $('notes').replaceChildren(...(tab === 'notes' ? list : []).map(note => {
    const button = document.createElement('button');
    button.className = 'note-card';
    button.dataset.noteId = note.id;
    button.dataset.background = note.background || 'paper';
    button.classList.toggle('selecting', selectMode);
    button.classList.toggle('selected', selectedNotes.has(note.id));
    if (selectMode) button.setAttribute('aria-pressed', String(selectedNotes.has(note.id)));
    if (selectMode) { const circle = document.createElement('span'); circle.className = 'select-circle'; circle.setAttribute('aria-hidden', 'true'); button.append(circle); }
    const title = document.createElement('h3');
    title.textContent = note.title || t(noteKind(note) === 'mindmap' ? '未命名思维笔记' : '未命名笔记');
    const preview = document.createElement('p');
    preview.textContent = noteKind(note) === 'mindmap' ? (mindmapPreview(note.body) || t('思维笔记')) : previewBody(note.body) || t(note.body.includes('surge-blob:') ? '附件' : '空白笔记');
    const footer = document.createElement('footer');
    const date = document.createElement('span');
    date.textContent = niceDate(note.updatedAt);
    const tag = document.createElement('span');
    tag.className = note.pinned ? 'pin' : '';
    if (note.pinned) { tag.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 3 8 0-1 6 3 3v2H6v-2l3-3-1-6Zm4 11v7"/></svg>'; tag.setAttribute('aria-label', '置顶'); }
    else tag.textContent = noteKind(note) === 'mindmap' ? t('思维笔记') : noteKind(note) === 'todo' ? t('待办') : note.folder;
    footer.append(date, tag);
    button.append(title, preview, footer);
    let hold, held = false, startX = 0, startY = 0;
    button.onpointerdown = event => {
      if (selectMode) return;
      startX = event.clientX; startY = event.clientY;
      hold = setTimeout(() => { held = true; selectMode = true; selectedNotes.add(note.id); navigator.vibrate?.(25); render(); }, 480);
    };
    button.onpointermove = event => { if (Math.abs(event.clientX - startX) > 12 || Math.abs(event.clientY - startY) > 12) clearTimeout(hold); };
    button.onpointerup = button.onpointercancel = () => clearTimeout(hold);
    button.oncontextmenu = event => { event.preventDefault(); clearTimeout(hold); held = true; selectMode = true; selectedNotes.add(note.id); render(); };
    button.onclick = () => {
      if (held) { held = false; return; }
      if (selectMode) { selectedNotes.has(note.id) ? selectedNotes.delete(note.id) : selectedNotes.add(note.id); if (!selectedNotes.size) exitSelection(); render(); }
      else if (view === 'trash' && button.parentElement?.classList.contains('revealed')) button.parentElement.classList.remove('revealed');
      else openEditor(note.id, button);
    };
    if (view !== 'trash') return button;
    const wrapper = document.createElement('div');
    wrapper.className = 'trash-card';
    const actions = document.createElement('div');
    actions.className = 'trash-card-actions';
    const restore = document.createElement('button');
    restore.textContent = '恢复';
    const remove = document.createElement('button');
    remove.textContent = '彻底移除';
    actions.append(restore, remove);
    wrapper.append(button, actions);
    let swipeStart = null;
    button.addEventListener('pointerdown', event => { swipeStart = { x: event.clientX, y: event.clientY }; });
    button.addEventListener('pointerup', event => {
      if (!swipeStart || selectMode) return;
      const dx = event.clientX - swipeStart.x, dy = event.clientY - swipeStart.y;
      swipeStart = null;
      if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
      wrapper.classList.toggle('revealed', dx < 0);
      if (dx < 0) { held = true; setTimeout(() => { held = false; }, 0); }
    });
    button.addEventListener('pointercancel', () => { swipeStart = null; });
    restore.onclick = () => changeNote(note.id, 'deleted', false);
    remove.onclick = () => { if (confirm(`彻底删除“${note.title || '未命名笔记'}”？此操作无法撤销。`)) purgeNote(note.id); };
    return wrapper;
  }));
  const renderTodoCard = note => {
    const items = todoItems(note);
    if (!items.length && note.title) items.push({ text: note.title, done: false });
    const done = items.filter(item => item.done).length;
    const checklist = todoIsChecklist(note, items);
    const card = document.createElement('article');
    card.className = 'todo-card' + (checklist ? ' checklist' : ' simple') + (items.length && done === items.length ? ' completed' : '');
    card.dataset.noteId = note.id;
    const head = document.createElement('div');
    head.className = 'todo-card-head';
    const all = document.createElement('input');
    all.type = 'checkbox';
    all.checked = !!items.length && done === items.length;
    all.setAttribute('aria-label', checklist ? '完成整组待办' : '完成待办');
    all.onchange = () => changeNote(note.id, 'body', todoBody(items.map(item => ({ ...item, done: all.checked }))));
    const title = document.createElement('button');
    title.className = 'todo-card-title';
    title.innerHTML = `<strong></strong><small></small>`;
    title.querySelector('strong').textContent = note.title || '未命名待办';
    title.querySelector('small').textContent = todoReminderText(note.reminderAt, note.reminderRule, note.reminderLunar, done === items.length);
    title.querySelector('small').hidden = !note.reminderAt;
    title.onclick = () => openTodoEditor(note.id);
    const progress = document.createElement('span');
    progress.className = 'todo-progress';
    progress.textContent = `${done} / ${items.length}`;
    progress.hidden = !checklist;
    const expand = document.createElement('button');
    expand.className = 'todo-expand';
    expand.setAttribute('aria-label', todoExpanded.has(note.id) ? '收起待办' : '展开待办');
    expand.textContent = todoExpanded.has(note.id) ? '⌃' : '⌄';
    expand.hidden = !checklist;
    expand.onclick = () => { todoExpanded.has(note.id) ? todoExpanded.delete(note.id) : todoExpanded.add(note.id); render(); };
    head.append(all, title, progress, expand);
    card.append(head);
    if (checklist && todoExpanded.has(note.id)) {
      const children = document.createElement('div');
      children.className = 'todo-card-items';
      items.forEach((item, index) => {
        const row = document.createElement('label');
        const check = document.createElement('input');
        check.type = 'checkbox'; check.checked = item.done;
        check.onchange = () => changeNote(note.id, 'body', todoBody(items.map((entry, i) => i === index ? { ...entry, done: check.checked } : entry)));
        const text = document.createElement('span');
        text.textContent = item.text;
        row.append(check, text);
        children.append(row);
      });
      card.append(children);
    }
    return card;
  };
  const todoList = tab === 'todos' ? list : [];
  const openTodos = todoList.filter(note => { const items = todoItems(note); return !items.length || items.some(item => !item.done); });
  const completedTodos = todoList.filter(note => { const items = todoItems(note); return items.length && items.every(item => item.done); }).sort((a, b) => b.updatedAt - a.updatedAt);
  const completedSection = document.createElement('section');
  completedSection.className = 'todo-completed-section';
  if (completedTodos.length) {
    const toggle = document.createElement('button');
    toggle.className = 'todo-completed-toggle';
    toggle.textContent = `${completedTodosOpen ? '⌃' : '⌄'}  已完成 ${completedTodos.length}`;
    toggle.setAttribute('aria-expanded', String(completedTodosOpen));
    toggle.onclick = () => { completedTodosOpen = !completedTodosOpen; render(); };
    completedSection.append(toggle);
    if (completedTodosOpen) completedSection.append(...completedTodos.map(renderTodoCard));
  }
  $('todos').replaceChildren(...openTodos.map(renderTodoCard), completedSection);
  updateFolderSelect(folders);
}
function closeCategoryPanel() {
  $('category-panel').hidden = true;
  categorySelectMode = false;
  selectedCategories.clear();
  $('mobile-folders').setAttribute('aria-expanded', 'false');
}
function openCategoryPanel() {
  categorySelectMode = false;
  selectedCategories.clear();
  $('category-panel').hidden = false;
  $('mobile-folders').setAttribute('aria-expanded', 'true');
  renderCategoryPanel(allFolders());
}
async function persistFolders() {
  await putMeta(db, 'folders', await encryptValue(key, folderCatalog));
}
async function createFolderRecord(name) {
  const id = crypto.randomUUID();
  await save(id, 'body', folderRecordBody);
  await save(id, 'title', name);
  await save(id, 'updatedAt', Date.now());
  return id;
}
async function setCategoryPinned(name, pinned) {
  let records = categoryRecords(name);
  if (!records.length) {
    const id = await createFolderRecord(name);
    records = [notes.get(id)];
  }
  for (const record of records) if (!!record.pinned !== pinned) await changeNote(record.id, 'pinned', pinned);
}
function openFolderDialog(mode = 'create', oldName = '', assignId = null) {
  folderDialogMode = mode;
  renameFrom = oldName;
  folderAssignId = assignId;
  $('folder-dialog-title').textContent = mode === 'rename' ? '重命名分类' : '新建分类';
  $('folder-name').value = mode === 'rename' ? oldName : '';
  $('folder-error').textContent = '';
  if (!$('folder-dialog').open) $('folder-dialog').showModal();
  $('folder-name').focus();
}
function openFolderManageDialog(folder) {
  closeCategoryPanel();
  $('folder-manage-title').textContent = folder;
  const row = document.createElement('div');
  row.className = 'folder-manage-row';
  const edit = document.createElement('button');
  edit.type = 'button'; edit.textContent = '重命名';
  edit.onclick = () => { $('folder-manage-dialog').close(); openFolderDialog('rename', folder); };
  const remove = document.createElement('button');
  remove.type = 'button'; remove.className = 'delete'; remove.textContent = '删除';
  remove.onclick = async () => { if (await deleteFolder(folder)) $('folder-manage-dialog').close(); };
  row.append(edit, remove);
  $('folder-manage-list').replaceChildren(row);
  if (!$('folder-manage-dialog').open) $('folder-manage-dialog').showModal();
}
async function saveFolder(event) {
  event.preventDefault();
  if (!$('folder-dialog').open) return;
  const name = $('folder-name').value.trim();
  if (!name) { $('folder-error').textContent = '输入分类名称'; return; }
  if (['all', 'pinned', 'trash', '__new__', '__uncategorized__'].includes(name)) { $('folder-error').textContent = '请换一个分类名称'; return; }
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
    categorySelectMode = false;
    selectedCategories.clear();
    render();
  } else {
    await createFolderRecord(name);
    if (folderAssignId) await changeNote(folderAssignId, 'folder', name); else setView(name);
  }
  $('folder-dialog').close();
}
async function deleteFolder(folder) {
  if (!confirm(`删除“${folder}”分类？其中的笔记会移到未分类。`)) return false;
  await removeFolder(folder);
  render();
  return true;
}
async function removeFolder(folder) {
  folderCatalog = folderCatalog.filter(name => name !== folder);
  await persistFolders();
  for (const record of [...notes.values()].filter(note => !note.deleted && isFolderRecord(note) && note.title === folder)) await changeNote(record.id, 'deleted', true);
  for (const note of [...notes.values()].filter(note => !isFolderRecord(note) && note.folder === folder)) await changeNote(note.id, 'folder', '');
  if (view === folder) view = 'all';
  $('folder-dialog').close();
}
function setView(next) {
  discardDraft();
  exitSelection();
  view = next;
  if (next === 'trash') tab = 'notes';
  current = null;
  $('editor').hidden = true;
  closeCategoryPanel();
  render();
}
function setTab(next) {
  discardDraft();
  exitSelection();
  tab = next;
  if (next === 'todos') view = 'all';
  current = null;
  $('editor').hidden = true;
  closeCategoryPanel();
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
    option.textContent = folder || t('未分类');
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
    const note = notes.get(id) || { id, title: '', body: '', folder: '', pinned: false, deleted: false, purged: false, kind: 'note', reminderAt: 0, background: 'paper', updatedAt: 0 };
    note[field] = value;
    notes.set(id, note);
    $('save-state').textContent = '已保存在本机';
    render();
    if (noteKind(note) === 'todo' && ['title', 'body', 'reminderAt', 'reminderRule', 'reminderLunar', 'deleted', 'purged'].includes(field)) queueReminderSync();
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
    const kind = notes.get(id)?.kind;
    const folder = notes.get(id)?.folder;
    const pinned = notes.get(id)?.pinned;
    draftCommit = (async () => {
      if (kind && kind !== 'note') await save(id, 'kind', kind);
      if (folder && field !== 'folder') await save(id, 'folder', folder);
      if (pinned) await save(id, 'pinned', true);
    })();
  }
  await draftCommit;
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
  draftUntouched = false;
}
function createNote() {
  const id = crypto.randomUUID();
  discardDraft();
  draftId = id;
  draftUntouched = true;
  notes.set(id, { id, title: '', body: '', folder: ['all', 'pinned', 'trash', '__uncategorized__'].includes(view) ? '' : view, pinned: false, deleted: false, purged: false, kind: 'note', reminderAt: 0, background: 'paper', updatedAt: Date.now() });
  openEditor(id);
  $('create-mindmap-inline').hidden = false;
  $('note-title').focus();
}
function convertDraftToMindmap() {
  const note = notes.get(draftId);
  if (!draftId || !draftUntouched || !note || note.title || note.body) return;
  const id = draftId;
  note.kind = 'mindmap';
  draftUntouched = false;
  $('editor').hidden = true;
  current = id;
  openMindmapEditor(null, null, id, true);
}
function createMindmap() {
  const id = crypto.randomUUID();
  discardDraft();
  draftId = id;
  notes.set(id, { id, title: '', body: '', folder: ['all', 'pinned', 'trash', '__uncategorized__'].includes(view) ? '' : view, pinned: false, deleted: false, purged: false, kind: 'mindmap', reminderAt: 0, background: 'paper', updatedAt: Date.now() });
  current = id;
  openMindmapEditor(null, null, id, true);
}
function addTodoEditItem(item = { text: '', done: false }, after = null) {
  const row = document.createElement('div');
  row.className = 'todo-edit-row';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = item.done;
  check.setAttribute('aria-label', '完成此项');
  const input = document.createElement('input');
  input.type = 'text';
  input.value = item.text;
  input.placeholder = '输入待办，回车添加下一项';
  input.setAttribute('aria-label', '待办内容');
  input.onkeydown = event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') { event.preventDefault(); addTodoEditItem(undefined, row).querySelector('input[type=text]').focus(); }
    else if (event.key === 'Backspace' && !input.value && $('todo-edit-items').children.length > 1) {
      event.preventDefault();
      const previous = row.previousElementSibling || row.nextElementSibling;
      row.remove();
      syncTodoEditorLayout();
      previous?.querySelector('input[type=text]')?.focus();
    }
  };
  row.append(check, input);
  if (after) after.after(row); else $('todo-edit-items').append(row);
  syncTodoEditorLayout();
  return row;
}
function syncTodoEditorLayout() {
  const title = $('todo-title');
  const first = $('todo-edit-items').querySelector('input[type=text]')?.value.trim() || '';
  title.hidden = $('todo-edit-items').children.length < 2 && (!title.value.trim() || title.value.trim() === first);
  $('todo-dialog').classList.toggle('checklist', !title.hidden);
}
function openTodoEditor(id = null) {
  const note = id ? notes.get(id) : null;
  editingTodoId = id;
  $('todo-dialog-heading').textContent = note ? '编辑待办' : '新建待办';
  $('todo-title').value = note?.title || '';
  $('todo-edit-items').replaceChildren();
  const items = note ? todoItems(note) : [];
  if (note && !items.length && note.title) items.push({ text: note.title, done: false });
  for (const item of items.length ? items : [{ text: '', done: false }]) addTodoEditItem(item);
  syncTodoEditorLayout();
  const when = note?.reminderAt || 0;
  $('todo-reminder').value = when ? new Date(when - new Date(when).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
  todoReminderRule = note?.reminderRule || 'none';
  todoReminderLunar = !!note?.reminderLunar;
  updateTodoDateText();
  $('todo-delete').hidden = !note || note.deleted;
  $('todo-restore').hidden = !note?.deleted;
  $('todo-dialog').showModal();
  updateTodoViewport();
  $('todo-edit-items').querySelector('input[type=text]')?.focus();
}
function updateTodoDateText() {
  const value = $('todo-reminder').value;
  $('todo-date-text').textContent = value ? todoReminderText(new Date(value).getTime(), todoReminderRule, todoReminderLunar).replace(/ ◉$/, '') : '设置提醒';
}
function localNotifications() {
  const capacitor = window.Capacitor;
  if (!capacitor?.isNativePlatform?.()) return null;
  if (capacitor.Plugins?.LocalNotifications) return capacitor.Plugins.LocalNotifications;
  if (typeof capacitor.nativePromise !== 'function') return null;
  return Object.fromEntries(['checkPermissions', 'requestPermissions', 'checkExactNotificationSetting', 'changeExactNotificationSetting', 'getPending', 'cancel', 'schedule']
    .map(method => [method, (options = {}) => capacitor.nativePromise('LocalNotifications', method, options)]));
}
async function requestExactAlarmIfNeeded() {
  const plugin = localNotifications();
  if (!plugin || exactAlarmSettingRequested) return;
  try {
    if ((await plugin.checkExactNotificationSetting()).exact_alarm !== 'granted') {
      exactAlarmSettingRequested = true;
      toast('请允许精确闹钟，以便准时提醒');
      await plugin.changeExactNotificationSetting();
      queueReminderSync();
    }
  } catch (error) { console.warn('无法打开精确提醒设置', error); }
}
async function ensureNotificationPermission() {
  const plugin = localNotifications();
  if (!plugin) return !window.Capacitor?.isNativePlatform?.();
  try {
    const status = await plugin.checkPermissions();
    if (status.display === 'granted') return true;
    const requested = await plugin.requestPermissions();
    if (requested.display === 'granted') return true;
    toast('请允许通知权限后再设置提醒');
  } catch (error) { console.warn(error); toast('无法启用系统通知'); }
  return false;
}
async function reconcileTodoNotifications() {
  const plugin = localNotifications();
  if (!plugin || !key || (await plugin.checkPermissions()).display !== 'granted') return;
  const pending = (await plugin.getPending()).notifications || [];
  const previous = pending.filter(notification => notification.extra?.surgeTodoId);
  if (previous.length) await plugin.cancel({ notifications: previous.map(notification => ({ id: notification.id })) });
  const upcoming = [...notes.values()].filter(note => !note.deleted && !note.purged && noteKind(note) === 'todo' && note.reminderAt && todoItems(note).some(item => !item.done))
    .flatMap(note => reminderOccurrences(note.reminderAt, note.reminderRule || 'none', !!note.reminderLunar).map(when => ({ note, when })))
    .sort((a, b) => a.when - b.when).slice(0, 500);
  const used = new Set();
  const notifications = upcoming.map(({ note, when }) => {
    let id = reminderNotificationId(note.id, when);
    while (used.has(id)) id = id === 2147483647 ? 1 : id + 1;
    used.add(id);
    return {
      id, title: note.title || '待办提醒', body: todoIsChecklist(note) ? '待办清单提醒' : note.title,
      schedule: { at: new Date(when), allowWhileIdle: true },
      autoCancel: true, extra: { surgeTodoId: note.id }
    };
  });
  for (let index = 0; index < notifications.length; index += 50) await plugin.schedule({ notifications: notifications.slice(index, index + 50) });
}
function queueReminderSync() {
  if (!localNotifications()) return;
  clearTimeout(notificationSyncTimer);
  notificationSyncTimer = setTimeout(() => {
    notificationSync = notificationSync.catch(() => {}).then(reconcileTodoNotifications).catch(error => console.warn('待办通知调度失败', error));
  }, 400);
}
function renderReminderCalendar() {
  const year = reminderMonth.getFullYear(), month = reminderMonth.getMonth();
  $('reminder-month-label').textContent = new Intl.DateTimeFormat(locale(), { year: 'numeric', month: 'long' }).format(reminderMonth);
  const days = [];
  for (let index = 0; index < (new Date(year, month, 1).getDay() + 6) % 7; index++) days.push(document.createElement('span'));
  const count = new Date(year, month + 1, 0).getDate();
  for (let day = 1; day <= count; day++) {
    const date = new Date(year, month, day);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reminder-day';
    button.classList.toggle('selected', date.toDateString() === reminderSelectedDate.toDateString());
    const number = document.createElement('span');
    number.textContent = String(day);
    button.append(number);
    if ($('reminder-lunar').checked) {
      const lunar = document.createElement('small');
      lunar.textContent = lunarDayLabel(date);
      button.append(lunar);
    }
    button.onclick = () => { reminderSelectedDate = date; renderReminderCalendar(); };
    days.push(button);
  }
  $('reminder-days').replaceChildren(...days);
}
function openReminderDialog() {
  const value = $('todo-reminder').value;
  const selected = value ? new Date(value) : new Date(Date.now() + 10 * 60000);
  selected.setSeconds(0, 0);
  reminderSelectedDate = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate());
  reminderMonth = new Date(selected.getFullYear(), selected.getMonth(), 1);
  $('reminder-time').value = `${String(selected.getHours()).padStart(2, '0')}:${String(selected.getMinutes()).padStart(2, '0')}`;
  $('reminder-repeat').value = todoReminderRule;
  $('reminder-lunar').checked = todoReminderLunar;
  $('reminder-clear').hidden = !value;
  $('reminder-error').textContent = '';
  renderReminderCalendar();
  $('reminder-dialog').showModal();
}
async function purgeNote(id) {
  if (!notes.get(id)?.deleted || notes.get(id)?.purged) return;
  const body = notes.get(id).body;
  const blobIds = [...body.matchAll(/surge-blob:([a-f0-9-]{36})/g)].map(match => match[1]).filter(blobId => ![...notes.values()].some(note => note.id !== id && !note.purged && note.body.includes(blobId)));
  await changeNote(id, 'purged', true);
  await pruneNote(db, id, blobIds);
  notes.get(id).title = '';
  notes.get(id).body = '';
  render();
}
function createForTab() { if (tab === 'todos') openTodoEditor(); else createNote(); }
function openEditor(id, sourceCard = null) {
  current = id;
  const note = notes.get(id);
  if (!note) return;
  if (noteKind(note) === 'todo') { openTodoEditor(id); return; }
  if (noteKind(note) === 'mindmap') { openMindmapEditor(null, null, id, true); return; }
  closeCategoryPanel();
  $('editor').hidden = false;
  $('editor').dataset.background = note.background || 'paper';
  $('background-strip').hidden = true;
  $('attachment-actions').hidden = true;
  $('format-toolbar').hidden = true;
  $('editor-toolbar').hidden = false;
  $('create-mindmap-inline').hidden = !(draftId === id && draftUntouched && !note.title && !note.body);
  $('note-title').value = note.title;
  resizeNoteTitle();
  clearAttachmentUrls();
  renderMarkdown(note.body, $('note-body'));
  bodyRange = null;
  $('edit-date').textContent = editDate(note.updatedAt, $('note-body').textContent.length);
  $('pin-note').textContent = note.pinned ? '取消置顶' : '置顶';
  $('delete-note').hidden = note.deleted;
  $('restore-note').hidden = !note.deleted;
  $('more-menu').hidden = true;
  updateFolderSelect(allFolders());
  updateEditorViewport();
  if (sourceCard && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const card = sourceCard.getBoundingClientRect();
    const box = $('editor').getBoundingClientRect();
    if (card.width && card.height && box.width && box.height) {
      const animation = transitionEditor(card, box, false);
      animation.finished.then(() => {
        cancelEditorTransition();
        if (current === id) renderAttachments(id);
      }, () => {});
      return;
    }
  }
  renderAttachments(id);
}
function cancelEditorTransition() {
  for (const animation of editorTransition) animation.cancel();
  editorTransition = [];
}
function transitionEditor(card, box, closing) {
  cancelEditorTransition();
  const editor = $('editor');
  // A small movement towards the card preserves the spatial cue without
  // clipping and repainting the whole editor on every animation frame.
  const x = Math.max(-32, Math.min(32, (card.left + card.width / 2 - box.left - box.width / 2) * .08));
  const y = Math.max(-32, Math.min(32, (card.top + card.height / 2 - box.top - box.height / 2) * .08));
  const resting = { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 };
  const departing = { transform: `translate3d(${x}px, ${y}px, 0) scale(.985)`, opacity: 0 };
  const shell = editor.animate(closing ? [resting, departing] : [departing, resting], {
    duration: closing ? 200 : 240,
    easing: closing ? 'ease-in' : 'cubic-bezier(.2, .8, .2, 1)',
    fill: 'forwards'
  });
  editorTransition.push(shell);
  return shell;
}
function closeEditor() {
  if (editorClosing) return;
  const id = current;
  discardDraft();
  current = null;
  render();
  const card = [...$('notes').querySelectorAll('.note-card')].find(item => item.dataset.noteId === id);
  const editor = $('editor');
  const box = editor.getBoundingClientRect();
  const target = card?.getBoundingClientRect();
  if (!target || !target.width || !target.height || !box.width || !box.height || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    cancelEditorTransition();
    editor.hidden = true;
    return;
  }
  editorClosing = true;
  const animation = transitionEditor(target, box, true);
  animation.finished.then(() => {
    editor.hidden = true;
    cancelEditorTransition();
    editorClosing = false;
  }, () => { editorClosing = false; });
}
function updateEditorViewport() {
  const viewport = window.visualViewport;
  $('editor').style.height = Math.min(viewport?.height || window.innerHeight, nativeVisibleHeight) + 'px';
  $('editor').style.top = (viewport?.offsetTop || 0) + 'px';
}
function updateTodoViewport() {
  if (!$('todo-dialog').open) return;
  const viewport = window.visualViewport;
  const visible = Math.min(viewport?.height || window.innerHeight, nativeVisibleHeight);
  $('todo-dialog').style.bottom = Math.max(0, window.innerHeight - visible - (viewport?.offsetTop || 0)) + 'px';
  $('todo-dialog').style.maxHeight = Math.min(visible, 760) + 'px';
}
window.surgeSetVisibleHeight = height => {
  nativeVisibleHeight = Number.isFinite(height) && height > 0 ? height : Infinity;
  updateEditorViewport();
  updateMindmapViewport();
  updateTodoViewport();
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
    const purgedIds = new Set(nextState ? [...nextState.notes.values()].filter(note => note.purged).map(note => note.id) : []);
    const oldBodies = new Map([...notes.values()].filter(note => purgedIds.has(note.id)).map(note => [note.id, note.body]));
    if (pending.length) await putOps(db, pending.map(op => ({ ...op, localPending: false })));
    if (fresh.length) await putOps(db, fresh.filter(op => !purgedIds.has(op.noteId) || op.field === 'purged'));
    for (const id of purgedIds) {
      const blobIds = [...(oldBodies.get(id) || '').matchAll(/surge-blob:([a-f0-9-]{36})/g)].map(match => match[1]).filter(blobId => ![...notes.values()].some(note => note.id !== id && !note.purged && note.body.includes(blobId)));
      await pruneNote(db, id, blobIds);
    }
    cursor = result.cursor;
    await putMeta(db, 'cursor', cursor);
    if (nextState) {
      notes = nextState.notes;
      clock = Math.max(clock, nextState.maxClock);
      render();
      queueReminderSync();
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
  if (localNotifications() && [...notes.values()].some(note => !note.deleted && !note.purged && noteKind(note) === 'todo' && note.reminderAt && todoItems(note).some(item => !item.done))) {
    ensureNotificationPermission().then(allowed => { if (allowed) queueReminderSync(); });
  } else queueReminderSync();
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
  const selection = window.getSelection();
  if (selection?.rangeCount && body.contains(selection.getRangeAt(0).commonAncestorContainer)) return selection.getRangeAt(0).cloneRange();
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
function focusIn(node, atStart = false) {
  if (!node.textContent && !node.querySelector('*')) node.replaceChildren(document.createElement('br'));
  const caret = document.createRange();
  caret.selectNodeContents(node);
  caret.collapse(atStart);
  focusRange(caret);
}
function leaveStructuredBlock(item, preserveContent = false) {
  const container = item.parentElement;
  const following = container.cloneNode(false);
  while (item.nextSibling) following.append(item.nextSibling);
  const paragraph = document.createElement('p');
  if (preserveContent) {
    const checkbox = item.querySelector(':scope > input[type="checkbox"]');
    if (checkbox) {
      checkbox.remove();
      if (item.firstChild?.nodeType === Node.TEXT_NODE && /^[\u00a0 ]/.test(item.firstChild.textContent)) item.firstChild.textContent = item.firstChild.textContent.slice(1);
    }
    while (item.firstChild) paragraph.append(item.firstChild);
  }
  container.after(paragraph);
  if (following.childNodes.length) paragraph.after(following);
  item.remove();
  if (!container.childNodes.length) container.remove();
  focusIn(paragraph, preserveContent);
  saveEditorBody();
}
function handleStructuredEdit(event, action) {
  if (composingBody || event.isComposing || event.target.closest('input')) return;
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const node = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
  const item = node?.closest('li, blockquote > p');
  const container = item?.parentElement;
  if (!item || !$('note-body').contains(item) || !container?.matches('ul, ol, blockquote')) return;
  const checkbox = item.querySelector(':scope > input[type="checkbox"]');
  const empty = !(item.textContent || '').replace(/\u00a0|\u200b/g, '').trim();
  const before = document.createRange();
  before.selectNodeContents(item);
  before.setEnd(range.startContainer, range.startOffset);
  const atStart = !(before.toString() || '').replace(/\u00a0|\u200b/g, '').trim();
  if (action === 'backspace') {
    if (!atStart) return;
    event.preventDefault();
    if (empty && item.previousElementSibling) {
      const previous = item.previousElementSibling;
      item.remove();
      focusIn(previous);
      saveEditorBody();
    } else leaveStructuredBlock(item, !empty);
    return;
  }
  if (empty) {
    event.preventDefault();
    leaveStructuredBlock(item);
    return;
  }
  event.preventDefault();
  const tail = document.createRange();
  tail.selectNodeContents(item);
  if (checkbox && range.startContainer === item && range.startOffset === 0) tail.setStartAfter(checkbox);
  else tail.setStart(range.startContainer, range.startOffset);
  const remainder = tail.extractContents();
  const next = document.createElement(item.tagName.toLowerCase());
  if (checkbox) {
    const nextCheckbox = document.createElement('input');
    nextCheckbox.type = 'checkbox';
    nextCheckbox.contentEditable = 'false';
    next.append(nextCheckbox, document.createTextNode('\u00a0'));
  }
  next.append(remainder);
  item.after(next);
  if (checkbox) {
    const spacer = next.childNodes[1];
    const caret = document.createRange();
    caret.setStart(spacer, spacer.length);
    caret.collapse(true);
    focusRange(caret);
  } else focusIn(next, true);
  saveEditorBody();
}
function applyFormat(kind) {
  if (!current) return;
  if (['bold', 'italic', 'underline', 'strike'].includes(kind)) {
    focusRange();
    document.execCommand(kind === 'strike' ? 'strikeThrough' : kind);
    saveEditorBody();
    return;
  }
  const body = $('note-body');
  const range = editorRange();
  const origin = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
  let item = origin?.closest('li, blockquote > p');
  let block = origin;
  while (block && block.parentElement !== body) block = block.parentElement;
  if (!block || block.matches('.rich-attachment, table')) return;
  if (kind.startsWith('align-')) {
    const target = item?.matches('blockquote > p') ? item : block;
    if (!target.matches('p, h1, h2, h3, h4, h5, h6')) return;
    if (kind === 'align-left') delete target.dataset.align;
    else target.dataset.align = kind.slice(6);
    focusIn(target);
  } else if (kind === 'divider') {
    const divider = document.createElement('hr');
    const paragraph = document.createElement('p');
    block.after(divider, paragraph);
    focusIn(paragraph);
  } else if (kind === 'quote') {
    if (item?.matches('blockquote > p')) { leaveStructuredBlock(item, true); return; }
    if (item?.matches('li')) { leaveStructuredBlock(item, true); return; }
    const quote = document.createElement('blockquote');
    const paragraph = document.createElement('p');
    while (block.firstChild) paragraph.append(block.firstChild);
    quote.append(paragraph);
    block.replaceWith(quote);
    focusIn(paragraph);
  } else if (kind === 'unordered' || kind === 'ordered') {
    const tag = kind === 'ordered' ? 'ol' : 'ul';
    if (item?.matches('li')) {
      if (item.parentElement.tagName.toLowerCase() === tag) { leaveStructuredBlock(item, true); return; }
      const replacement = document.createElement(tag);
      while (block.firstChild) replacement.append(block.firstChild);
      block.replaceWith(replacement);
      focusIn(item);
    } else {
      if (item?.matches('blockquote > p')) { leaveStructuredBlock(item, true); return; }
      const list = document.createElement(tag);
      const listItem = document.createElement('li');
      while (block.firstChild) listItem.append(block.firstChild);
      list.append(listItem);
      block.replaceWith(list);
      focusIn(listItem);
    }
  } else if (/^h[1-6]$/.test(kind)) {
    if (item) { leaveStructuredBlock(item, true); return; }
    const heading = document.createElement(block.tagName.toLowerCase() === kind ? 'p' : kind);
    while (block.firstChild) heading.append(block.firstChild);
    block.replaceWith(heading);
    focusIn(heading);
  }
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
let mindmapItems = [], mindmapTarget = null, mindmapActive = 0, mindmapMode = 'outline';
function outlineFromMindNote(note) {
  const items = [{ depth: 0, text: note?.title || '' }];
  for (const line of (note?.body || '').split('\n')) {
    const match = /^( *)(?:- )(.+)$/.exec(line);
    if (match) items.push({ depth: Math.max(1, Math.min(4, 1 + Math.floor(match[1].length / 2))), text: match[2] });
  }
  return items;
}
const mindNoteBody = items => items.slice(1).filter(item => item.text.trim()).map(item => `${'  '.repeat(Math.max(0, item.depth - 1))}- ${item.text.trim()}`).join('\n');
const mapViewIcon = '<svg viewBox="0 0 24 24"><circle cx="4" cy="12" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="M6 12h7V5h4m-4 7v7h4"/></svg>';
const outlineViewIcon = '<svg viewBox="0 0 24 24"><path d="M5 5h15M5 12h15M5 19h15"/><circle cx="2" cy="5" r=".5"/><circle cx="2" cy="12" r=".5"/><circle cx="2" cy="19" r=".5"/></svg>';
function updateMindmapViewport() {
  const dialog = $('mindmap-dialog');
  if (!dialog.open) return;
  const viewport = window.visualViewport;
  dialog.style.height = Math.min(viewport?.height || window.innerHeight, nativeVisibleHeight) + 'px';
  dialog.style.top = (viewport?.offsetTop || 0) + 'px';
}
function focusMindmap(index) {
  const input = $('mindmap-items').children[index]?.querySelector('input');
  input?.focus();
  input?.setSelectionRange(input.value.length, input.value.length);
}
function updateMindmapOutlineButtons() {
  const root = mindmapActive === 0;
  $('mindmap-add-sibling').disabled = root;
  $('mindmap-outdent').disabled = root || mindmapItems[mindmapActive]?.depth <= 1;
  $('mindmap-indent').disabled = root;
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
    input.onfocus = () => { mindmapActive = index; updateMindmapOutlineButtons(); };
    input.oninput = () => { item.text = input.value; };
    input.onkeydown = event => {
      if (event.key === 'Enter') { event.preventDefault(); addMindmapItem(index); }
      else if (event.key === 'Tab') { event.preventDefault(); shiftMindmapItem(index, event.shiftKey ? -1 : 1); }
      else if (event.key === 'Backspace' && !input.value && index > 0) {
        event.preventDefault(); deleteMindmapItem(index);
      } else if (event.key === 'ArrowUp' && index > 0 && input.selectionStart === 0) { event.preventDefault(); focusMindmap(index - 1); }
      else if (event.key === 'ArrowDown' && index < mindmapItems.length - 1 && input.selectionStart === input.value.length) { event.preventDefault(); focusMindmap(index + 1); }
    };
    row.append(dot, input);
    return row;
  }));
  updateMindmapOutlineButtons();
  if (focusIndex >= 0) focusMindmap(focusIndex);
}
function mindmapSubtreeEnd(index) {
  let end = index + 1;
  while (end < mindmapItems.length && mindmapItems[end].depth > mindmapItems[index].depth) end++;
  return end;
}
function addMindmapItem(after = mindmapActive, child = false) {
  if (!mindmapItems[after]) after = 0;
  if (after === 0) child = true;
  const index = child ? after + 1 : mindmapSubtreeEnd(after);
  const depth = child ? Math.min(4, mindmapItems[after].depth + 1) : mindmapItems[after].depth;
  mindmapItems.splice(index, 0, { depth, text: '' });
  mindmapActive = index;
  if (mindmapMode === 'map') { renderMindmapGraph(); editMindmapGraphNode(); }
  else renderMindmapItems(index);
}
function shiftMindmapItem(index, direction) {
  const item = mindmapItems[index];
  if (!item || index === 0) return;
  const nextDepth = Math.max(1, Math.min(4, mindmapItems[index - 1].depth + 1, item.depth + direction));
  const end = mindmapSubtreeEnd(index);
  const maxDescendantDepth = Math.max(...mindmapItems.slice(index, end).map(node => node.depth));
  const delta = Math.min(nextDepth - item.depth, 4 - maxDescendantDepth);
  for (let i = index; i < end; i++) mindmapItems[i].depth += delta;
  renderMindmapItems(index);
}
function deleteMindmapItem(index) {
  if (index === 0) return;
  mindmapItems.splice(index, mindmapSubtreeEnd(index) - index);
  mindmapActive = Math.max(0, Math.min(index - 1, mindmapItems.length - 1));
  if (mindmapMode === 'map') renderMindmapGraph();
  else renderMindmapItems(mindmapActive);
}
function renderMindmapGraph(center = false) {
  const view = $('mindmap-map-view');
  const nodes = mindmapItems.map((item, index) => {
    const depth = index ? Math.max(1, item.depth) : 0;
    let parent = -1;
    for (let i = index - 1; i >= 0; i--) if (mindmapItems[i].depth < depth) { parent = i; break; }
    return { index, depth, parent, text: item.text || (index ? '新主题' : '中心主题'), branch: 0, side: 0, x: 0, y: 0 };
  });
  let branches = 0;
  for (const node of nodes.slice(1)) {
    node.branch = node.parent === 0 ? branches++ : nodes[node.parent]?.branch || 0;
    node.side = node.branch % 2 === 0 ? -1 : 1;
  }
  const left = nodes.filter(node => node.side === -1);
  const right = nodes.filter(node => node.side === 1);
  const depth = Math.max(1, ...nodes.map(node => node.depth));
  const compact = view.clientWidth < 600;
  const nodeWidth = compact ? 98 : 144;
  const step = compact ? 126 : 180;
  const width = Math.max(view.clientWidth + (compact ? 60 : 280), nodeWidth + depth * step * 2 + 60);
  const height = Math.max(view.clientHeight + 140, 240 + Math.max(left.length, right.length) * 72);
  const rootX = width / 2 - nodeWidth / 2;
  const rootY = height / 2 - 24;
  nodes[0].x = rootX; nodes[0].y = rootY;
  for (const sideNodes of [left, right]) sideNodes.forEach((node, position) => {
    node.x = rootX + node.side * node.depth * step;
    node.y = rootY + (position - (sideNodes.length - 1) / 2) * 72;
  });
  const scene = $('mindmap-map-scene');
  scene.style.width = width + 'px';
  scene.style.height = height + 'px';
  scene.style.setProperty('--map-node-width', nodeWidth + 'px');
  const lines = $('mindmap-map-lines');
  lines.setAttribute('viewBox', `0 0 ${width} ${height}`);
  lines.setAttribute('width', width);
  lines.setAttribute('height', height);
  lines.replaceChildren(...nodes.filter(node => node.parent >= 0).map(node => {
    const parent = nodes[node.parent];
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const fromX = node.side < 0 ? parent.x : parent.x + nodeWidth;
    const toX = node.side < 0 ? node.x + nodeWidth : node.x;
    const middle = (fromX + toX) / 2;
    path.setAttribute('d', `M${fromX} ${parent.y + 24} H${middle} V${node.y + 24} H${toX}`);
    return path;
  }));
  $('mindmap-map-nodes').replaceChildren(...nodes.map(node => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mindmap-map-node' + (node.index === 0 ? ' root' : '') + (node.index === mindmapActive ? ' active' : '');
    button.style.left = node.x + 'px';
    button.style.top = node.y + 'px';
    button.dataset.index = node.index;
    button.textContent = node.text;
    button.setAttribute('aria-label', `${node.index ? '主题' : '中心主题'}：${node.text}`);
    button.onclick = () => { mindmapActive = node.index; renderMindmapGraph(); };
    button.ondblclick = () => { mindmapActive = node.index; renderMindmapGraph(); editMindmapGraphNode(); };
    return button;
  }));
  const active = nodes[mindmapActive];
  if (active) {
    const actions = document.createElement('div');
    actions.className = 'mindmap-node-actions';
    actions.style.left = Math.max(12, active.x - 42) + 'px';
    actions.style.top = Math.max(12, active.y - 55) + 'px';
    const add = document.createElement('button'); add.textContent = '添加子主题'; add.onclick = () => addMindmapItem(mindmapActive, true);
    const edit = document.createElement('button'); edit.textContent = '编辑'; edit.onclick = editMindmapGraphNode;
    actions.append(add, edit);
    if (mindmapActive > 0) {
      const remove = document.createElement('button'); remove.textContent = '删除'; remove.onclick = () => deleteMindmapItem(mindmapActive);
      actions.append(remove);
    }
    $('mindmap-map-nodes').append(actions);
    const plus = document.createElement('button');
    plus.className = 'mindmap-inline-add';
    plus.style.left = (active.side < 0 ? active.x - 28 : active.x + nodeWidth + 6) + 'px';
    plus.style.top = (active.y + 12) + 'px';
    plus.textContent = '+';
    plus.setAttribute('aria-label', '添加子主题');
    plus.onclick = () => addMindmapItem(mindmapActive, true);
    $('mindmap-map-nodes').append(plus);
  }
  $('mindmap-map-sibling').disabled = mindmapActive === 0;
  $('mindmap-delete-node').disabled = mindmapActive === 0;
  if (center) {
    view.scrollLeft = Math.max(0, (width - view.clientWidth) / 2);
    view.scrollTop = Math.max(0, (height - view.clientHeight) / 2);
  }
}
function editMindmapGraphNode() {
  const button = $('mindmap-map-nodes').querySelector(`[data-index="${mindmapActive}"]`);
  if (!button) return;
  const index = mindmapActive;
  const original = mindmapItems[index].text;
  const input = document.createElement('input');
  input.className = 'mindmap-map-node mindmap-map-input active' + (index === 0 ? ' root' : '');
  input.style.left = button.style.left;
  input.style.top = button.style.top;
  input.value = original;
  input.placeholder = index ? '新主题' : '中心主题';
  input.setAttribute('aria-label', '编辑主题文字');
  input.oninput = () => { mindmapItems[index].text = input.value; };
  input.onkeydown = event => {
    if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
    else if (event.key === 'Escape') { mindmapItems[index].text = original; input.blur(); }
  };
  input.onblur = () => { if (mindmapMode === 'map') renderMindmapGraph(); };
  button.replaceWith(input);
  input.focus();
  input.select();
}
function setMindmapMode(mode) {
  mindmapMode = mode;
  const map = mode === 'map';
  $('mindmap-outline-view').hidden = map;
  $('mindmap-outline-tools').hidden = map;
  $('mindmap-map-view').hidden = !map;
  $('mindmap-map-tools').hidden = !map;
  $('mindmap-view-title').textContent = map ? '思维导图' : '大纲';
  $('mindmap-view-toggle').innerHTML = map ? outlineViewIcon : mapViewIcon;
  $('mindmap-view-toggle').setAttribute('aria-label', map ? '切换到大纲' : '切换到思维导图');
  $('mindmap-view-toggle').title = map ? '切换到大纲' : '切换到思维导图';
  if (map) { document.activeElement?.blur(); renderMindmapGraph(); }
  else renderMindmapItems();
}
function openMindmapEditor(payload = null, card = null, noteId = current, standalone = false) {
  if (!noteId) return;
  document.activeElement?.blur();
  mindmapTarget = standalone ? { noteId, standalone: true } : card ? { card, noteId, payload } : null;
  mindmapItems = standalone ? outlineFromMindNote(notes.get(noteId)) : payload?.outline?.length ? payload.outline.map(item => ({ depth: Number(item.depth) || 0, text: String(item.text || '') })) : [{ depth: 0, text: '' }];
  mindmapItems[0].depth = 0;
  for (let i = 1; i < mindmapItems.length; i++) mindmapItems[i].depth = Math.max(1, Math.min(4, mindmapItems[i - 1].depth + 1, mindmapItems[i].depth));
  mindmapOriginal = mindmapState();
  mindmapActive = 0;
  setMindmapMode(standalone ? 'map' : 'outline');
  const note = notes.get(noteId);
  $('mindmap-more').hidden = !standalone || draftId === noteId;
  $('mindmap-more-menu').hidden = true;
  $('mindmap-pin-note').textContent = note?.pinned ? '取消置顶' : '置顶';
  $('mindmap-delete-note').hidden = !!note?.deleted;
  $('mindmap-restore-note').hidden = !note?.deleted;
  $('mindmap-map-view').tabIndex = -1;
  if (standalone) $('mindmap-map-view').setAttribute('autofocus', '');
  else $('mindmap-map-view').removeAttribute('autofocus');
  $('mindmap-dialog').showModal();
  updateMindmapViewport();
  if (standalone) { renderMindmapGraph(true); $('mindmap-map-view').tabIndex = -1; $('mindmap-map-view').focus({ preventScroll: true }); }
  else $('mindmap-cancel').focus({ preventScroll: true });
}
let mindmapOriginal = '';
const mindmapState = () => JSON.stringify(mindmapItems.map(item => [item.depth, item.text]));
function closeMindmapEditor() {
  if (mindmapState() !== mindmapOriginal && !confirm('思维导图有未保存的更改，确定放弃吗？')) return;
  $('mindmap-dialog').close();
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
initializePreferences();
function openPreference(kind) {
  const dialog = $('preference-dialog');
  const options = kind === 'language' ? [['zh-CN', '简体中文'], ['en', 'English']] : [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']];
  const selected = kind === 'language' ? locale() : (localStorage.getItem('surge-theme') || 'system');
  $('preference-dialog-title').textContent = t(kind === 'language' ? '语言' : '主题');
  $('preference-options').replaceChildren(...options.map(([value, label]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preference-option';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(value === selected));
    const text = document.createElement('span'); text.textContent = t(label);
    const check = document.createElement('span'); check.className = 'preference-check'; check.setAttribute('aria-hidden', 'true'); check.textContent = value === selected ? '✓' : '';
    button.append(text, check);
    button.onclick = () => {
      dialog.close();
      if (kind === 'language') { setLanguage(value); render(); }
      else setTheme(value);
    };
    return button;
  }));
  dialog.showModal();
}
$('language-select').onclick = () => openPreference('language');
$('theme-select').onclick = () => openPreference('theme');
$('preference-close').onclick = () => $('preference-dialog').close();
$('preference-dialog').onclick = event => { if (event.target === $('preference-dialog')) $('preference-dialog').close(); };
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
  const modal = [...document.querySelectorAll('dialog[open]')].at(-1);
  if (modal) {
    if (modal.id === 'record-dialog' && recorder?.state === 'recording') $('record-cancel').click();
    else if (modal.id === 'mindmap-dialog') closeMindmapEditor();
    else if (modal.id === 'drawing-dialog') closeDrawingEditor();
    else modal.close();
    return true;
  }
  if (!$('settings-panel').hidden) { closeSettings(); return true; }
  if (!$('history').hidden) { $('history').hidden = true; return true; }
  if (!$('editor').hidden) { $('back').click(); return true; }
  if (selectMode) { exitSelection(); render(); return true; }
  if (view === 'trash') { setView('all'); return true; }
  if (!$('category-panel').hidden) {
    if (categorySelectMode) { categorySelectMode = false; selectedCategories.clear(); renderCategoryPanel(allFolders()); }
    else closeCategoryPanel();
    return true;
  }
  return false;
};
$('new-note').onclick = createForTab;
$('fab').onclick = createForTab;
$('create-mindmap-inline').onclick = convertDraftToMindmap;
$('clear-trash').onclick = async () => {
  const ids = [...notes.values()].filter(note => note.deleted && !note.purged && !isFolderRecord(note)).map(note => note.id);
  if (!ids.length || !confirm(`清空回收站中的 ${ids.length} 项？`)) return;
  for (const id of ids) await purgeNote(id);
  render();
};
$('todo-close').onclick = () => $('todo-dialog').close();
$('todo-dialog').onclick = event => { if (event.target === $('todo-dialog')) $('todo-dialog').close(); };
$('todo-reminder-button').onclick = openReminderDialog;
$('reminder-prev').onclick = () => { reminderMonth = new Date(reminderMonth.getFullYear(), reminderMonth.getMonth() - 1, 1); renderReminderCalendar(); };
$('reminder-next').onclick = () => { reminderMonth = new Date(reminderMonth.getFullYear(), reminderMonth.getMonth() + 1, 1); renderReminderCalendar(); };
$('reminder-lunar').onchange = renderReminderCalendar;
$('reminder-cancel').onclick = () => $('reminder-dialog').close();
$('reminder-clear').onclick = () => {
  $('todo-reminder').value = '';
  todoReminderRule = 'none';
  todoReminderLunar = false;
  updateTodoDateText();
  $('reminder-dialog').close();
};
$('reminder-confirm').onclick = () => {
  const [hour, minute] = $('reminder-time').value.split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) { $('reminder-error').textContent = '选择提醒时间'; return; }
  const date = new Date(reminderSelectedDate.getFullYear(), reminderSelectedDate.getMonth(), reminderSelectedDate.getDate(), hour, minute);
  const rule = $('reminder-repeat').value;
  if (!reminderOccurrences(date.getTime(), rule, $('reminder-lunar').checked).length) { $('reminder-error').textContent = '选择未来的提醒时间'; return; }
  $('todo-reminder').value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  todoReminderRule = rule;
  todoReminderLunar = $('reminder-lunar').checked;
  updateTodoDateText();
  $('reminder-dialog').close();
};
$('todo-add-item').onclick = () => addTodoEditItem().querySelector('input[type=text]').focus();
$('todo-done').onclick = async () => {
  const items = [...$('todo-edit-items').children].map(row => ({ done: row.querySelector('input[type=checkbox]').checked, text: row.querySelector('input[type=text]').value.trim() })).filter(item => item.text);
  const checklist = items.length > 1 || (!$('todo-title').hidden && !!$('todo-title').value.trim() && $('todo-title').value.trim() !== items[0]?.text);
  const title = checklist ? ($('todo-title').value.trim() || '待办清单') : (items[0]?.text || '');
  if (!title) { $('todo-dialog').close(); return; }
  const id = editingTodoId || crypto.randomUUID();
  const when = $('todo-reminder').value ? new Date($('todo-reminder').value).getTime() : 0;
  if (when && !await ensureNotificationPermission()) return;
  if (noteKind(notes.get(id) || {}) !== 'todo' || !editingTodoId) await save(id, 'kind', 'todo');
  if (notes.get(id)?.title !== title) await changeNote(id, 'title', title);
  const body = todoBody(items);
  if (notes.get(id)?.body !== body) await changeNote(id, 'body', body);
  if ((notes.get(id)?.reminderAt || 0) !== when) await changeNote(id, 'reminderAt', when);
  if ((notes.get(id)?.reminderRule || 'none') !== (when ? todoReminderRule : 'none')) await changeNote(id, 'reminderRule', when ? todoReminderRule : 'none');
  if (!!notes.get(id)?.reminderLunar !== (when && todoReminderLunar)) await changeNote(id, 'reminderLunar', !!(when && todoReminderLunar));
  if (!notes.get(id)?.updatedAt) await changeNote(id, 'updatedAt', Date.now());
  if (checklist) todoExpanded.add(id); else todoExpanded.delete(id);
  $('todo-dialog').close();
  render();
  if (when) requestExactAlarmIfNeeded();
};
$('todo-delete').onclick = async () => { if (editingTodoId) await changeNote(editingTodoId, 'deleted', true); $('todo-dialog').close(); };
$('todo-restore').onclick = async () => { if (editingTodoId) await changeNote(editingTodoId, 'deleted', false); $('todo-dialog').close(); };
$('back').onclick = closeEditor;
$('batch-cancel').onclick = () => { exitSelection(); render(); };
$('batch-pin').onclick = async () => {
  const ids = [...selectedNotes];
  const pin = !ids.every(id => notes.get(id)?.pinned);
  for (const id of ids) await changeNote(id, 'pinned', pin);
  exitSelection(); render();
};
$('batch-move').onclick = () => openMoveDialog([...selectedNotes]);
$('batch-restore').onclick = async () => {
  for (const id of [...selectedNotes]) await changeNote(id, 'deleted', false);
  exitSelection(); render();
};
$('batch-delete').onclick = async () => {
  const ids = [...selectedNotes];
  if (view === 'trash') {
    if (!confirm(`彻底删除选中的 ${ids.length} 项？此操作无法撤销。`)) return;
    for (const id of ids) await purgeNote(id);
  } else for (const id of ids) await changeNote(id, 'deleted', true);
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
for (const id of ['show-format', 'hide-format']) {
  $(id).addEventListener('pointerdown', event => event.preventDefault());
}
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
$('mobile-folders').onclick = openCategoryPanel;
$('mobile-settings').onclick = showSettings;
$('layout-toggle').onclick = () => { layout = layout === 'list' ? 'grid' : 'list'; localStorage.setItem('surge-layout', layout); render(); };
$('category-back').onclick = () => {
  if (categorySelectMode) { categorySelectMode = false; selectedCategories.clear(); renderCategoryPanel(allFolders()); }
  else closeCategoryPanel();
};
$('category-select-toggle').onclick = () => {
  const folders = allFolders();
  if (!categorySelectMode) categorySelectMode = true;
  else if (selectedCategories.size === folders.length) selectedCategories.clear();
  else selectedCategories = new Set(folders);
  renderCategoryPanel(folders);
};
$('category-create').onclick = () => openFolderDialog();
$('category-edit').onclick = () => { if (selectedCategories.size === 1) openFolderDialog('rename', [...selectedCategories][0]); };
$('category-delete').onclick = async () => {
  const folders = [...selectedCategories];
  if (!folders.length || !confirm(`删除选中的 ${folders.length} 个分类？其中的笔记会移到未分类。`)) return;
  for (const folder of folders) await removeFolder(folder);
  categorySelectMode = false; selectedCategories.clear(); render();
};
$('category-pin').onclick = async () => {
  const folders = [...selectedCategories];
  if (!folders.length) return;
  const pin = !folders.every(categoryPinned);
  for (const folder of folders) await setCategoryPinned(folder, pin);
  categorySelectMode = false; selectedCategories.clear(); render();
};
$('folder-manage-close').onclick = () => $('folder-manage-dialog').close();
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
$('search').onfocus = closeCategoryPanel;
$('search').oninput = event => { query = event.target.value.toLowerCase().trim(); render(); };
document.querySelectorAll('.nav').forEach(button => button.onclick = () => setView(button.dataset.view));
document.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => setTab(button.dataset.tab));
$('add-folder').onclick = () => openFolderDialog();
let composingTitle = false, composingBody = false;
function resizeNoteTitle() {
  const title = $('note-title');
  title.style.height = 'auto';
  title.style.height = title.scrollHeight + 'px';
}
$('note-title').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) event.preventDefault();
});

function applyMarkdownShortcut() {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return false;
  const caret = selection.getRangeAt(0);
  const anchor = caret.startContainer;
  const element = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
  const block = element?.closest('p, div, li');
  const body = $('note-body');
  if (!block || !body.contains(block)) return false;

  // Map DOM positions to text offsets, treating soft line breaks as line boundaries.
  const points = [];
  let text = '';
  const walk = node => {
    if (node.nodeType === Node.TEXT_NODE) {
      for (let i = 0; i < node.length; i++) { points.push([node, i]); text += node.data[i]; }
    } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
      const index = [...node.parentNode.childNodes].indexOf(node);
      points.push([node.parentNode, index]); text += '\n';
    } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName !== 'INPUT') {
      node.childNodes.forEach(walk);
    }
  };
  walk(block);
  const before = document.createRange();
  before.selectNodeContents(block);
  before.setEnd(caret.startContainer, caret.startOffset);
  const prefixFragment = before.cloneContents();
  const prefixText = node => node.nodeType === Node.TEXT_NODE ? node.data : node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR' ? '\n' : [...node.childNodes].map(prefixText).join('');
  const offset = prefixText(prefixFragment).length;
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const prefix = text.slice(lineStart, offset).replace(/\u00a0/g, ' ');
  const list = /^([-*+]|\d+[.)]) $/.exec(prefix);
  const task = /^\[([ xX])\] $/.exec(prefix);
  const heading = /^(#{1,6}) $/.exec(prefix);
  const quote = prefix === '> ';
  if (block.tagName === 'LI' && task && lineStart === 0 && !block.querySelector('input')) {
    const marker = document.createRange();
    marker.setStart(...points[0]); marker.setEnd(caret.startContainer, caret.startOffset);
    marker.deleteContents();
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.contentEditable = 'false'; checkbox.checked = task[1].toLowerCase() === 'x';
    block.prepend(checkbox, document.createTextNode(' '));
    const next = document.createRange(); next.setStart(block.childNodes[1], 1); next.collapse(true); focusRange(next);
    return true;
  }
  if (block.matches('p, div') && block.parentElement === body && (list || heading || quote)) {
    const markerStart = points[lineStart];
    if (!markerStart) return false;
    const lineEnd = text.indexOf('\n', offset);
    const tail = document.createRange();
    tail.setStart(caret.startContainer, caret.startOffset);
    if (lineEnd >= 0) tail.setEnd(...points[lineEnd]); else tail.setEnd(block, block.childNodes.length);
    const content = tail.extractContents();
    const marker = document.createRange(); marker.setStart(...markerStart); marker.setEnd(caret.startContainer, caret.startOffset); marker.deleteContents();
    // Split other soft lines into separate paragraphs around the transformed line.
    const afterRange = document.createRange(); afterRange.setStart(caret.startContainer, caret.startOffset); afterRange.setEnd(block, block.childNodes.length);
    const after = afterRange.extractContents();
    if (after.firstChild?.nodeName === 'BR') after.firstChild.remove();
    if (block.lastChild?.nodeName === 'BR') block.lastChild.remove();
    const replacement = document.createElement(list ? (/^\d/.test(list[1]) ? 'ol' : 'ul') : heading ? `h${heading[1].length}` : 'blockquote');
    if (list && replacement.tagName === 'OL') replacement.start = parseInt(list[1], 10);
    const target = list ? document.createElement('li') : quote ? document.createElement('p') : replacement;
    target.append(content);
    if (target !== replacement) replacement.append(target);
    block.after(replacement);
    if (after.childNodes.length) { const following = document.createElement('p'); following.append(after); replacement.after(following); }
    if (!block.textContent && !block.querySelector('br, img, input')) block.remove();
    focusIn(target, true);
    return true;
  }
  if (block.matches('p, div') && block.parentElement === body && offset === text.length && lineStart === 0 && /(?:\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)]+\))$/.test(prefix)) {
    renderInlineMarkdown(prefix, block);
    focusIn(block);
    return true;
  }
  return false;
}
$('note-title').addEventListener('compositionstart', () => { composingTitle = true; });
$('note-title').addEventListener('compositionend', event => { composingTitle = false; if (current) { if (draftId === current && event.target.value) { draftUntouched = false; $('create-mindmap-inline').hidden = true; } changeNote(current, 'title', event.target.value); } });
$('note-body').addEventListener('compositionstart', () => { composingBody = true; });
$('note-body').addEventListener('compositionend', () => { composingBody = false; if (draftId === current && $('note-body').textContent.trim()) { draftUntouched = false; $('create-mindmap-inline').hidden = true; } applyMarkdownShortcut(); saveEditorBody(); });
function removeHeadingAtStart(event) {
  if (composingBody || event.isComposing) return false;
  const selection = window.getSelection();
  const range = selection?.rangeCount && selection.isCollapsed ? selection.getRangeAt(0) : null;
  const element = range && (range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement);
  const heading = element?.closest('h1, h2, h3, h4, h5, h6');
  if (heading?.parentElement !== $('note-body')) return false;
  const before = document.createRange();
  before.selectNodeContents(heading);
  before.setEnd(range.startContainer, range.startOffset);
  if (before.toString()) return false;
  event.preventDefault();
  const paragraph = document.createElement('p');
  while (heading.firstChild) paragraph.append(heading.firstChild);
  heading.replaceWith(paragraph);
  focusIn(paragraph, true);
  saveEditorBody();
  return true;
}
$('note-body').addEventListener('keydown', event => {
  if (event.key === 'Backspace' && removeHeadingAtStart(event)) return;
  if (event.key === 'Enter' && !event.shiftKey) handleStructuredEdit(event, 'enter');
  else if (event.key === 'Backspace') handleStructuredEdit(event, 'backspace');
});
$('note-body').addEventListener('beforeinput', event => {
  if (event.inputType === 'insertParagraph') handleStructuredEdit(event, 'enter');
  else if (event.inputType === 'deleteContentBackward' && !removeHeadingAtStart(event)) handleStructuredEdit(event, 'backspace');
});
document.addEventListener('selectionchange', () => {
  const selection = window.getSelection();
  if (selection.rangeCount && $('note-body').contains(selection.anchorNode)) bodyRange = selection.getRangeAt(0).cloneRange();
});
$('note-body').addEventListener('change', event => { if (event.target.matches('input[type="checkbox"]')) saveEditorBody(); });
$('note-title').oninput = event => { if (!composingTitle && /[\r\n]/.test(event.target.value)) event.target.value = event.target.value.replace(/[\r\n]+/g, ' '); resizeNoteTitle(); if (current && !composingTitle) { if (draftId === current && event.target.value) { draftUntouched = false; $('create-mindmap-inline').hidden = true; } changeNote(current, 'title', event.target.value); } };
$('note-body').oninput = () => { if (current && !composingBody) { if (draftId === current && $('note-body').textContent.trim()) { draftUntouched = false; $('create-mindmap-inline').hidden = true; } applyMarkdownShortcut(); saveEditorBody(); } };
$('note-folder').onclick = openNoteFolderDialog;
$('note-folder-close').onclick = () => $('note-folder-dialog').close();
$('note-folder-dialog').onclick = event => { if (event.target === $('note-folder-dialog')) $('note-folder-dialog').close(); };
$('note-folder-create').onclick = () => {
  const id = current;
  $('note-folder-dialog').close();
  if (id) openFolderDialog('create', '', id);
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
document.querySelectorAll('[data-insert]').forEach(button => {
  button.addEventListener('pointerdown', event => { if (['image', 'drawing', 'mindmap'].includes(button.dataset.insert)) event.preventDefault(); });
  button.onclick = () => {
    const action = button.dataset.insert;
    if (['image', 'drawing', 'mindmap'].includes(action)) document.activeElement?.blur();
    if (action === 'text') focusRange();
    else if (action === 'task') insertTask();
    else if (action === 'table') insertBlock(tableNode());
    else if (action === 'image') $('image-source-dialog').showModal();
    else if (action === 'file') $('pick-file').click();
    else if (action === 'audio') $('record-dialog').showModal();
    else if (action === 'drawing') openDrawingEditor();
    else if (action === 'mindmap') openMindmapEditor();
  };
});
$('image-from-album').onclick = () => { $('image-source-dialog').close(); $('pick-image').click(); };
$('image-from-camera').onclick = () => { $('image-source-dialog').close(); $('pick-camera').click(); };
$('image-source-cancel').onclick = () => $('image-source-dialog').close();
$('mindmap-cancel').onclick = closeMindmapEditor;
$('mindmap-more').onclick = () => $('mindmap-more-menu').hidden = !$('mindmap-more-menu').hidden;
$('mindmap-history-note').onclick = () => { $('mindmap-dialog').close(); showHistory(); };
$('mindmap-pin-note').onclick = async () => {
  if (!current) return;
  await changeNote(current, 'pinned', !notes.get(current).pinned);
  $('mindmap-pin-note').textContent = notes.get(current).pinned ? '取消置顶' : '置顶';
  $('mindmap-more-menu').hidden = true;
};
$('mindmap-move-note').onclick = () => { $('mindmap-more-menu').hidden = true; openMoveDialog([current]); };
$('mindmap-delete-note').onclick = async () => {
  if (current) await changeNote(current, 'deleted', true);
  $('mindmap-dialog').close(); current = null; render();
};
$('mindmap-restore-note').onclick = async () => {
  if (current) await changeNote(current, 'deleted', false);
  $('mindmap-dialog').close(); current = null; render();
};
$('mindmap-add').onclick = () => addMindmapItem(mindmapActive, mindmapActive === 0);
$('mindmap-add-sibling').onclick = () => addMindmapItem(mindmapActive);
$('mindmap-add-child').onclick = () => addMindmapItem(mindmapActive, true);
$('mindmap-indent').onclick = () => shiftMindmapItem(mindmapActive, 1);
$('mindmap-outdent').onclick = () => shiftMindmapItem(mindmapActive, -1);
$('mindmap-view-toggle').onclick = () => setMindmapMode(mindmapMode === 'outline' ? 'map' : 'outline');
$('mindmap-edit-node').onclick = editMindmapGraphNode;
$('mindmap-map-sibling').onclick = () => addMindmapItem(mindmapActive);
$('mindmap-map-child').onclick = () => addMindmapItem(mindmapActive, true);
$('mindmap-delete-node').onclick = () => deleteMindmapItem(mindmapActive);
$('mindmap-save').onclick = async () => {
  if (!mindmapItems[0]?.text.trim()) { toast('输入中心主题'); return; }
  const outline = mindmapItems.filter(item => item.text.trim()).map((item, index) => ({ depth: index ? Math.max(1, item.depth) : 0, text: item.text.trim() }));
  if (mindmapTarget?.standalone) {
    const id = mindmapTarget.noteId;
    if (notes.get(id)?.title !== outline[0].text) await changeNote(id, 'title', outline[0].text);
    const body = mindNoteBody(outline);
    if (notes.get(id)?.body !== body) await changeNote(id, 'body', body);
    $('mindmap-dialog').close();
    mindmapTarget = null;
    current = null;
    render();
    return;
  }
  const data = bytesToUrl(new TextEncoder().encode(outlineToSvg(outline)));
  const payload = { kind: 'mindmap', name: '思维导图.svg', mime: 'image/svg+xml', data, outline, caption: mindmapTarget?.payload?.caption || '', scale: mindmapTarget?.payload?.scale || 1 };
  $('mindmap-dialog').close();
  if (mindmapTarget?.card?.isConnected) await replaceAttachmentPayload(mindmapTarget.card, payload);
  else await storePayload(payload, mindmapTarget?.noteId || current);
  mindmapTarget = null;
};
$('mindmap-dialog').addEventListener('close', () => {
  if (mindmapTarget?.standalone && draftId === mindmapTarget.noteId) { discardDraft(); current = null; render(); }
  mindmapTarget = null;
});
// Native back and Escape both pass through the same unsaved-change guard.
$('mindmap-dialog').addEventListener('cancel', event => { event.preventDefault(); closeMindmapEditor(); });
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
function closeDrawingEditor() {
  if (drawingHistory[drawingHistoryIndex] !== drawingHistory[0] && !confirm('画板有未保存的更改，确定放弃吗？')) return;
  $('drawing-dialog').close();
}
$('drawing-dialog').addEventListener('cancel', event => { event.preventDefault(); closeDrawingEditor(); });
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
$('drawing-cancel').onclick = closeDrawingEditor;
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
window.visualViewport?.addEventListener('resize', () => { updateEditorViewport(); updateMindmapViewport(); updateTodoViewport(); });
window.visualViewport?.addEventListener('scroll', () => { updateEditorViewport(); updateMindmapViewport(); updateTodoViewport(); });
window.addEventListener('online', sync);
window.addEventListener('popstate', () => { $('settings-panel').hidden = true; });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { sync(); queueReminderSync(); } });
setInterval(sync, 30000);
await bootstrap();
