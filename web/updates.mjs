export const APP_VERSION = '1.2.0';
export const DEFAULT_REPOSITORY = 'yzxcxy/Surge';

export function parseRepository(value) {
  const input = String(value || '').trim();
  const path = input.startsWith('https://github.com/') ? input.slice('https://github.com/'.length) : input;
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(path);
  if (!match) throw new Error('请输入 GitHub 仓库地址或 owner/repo');
  return `${match[1]}/${match[2]}`;
}

export function compareVersions(a, b) {
  const parse = value => {
    const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/i.exec(String(value || '').trim());
    return match ? match.slice(1).map(part => Number(part || 0)) : null;
  };
  const left = parse(a), right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}

export async function latestRelease(repository, fetcher = fetch) {
  const repo = parseRepository(repository);
  let response = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    cache: 'no-store'
  });
  if (response.status === 403 && repo === DEFAULT_REPOSITORY) {
    try {
      const fallback = await fetcher(`https://raw.githubusercontent.com/${repo}/main/release.json`, { cache: 'no-store' });
      if (fallback.ok) response = fallback;
    } catch { /* Keep the API rate-limit error. */ }
  }
  if (!response.ok) {
    if (response.status === 404) throw new Error('仓库暂无正式版本，或仓库不可访问');
    if (response.status === 403) throw new Error('GitHub 暂时限制检查频率，请稍后再试');
    throw new Error(`检查失败（${response.status}）`);
  }
  const release = await response.json();
  const asset = release.assets?.find(item => /^https:\/\/github\.com\//.test(item.browser_download_url || '') && /\.apk$/i.test(item.name || ''));
  return { version: release.tag_name, page: release.html_url, apk: asset?.browser_download_url || null };
}
