const idPattern = '[a-f0-9-]{36}';
const blobPattern = new RegExp(`(!?)\\[([^\\]\\n]*)\\]\\(surge-blob:(${idPattern})\\)`, 'g');
const safeSegment = value => {
  const segment = String(value || '').replace(/[^\p{L}\p{N}._ -]/gu, '_').trim().slice(0, 80);
  return !segment || segment === '.' || segment === '..' ? '未命名笔记' : segment;
};

export function normalizeOutputFolder(value) {
  const folder = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  const parts = folder.split('/');
  if (!folder || parts.some(part => !part || part.startsWith('.') || /[\\:*?"<>|\[\]#^]/.test(part) || part !== part.trim())) {
    throw new Error('请输入库内文件夹路径，例如：资料/Surge；不能使用隐藏目录或特殊字符');
  }
  return parts.join('/');
}

export const isInside = (path, folder) => path.startsWith(`${folder}/`);
export const activeNotes = notes => [...notes].filter(note => !note.deleted && !note.purged && (note.kind || 'note') === 'note' && note.body !== 'surge-internal-category-record-v1');
export const attachmentIds = notes => new Set(activeNotes(notes).flatMap(note => [...String(note.body || '').matchAll(/surge-blob:([a-f0-9-]{36})/g)].map(match => match[1])));
export const attachmentPath = (folder, id, extension) => `${normalizeOutputFolder(folder)}/_attachments/${id}.${extension}`;
export const isManagedAttachment = path => /\/_attachments\/[a-f0-9-]{36}\.[a-z0-9]+$/.test(path);
const mimeExtensions = {
  'image/png':'png', 'image/jpeg':'jpg', 'image/gif':'gif', 'image/webp':'webp', 'image/avif':'avif', 'image/svg+xml':'svg',
  'application/pdf':'pdf', 'audio/webm':'webm', 'audio/mpeg':'mp3', 'audio/mp4':'m4a', 'audio/wav':'wav', 'audio/ogg':'ogg',
  'video/mp4':'mp4', 'video/webm':'webm', 'text/plain':'txt'
};
const safeExtensions = new Set(['png','jpg','jpeg','gif','webp','avif','svg','heic','pdf','webm','mp3','m4a','wav','ogg','mp4','txt','md','csv','zip','docx','xlsx','pptx']);
export const extensionFor = payload => {
  const mime = String(payload.mime || '').split(';')[0].toLowerCase();
  if (mimeExtensions[mime]) return mimeExtensions[mime];
  const named = String(payload.name || '').match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase();
  return safeExtensions.has(named) ? named : 'bin';
};

export const notePath = (note, folder = 'Surge', number = 1) => {
  const category = String(note.folder || '').split('/').filter(Boolean).map(safeSegment);
  return [normalizeOutputFolder(folder), ...category, `${safeSegment(note.title)}${number > 1 ? ` (${number})` : ''}.md`].join('/');
};

const relativePath = (from, to) => {
  const source = from.split('/').slice(0, -1);
  const target = to.split('/');
  while (source.length && target.length && source[0] === target[0]) { source.shift(); target.shift(); }
  return [...source.map(() => '..'), ...target].join('/');
};

export const renderNote = (note, folder = 'Surge', assets = new Map(), path = notePath(note, folder)) => {
  const body = String(note.body || '').replace(blobPattern, (original, image, label, id) => {
    const asset = assets.get(id);
    if (!asset) return original;
    const name = label.replace(/[\\[\]]/g, '\\$&');
    return `${image}[${name}](<${relativePath(path, asset.path)}>)`;
  });
  return `---\nsurge-id: ${note.id}\n---\n# ${note.title || '未命名笔记'}\n\n${body}${body ? '\n' : ''}`;
};

// Only files carrying a Surge ID inside a previously selected output folder are owned.
export function planSync(notes, files, folder = 'Surge', assets = new Map()) {
  const active = activeNotes(notes).sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map();
  for (const file of files) {
    if (!file.id) continue;
    if (!byId.has(file.id)) byId.set(file.id, []);
    byId.get(file.id).push(file);
  }

  // Keep an existing title-only filename where possible. Other notes take the
  // first available numbered name; IDs remain in frontmatter for stable matching.
  const pathKey = path => path.normalize('NFC').toLowerCase();
  const reserved = new Set(files.filter(file => !file.id).map(file => pathKey(file.path)));
  const paths = new Map();
  for (const note of active) {
    const base = notePath(note, folder);
    const stem = base.slice(0, -3);
    const normalizedStem = stem.normalize('NFC');
    const current = (byId.get(note.id) || []).find(file => {
      const path = file.path.normalize('NFC');
      return path === base.normalize('NFC') || (path.startsWith(`${normalizedStem} (`) && /^\d+\)\.md$/.test(path.slice(normalizedStem.length + 2)));
    });
    if (current && !reserved.has(pathKey(current.path))) { paths.set(note.id, current.path); reserved.add(pathKey(current.path)); }
  }
  for (const note of active) {
    if (paths.has(note.id)) continue;
    let number = 1, path;
    do { path = notePath(note, folder, number++); } while (reserved.has(pathKey(path)));
    paths.set(note.id, path); reserved.add(pathKey(path));
  }

  const desired = new Map();
  for (const note of active) {
    const path = paths.get(note.id);
    desired.set(note.id, { path, content: renderNote(note, folder, assets, path) });
  }

  const removes = [], moves = [], writes = [], creates = [];
  for (const [id, group] of byId) {
    const target = desired.get(id);
    if (!target) { removes.push(...group.map(file => file.path)); continue; }
    const keep = group.find(file => file.path === target.path) || group[0];
    removes.push(...group.filter(file => file !== keep).map(file => file.path));
    if (keep.path !== target.path) moves.push({ from: keep.path, to: target.path });
    if (keep.content !== target.content) writes.push({ path: target.path, content: target.content });
    desired.delete(id);
  }
  for (const target of desired.values()) creates.push(target);

  const vacated = new Set([...removes, ...moves.map(move => move.from)]);
  const occupied = new Set(files.map(file => file.path));
  for (const target of [...moves.map(move => move.to), ...creates.map(create => create.path)]) {
    if (occupied.has(target) && !vacated.has(target)) throw new Error(`目标路径已被其他文件占用：${target}`);
  }
  return { removes, moves, writes, creates };
}

export function planAttachments(assets, files) {
  const desired = new Map([...assets.values()].map(asset => [asset.path, asset]));
  const removes = [], writes = [], creates = [];
  for (const file of files) {
    const asset = desired.get(file.path);
    if (!asset) { removes.push(file.path); continue; }
    if (!bytesEqual(file.bytes, asset.bytes)) writes.push(asset);
    desired.delete(file.path);
  }
  creates.push(...desired.values());
  return { removes, writes, creates };
}

const bytesEqual = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
