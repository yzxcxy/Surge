import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, latestRelease, parseRepository } from '../web/updates.mjs';

test('GitHub repository input and release comparison', () => {
  assert.equal(parseRepository('https://github.com/yzxcxy/Surge'), 'yzxcxy/Surge');
  assert.equal(parseRepository('yzxcxy/Surge.git'), 'yzxcxy/Surge');
  assert.throws(() => parseRepository('https://example.com/Surge'));
  assert.equal(compareVersions('v1.2.0', '1.1.0'), 1);
  assert.equal(compareVersions('1.0.9', '1.1.0'), -1);
  assert.equal(compareVersions('release-2', '1.1.0'), null);
});

test('GitHub release prefers a public APK asset', async () => {
  let requested;
  const release = await latestRelease('yzxcxy/Surge', async url => {
    requested = url;
    return { ok: true, json: async () => ({
      tag_name: 'v1.2.0', html_url: 'https://github.com/yzxcxy/Surge/releases/tag/v1.2.0',
      assets: [{ name: 'surge.apk', browser_download_url: 'https://github.com/yzxcxy/Surge/releases/download/v1.2.0/surge.apk' }]
    }) };
  });
  assert.equal(requested, 'https://api.github.com/repos/yzxcxy/Surge/releases/latest');
  assert.match(release.apk, /surge\.apk$/);
});

test('Surge checks its release manifest when GitHub API is rate-limited', async () => {
  const requests = [];
  const release = await latestRelease('yzxcxy/Surge', async url => {
    requests.push(url);
    return requests.length === 1 ? { ok: false, status: 403 } : { ok: true, json: async () => ({
      tag_name: 'v1.1.0', html_url: 'https://github.com/yzxcxy/Surge/releases/tag/v1.1.0', assets: []
    }) };
  });
  assert.equal(requests[1], 'https://raw.githubusercontent.com/yzxcxy/Surge/main/release.json');
  assert.equal(release.version, 'v1.1.0');
});
