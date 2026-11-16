import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, open, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../web/', import.meta.url)));
const dataDir = process.env.SURGE_DATA_DIR || resolve('data');
const blobDir = join(dataDir, 'blobs');
const token = process.env.SURGE_TOKEN;
if (!token || token.length < 24) throw new Error('SURGE_TOKEN must have at least 24 characters');
await mkdir(dataDir, { recursive: true });
await mkdir(blobDir, { recursive: true });
const saltFile = join(dataDir, 'salt');
let salt;
try { salt = (await readFile(saltFile, 'utf8')).trim(); }
catch { salt = randomBytes(16).toString('base64url'); await writeFile(saltFile, salt, { mode: 0o600, flag: 'wx' }); }

const logFile = join(dataDir, 'ops.jsonl');
const ops = [];
const ids = new Set();
let log;
try { log = await readFile(logFile); } catch { log = Buffer.alloc(0); }
let validEnd = 0;
for (let start = 0; start < log.length;) {
  const end = log.indexOf(10, start);
  if (end < 0) break;
  try {
    const op = JSON.parse(log.subarray(start, end).toString());
    if (!validOp(op)) break;
    if (!ids.has(op.id)) { ops.push(op); ids.add(op.id); }
    validEnd = end + 1;
  } catch { break; }
  start = end + 1;
}
const handle = await open(logFile, 'a+');
if (validEnd !== log.length) await handle.truncate(validEnd);
let writeQueue = Promise.resolve();

function validOp(op) {
  return op && typeof op === 'object' &&
    /^[a-f0-9-]{36}$/.test(op.id) && /^[a-f0-9-]{36}$/.test(op.noteId) &&
    ['title','body','folder','pinned','deleted','purged','kind','reminderAt','background','updatedAt'].includes(op.field) &&
    Number.isSafeInteger(op.clock) && op.clock > 0 && op.clock < 1e15 &&
    /^[a-f0-9-]{36}$/.test(op.actor) &&
    typeof op.ciphertext === 'string' && /^[A-Za-z0-9_-]{16,200000}$/.test(op.ciphertext);
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Authorization, Content-Type', 'Access-Control-Allow-Methods':'GET, POST, OPTIONS' });
  res.end(JSON.stringify(value));
}
function authorized(req) {
  const given = req.headers.authorization?.replace(/^Bearer /, '') || '';
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function body(req, limit = 1048576) {
  let total = 0; const chunks = [];
  for await (const chunk of req) { total += chunk.length; if (total > limit) throw new Error('body too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/') && req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Authorization, Content-Type', 'Access-Control-Allow-Methods':'GET, POST, OPTIONS' }); return res.end(); }
    if (url.pathname === '/api/health') return json(res, 200, { ok: true });
    if (url.pathname === '/api/info') return json(res, 200, { protocol: 1, salt });
    if (url.pathname.startsWith('/api/')) {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      const blobMatch = /^\/api\/blobs\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (blobMatch && req.method === 'GET') {
        try { return json(res, 200, { ciphertext: await readFile(join(blobDir, blobMatch[1]), 'utf8') }); }
        catch (error) { if (error.code === 'ENOENT') return json(res, 404, { error: 'not found' }); throw error; }
      }
      if (blobMatch && req.method === 'POST') {
        const parsed = await body(req, 12 * 1024 * 1024);
        if (typeof parsed.ciphertext !== 'string' || !/^[A-Za-z0-9_-]{16,12000000}$/.test(parsed.ciphertext)) return json(res, 400, { error: 'invalid blob' });
        try { await writeFile(join(blobDir, blobMatch[1]), parsed.ciphertext, { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/ops' && req.method === 'GET') {
        const after = Number(url.searchParams.get('after') || 0);
        if (!Number.isSafeInteger(after) || after < 0) return json(res, 400, { error: 'invalid cursor' });
        const page = ops.slice(after, after + 200);
        return json(res, 200, { ops: page, cursor: after + page.length, hasMore: after + page.length < ops.length });
      }
      if (url.pathname === '/api/ops' && req.method === 'POST') {
        const parsed = await body(req);
        if (!Array.isArray(parsed.ops) || parsed.ops.length > 100 || !parsed.ops.every(validOp)) return json(res, 400, { error: 'invalid operations' });
        const result = await (writeQueue = writeQueue.catch(() => {}).then(async () => {
          const fresh = parsed.ops.filter(op => !ids.has(op.id)).map(({ id, noteId, field, clock, actor, ciphertext }) => ({ id, noteId, field, clock, actor, ciphertext }));
          if (fresh.length) {
            await handle.writeFile(fresh.map(op => JSON.stringify(op) + '\n').join(''));
            await handle.sync();
            for (const op of fresh) { ids.add(op.id); ops.push(op); }
          }
          return { accepted: fresh.length };
        }));
        return json(res, 200, result);
      }
      return json(res, 404, { error: 'not found' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/index.html';
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + '/')) return json(res, 403, { error: 'forbidden' });
    const content = await readFile(file);
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (e) { json(res, e.message === 'body too large' ? 413 : 400, { error: e.message }); }
});
if (process.env.NODE_ENV !== 'test') server.listen(Number(process.env.PORT || 8787), '0.0.0.0', () => console.log('Surge on port ' + (process.env.PORT || 8787)));
export { server };
