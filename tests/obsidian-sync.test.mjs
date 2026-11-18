import test from 'node:test';
import assert from 'node:assert/strict';
import { planSync, planAttachments, notePath, renderNote, attachmentIds, attachmentPath, extensionFor, normalizeOutputFolder } from '../obsidian/sync-plan.mjs';
import { exchange } from '../web/core.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const oldId = '22222222-2222-4222-8222-222222222222';
const note = { id, title:'正文', body:'最新内容', folder:'工作', deleted:false, purged:false };

test('Obsidian mirror removes source-deleted and obsolete managed notes', () => {
  const removed = { ...note, deleted:true };
  const files = [
    { path:notePath(note), id, content:renderNote(note) },
    { path:`Surge/旧笔记--${oldId}.md`, id:oldId, content:'旧内容' },
    { path:'Surge/个人.md', id:null, content:'本地笔记' }
  ];
  const plan = planSync([removed], files);
  assert.deepEqual(plan.removes, [files[0].path,files[1].path]);
  assert.deepEqual(plan.creates, []);
});

test('Obsidian edits are overwritten and local deletion is restored', () => {
  const path = notePath(note);
  assert.deepEqual(planSync([note], [{ path, id, content:'本地修改' }]).writes, [{ path, content:renderNote(note) }]);
  assert.deepEqual(planSync([note], []).creates, [{ path, content:renderNote(note) }]);
});

test('source restore recreates a note removed after source deletion', () => {
  assert.deepEqual(planSync([note], []).creates, [{ path:notePath(note), content:renderNote(note) }]);
  assert.deepEqual(planSync([{ ...note, purged:true }], [{ path:notePath(note), id, content:renderNote(note) }]).removes, [notePath(note)]);
});

test('renamed or duplicated managed notes converge on one source path', () => {
  const target=notePath(note);
  const plan=planSync([note], [
    { path:`Surge/旧标题--${id}.md`, id, content:'旧内容' },
    { path:'Surge/副本.md', id, content:'副本' }
  ]);
  assert.deepEqual(plan.removes, ['Surge/副本.md']);
  assert.deepEqual(plan.moves, [{ from:`Surge/旧标题--${id}.md`, to:target }]);
  assert.deepEqual(plan.writes, [{ path:target, content:renderNote(note) }]);
});

test('filenames use titles and leave an unmanaged same-name file untouched', () => {
  assert.equal(notePath(note),'Surge/工作/正文.md');
  const plan=planSync([note], [{ path:notePath(note), id:null, content:'个人内容' }]);
  assert.deepEqual(plan.creates,[{ path:'Surge/工作/正文 (2).md', content:renderNote(note,'Surge',new Map(),'Surge/工作/正文 (2).md') }]);
  assert.deepEqual(plan.removes,[]);
});

test('todos and mindmaps are excluded, including their attachments', () => {
  const blob='33333333-3333-4333-8333-333333333333';
  const todo={ ...note, kind:'todo', body:`- [ ] 完成\n![图](surge-blob:${blob})` };
  const mindmap={ ...note, id:oldId, kind:'mindmap' };
  const files=[{ path:`Surge/工作/写数学作业--${id}.md`, id, content:'旧待办' }];
  const plan=planSync([todo,mindmap],files);
  assert.deepEqual(plan.removes,[files[0].path]);
  assert.deepEqual(plan.creates,[]);
  assert.deepEqual([...attachmentIds([todo,mindmap])],[]);
});

test('same-title notes use stable numbered names without IDs', () => {
  const second={ ...note, id:oldId };
  const first=planSync([note,second],[]);
  assert.deepEqual(first.creates.map(item=>item.path),['Surge/工作/正文.md','Surge/工作/正文 (2).md']);
  const files=first.creates.map((item,index)=>({ ...item, id:index ? oldId : id }));
  const next=planSync([note,second],files);
  assert.deepEqual(next.moves,[]);
  assert.deepEqual(next.creates,[]);
});

test('changing the output folder moves notes and uses relative attachment links', () => {
  const imageId='33333333-3333-4333-8333-333333333333';
  const withImage={ ...note, body:`图片\n![截图](surge-blob:${imageId})` };
  const assets=new Map([[imageId,{ path:attachmentPath('资料/Surge',imageId,'png'), bytes:new Uint8Array([1,2]) }]]);
  const plan=planSync([withImage],[{ path:notePath(note), id, content:renderNote(note) }],'资料/Surge',assets);
  assert.deepEqual(plan.moves,[{ from:notePath(note), to:notePath(withImage,'资料/Surge') }]);
  assert.match(plan.writes[0].content,/!\[截图\]\(<\.\.\/_attachments\/33333333-3333-4333-8333-333333333333\.png>\)/);
  assert.deepEqual([...attachmentIds([withImage])],[imageId]);
});

test('unused or locally changed attachment files are reconciled', () => {
  const imageId='33333333-3333-4333-8333-333333333333';
  const oldPath=attachmentPath('Surge',imageId,'png');
  const target=attachmentPath('资料/Surge',imageId,'png');
  const bytes=new Uint8Array([1,2,3]);
  const plan=planAttachments(new Map([[imageId,{ path:target, bytes }]]),[
    { path:oldPath, bytes },
    { path:target, bytes:new Uint8Array([9]) }
  ]);
  assert.deepEqual(plan.removes,[oldPath]);
  assert.deepEqual(plan.writes,[{ path:target, bytes }]);
  assert.deepEqual(plan.creates,[]);
  assert.deepEqual(planAttachments(new Map(),[{ path:target, bytes }]).removes,[target]);
});

test('output folder and attachment extension reject unsafe paths', () => {
  for(const value of ['','.obsidian/plugins','../Surge','Surge\\old']) assert.throws(()=>normalizeOutputFolder(value));
  assert.equal(normalizeOutputFolder('资料/Surge/'),'资料/Surge');
  assert.equal(extensionFor({ mime:'image/png', name:'picture.exe' }),'png');
  assert.equal(extensionFor({ mime:'application/octet-stream', name:'file.exe' }),'bin');
});

test('download-only exchange sends no operations to the server', async () => {
  const previous=globalThis.fetch;
  const requests=[];
  globalThis.fetch=async (url,options={})=>{
    requests.push({ url, method:options.method || 'GET' });
    return { ok:true, json:async()=>({ ops:[], cursor:0, hasMore:false }) };
  };
  try {
    await exchange('https://example.test','token',0,[]);
    assert.deepEqual(requests, [{ url:'https://example.test/api/ops?after=0', method:'GET' }]);
  } finally { globalThis.fetch=previous; }
});
