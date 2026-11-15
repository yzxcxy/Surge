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
