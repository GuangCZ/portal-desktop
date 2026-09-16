// Ported from BeingDesktop src/portal-installer.cjs (release table only) on 2026-09-16.
// The download, hash and install pipeline belongs to the Portal migration unit; TownController
// needs only the verified release metadata for the current platform.

export interface PortalReleaseInfo { version: string; apiUrl: string; url: string; size: number; sha256: string }

export const PORTAL_RELEASE: PortalReleaseInfo = Object.freeze({
  version: '0.8.3',
  apiUrl: 'https://api.github.com/repos/d5z/heart-portal/releases/assets/557419976',
  url: 'https://github.com/d5z/heart-portal/releases/download/v0.8.3/heart-portal-windows-x86_64.exe',
  size: 12004864,
  sha256: '5aec4a09bada241ebba3d8335042cc47cc552f4ff66e831ad5f0d370bab88032',
});

export const PORTAL_RELEASES: Readonly<Record<string, PortalReleaseInfo>> = Object.freeze({
  'win32-x64': PORTAL_RELEASE,
  'darwin-arm64': Object.freeze({ version: '0.8.3', apiUrl: 'https://api.github.com/repos/d5z/heart-portal/releases/assets/557419975',
    url: 'https://github.com/d5z/heart-portal/releases/download/v0.8.3/heart-portal-macos-arm64',
    size: 12205520, sha256: 'dad9d81b491195cc302e2552d181d8dba43b8f2c800f079922f8cb350badab42' }),
  'darwin-x64': Object.freeze({ version: '0.8.3', apiUrl: 'https://api.github.com/repos/d5z/heart-portal/releases/assets/557419978',
    url: 'https://github.com/d5z/heart-portal/releases/download/v0.8.3/heart-portal-macos-x86_64',
    size: 12767152, sha256: '99e884f56ea6b755787fa99ba52bdf9f413d3bf17f64a92eba4e8aecabf39f6d' }),
});

export function portalRelease(platform: string = process.platform, arch: string = process.arch): PortalReleaseInfo | null {
  return PORTAL_RELEASES[`${platform}-${arch}`] || null;
}
