import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { atomic, BackgroundPortal, type Service } from '../portal/background';
import type { Connection } from '../chat/connection';

export interface InstallIntent {
  schema: 1; from: string; target: string; foreground: boolean;
  services: { service: Service; enabled: boolean }[];
}
// Written before the first stop. The next client either consumes these launch
// records with its new runtime or resumes them after a cancelled/failed install.
export class ClientInstall {
  private file: string;
  constructor(directory: string, private background: BackgroundPortal) {
    this.file = path.join(directory, 'client-install.json');
  }
  async read(): Promise<InstallIntent | null> {
    let value: InstallIntent;
    try { value = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    if (value.schema !== 1 || !/^\d+\.\d+\.\d+$/.test(value.from) || !/^\d+\.\d+\.\d+$/.test(value.target) ||
      !Array.isArray(value.services) || value.services.some(s => !s.service || !path.isAbsolute(s.service.root) || s.service.label !== this.background.label)) throw new Error('客户端安装恢复记录无效。');
    return value;
  }
  async prepare(from: string, target: string, _connection: Connection | null, foreground: boolean) {
    if (await this.read()) throw new Error('上次安装尚未完成，请重新打开客户端恢复。');
    const services: InstallIntent['services'] = [];
    const service = this.background.installedService;
    if (service && !service.existing && !service.kind) services.push({ service, enabled: (await this.background.refresh()).enabled });
    const intent: InstallIntent = { schema: 1, from, target, services, foreground };
    await atomic(this.file, JSON.stringify(intent));
    try { for (const item of services) await this.background.unload(item.service); }
    catch (error) { await this.resume(intent); throw error; }
    return intent;
  }
  async resume(intent: InstallIntent) {
    for (const { service, enabled } of intent.services) if (enabled && !service.existing && !service.kind) await this.background.load(service);
    await this.finish();
  }
  async finish() { await rm(this.file, { force: true }); }
}
