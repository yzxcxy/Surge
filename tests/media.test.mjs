import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { bytesToUrl, decryptValue, deriveKey, encryptValue, urlToBytes } from '../web/core.mjs';

test('encrypted attachments survive a server restart without plaintext', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'surge-media-'));
  const port = 21000 + Math.floor(Math.random() * 10000);
  const token = 'media-test-token-at-least-24-characters';
  let child;
  const start = async () => {
    child = spawn('node', ['server/index.mjs'], { cwd: new URL('../', import.meta.url).pathname, env: { ...process.env, SURGE_DATA_DIR: dir, SURGE_TOKEN: token, PORT: String(port) }, stdio: 'ignore' });
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('server did not start');
  };
  const stop = async () => { if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); } };
  try {
    await start();
    const bytes = new Uint8Array(randomBytes(1024 * 1024));
    const encoded = bytesToUrl(bytes);
    assert.deepEqual(urlToBytes(encoded), bytes);
    const key = await deriveKey('media test passphrase', bytesToUrl(crypto.getRandomValues(new Uint8Array(16))));
    const ciphertext = await encryptValue(key, { kind: 'image', name: 'test.png', mime: 'image/png', data: encoded });
    const id = crypto.randomUUID();
    const url = `http://127.0.0.1:${port}/api/blobs/${id}`;
    assert.equal((await fetch(url)).status, 401);
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ciphertext }) })).status, 200);
    await stop();
    await start();
    const response = await fetch(url, { headers });
    assert.equal(response.status, 200);
    const raw = await response.text();
    assert.equal(raw.includes('test.png'), false);
    const payload = await decryptValue(key, JSON.parse(raw).ciphertext);
    assert.equal(payload.name, 'test.png');
    assert.deepEqual(urlToBytes(payload.data), bytes);
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});
