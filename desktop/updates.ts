import { compareVersions } from './runtime-update';
import { assetName } from './manual-installer';
export interface UpdateState {
  phase: 'idle' | 'checking' | 'available' | 'current' | 'unavailable';
  currentVersion: string; latestVersion?: string; message: string; releaseUrl: string;
}
// Source is set at build time. Neither renderer nor release response can choose a host.
export class UpdateChecker {
  state: UpdateState;
  private pending?: Promise<UpdateState>;
  constructor(private version: string, private repository: string, private fetcher: typeof fetch = fetch,
    private changed: (state: UpdateState) => void = () => {}, private platform = process.platform, private arch = process.arch) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid update repository');
    this.state = { phase: 'idle', currentVersion: version, message: '尚未检查更新', releaseUrl: `https://github.com/${repository}/releases` };
  }
  check(): Promise<UpdateState> {
    if (this.pending) return this.pending;
    this.pending = this.checkOnce().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private publish(patch: Partial<UpdateState>) { this.state = { ...this.state, ...patch }; this.changed(this.state); return this.state; }
  private async checkOnce() {
    this.publish({ phase: 'checking', latestVersion: undefined, message: '正在检查更新…' });
    try {
      const response = await this.fetcher(`https://api.github.com/repos/${this.repository}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'portal-desktop' },
        redirect: 'error', signal: AbortSignal.timeout(12_000),
      });
      if (response.status === 404) return this.publish({ phase: 'unavailable', message: '尚无可公开读取的正式版本；私有仓库请在浏览器登录后查看发布页。' });
      if (!response.ok) throw new Error('Update service unavailable');
      if (!response.body) throw new Error('Missing update metadata');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          length += next.value.length;
          if (length > 256_000) throw new Error('Update metadata too large');
          chunks.push(next.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const release = JSON.parse(Buffer.concat(chunks).toString());
      if (release.draft || release.prerelease || typeof release.tag_name !== 'string' || !Array.isArray(release.assets) || !release.assets.length) throw new Error('No complete stable release');
      const newer = compareVersions(release.tag_name, this.version) > 0;
      if (newer) {
        let installer: string;
        try { installer = assetName(release.tag_name.replace(/^v/, ''), this.platform, this.arch); }
        catch { return this.publish({ phase: 'unavailable', message: '当前系统或架构尚无配套安装包，请查看发布页。' }); }
        if ([installer, 'SHA256SUMS.txt'].some(name => release.assets.filter((asset: { name?: string }) => asset?.name === name).length !== 1)) {
          return this.publish({ phase: 'unavailable', message: '该版本的配套安装包或校验清单尚未就绪，请稍后重试或查看发布页。' });
        }
      }
      return this.publish({ phase: newer ? 'available' : 'current', latestVersion: release.tag_name.replace(/^v/, ''),
        message: newer ? '发现新版本。可手动下载并升级客户端、Portal 和守护程序。' : '当前已是最新正式版本。',
        releaseUrl: `https://github.com/${this.repository}/releases/tag/${encodeURIComponent(release.tag_name)}` });
    } catch { return this.publish({ phase: 'unavailable', message: '暂时无法检查更新，可以稍后重试或打开发布页。' }); }
  }
}
