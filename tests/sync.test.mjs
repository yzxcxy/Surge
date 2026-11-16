import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { deriveKey, makeOp, materialize } from '../web/core.mjs';

test('encrypted offline edits converge after server exchange and survive restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'surge-test-'));
  const token = 'test-token-with-at-least-24-characters';
  const port = 19000 + Math.floor(Math.random() * 10000);
  let process;
  const start = async () => {
    process = spawn('node', ['server/index.mjs'], { cwd:new URL('../', import.meta.url).pathname, env:{ ...globalThis.process.env, SURGE_DATA_DIR:dir, SURGE_TOKEN:token, PORT:String(port) }, stdio:'ignore' });
    for(let i=0;i<80;i++) { try { const r=await fetch(`http://127.0.0.1:${port}/api/health`); if(r.ok) return; } catch {} await new Promise(r=>setTimeout(r,50)); }
    throw new Error('server did not start');
  };
  const stop = async () => { if(process && process.exitCode===null) { process.kill(); await new Promise(r=>process.once('exit',r)); } };
  try {
    await start();
    const base=`http://127.0.0.1:${port}`;
    const info=await (await fetch(base+'/api/info')).json();
    const key=await deriveKey('correct horse battery staple',info.salt);
    const actorA=crypto.randomUUID(), actorB=crypto.randomUUID(), noteId=crypto.randomUUID();
    const a=[await makeOp(key,actorA,1,noteId,'title','离线标题'),await makeOp(key,actorA,2,noteId,'body','A 的正文')];
    const b=[await makeOp(key,actorB,1,noteId,'folder','工作'),await makeOp(key,actorB,2,noteId,'pinned',true),await makeOp(key,actorB,3,noteId,'background','sage'),await makeOp(key,actorB,4,noteId,'kind','mindmap'),await makeOp(key,actorB,5,noteId,'reminderAt',1763300000000),await makeOp(key,actorB,6,noteId,'purged',true)];
    const headers={ Authorization:'Bearer '+token,'Content-Type':'application/json' };
    assert.equal((await fetch(base+'/api/ops',{ method:'POST',headers,body:JSON.stringify({ops:[{...a[0],plaintext:'must not persist'},a[1]]}) })).status,200);
    assert.equal((await fetch(base+'/api/ops',{ method:'POST',headers,body:JSON.stringify({ops:b}) })).status,200);
    await fetch(base+'/api/ops',{ method:'POST',headers,body:JSON.stringify({ops:a}) });
    const page=await (await fetch(base+'/api/ops?after=0',{headers})).json();
    assert.equal(page.ops.length,8,'duplicate upload should be idempotent');
    assert.equal(JSON.stringify(page).includes('must not persist'),false,'extra fields must be stripped');
    assert.equal(page.cursor,8);
    const left=await materialize([...a,...page.ops],key);
    const right=await materialize([...b,...page.ops],key);
    assert.equal(left.notes.get(noteId).title,right.notes.get(noteId).title);
    assert.equal(left.notes.get(noteId).body,'','purged notes must not retain body in memory');
    assert.equal(right.notes.get(noteId).folder,'工作');
    assert.equal(right.notes.get(noteId).pinned,true);
    assert.equal(left.notes.get(noteId).background,'sage');
    assert.equal(right.notes.get(noteId).background,'sage');
    assert.equal(right.notes.get(noteId).kind,'mindmap');
    assert.equal(right.notes.get(noteId).reminderAt,1763300000000);
    assert.equal(right.notes.get(noteId).purged,true);
    assert.equal((await fetch(base+'/api/ops')).status,401);
    assert.equal(JSON.stringify(page).includes('A 的正文'),false,'server should only receive ciphertext');
    await stop(); await start();
    const afterRestart=await (await fetch(base+'/api/ops?after=0',{headers})).json();
    assert.deepEqual(afterRestart.ops,page.ops);
    assert.equal((await (await fetch(base+'/api/info')).json()).salt,info.salt);
  } finally { await stop(); await rm(dir,{recursive:true,force:true}); }
});
