// Ported from BeingDesktop 0.8.26 src/orchestration-policy.cjs on 2026-09-16.
// `desktopPortalName` / `validDesktopId` belong to the Desktop identity unit (src/desktop-identity.cjs);
// they are injected, with a line-for-line default so this module is testable on its own.
// Boundary: docs/orchestration.md "Desktop identity and execution isolation".

import type { BridgeCapabilities, OrchestrationMode, OrchestrationPolicyOptions, PolicyState } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const defaultValidDesktopId = (value: string): boolean => typeof value === 'string' && UUID.test(value);
const defaultDesktopPortalName = (id: string): string => {
  if (!defaultValidDesktopId(id)) throw new Error('Desktop 身份无效。');
  return 'being-desktop-tools-' + id.toLowerCase();
};

const error = (message: string): Error => Object.assign(new Error(message), { code: 'ORCHESTRATION_NOT_ENFORCED' });

// Enforcement is local to this Desktop's tool bridge. It does not change or
// claim control over Being's shared model endpoint or independent remote tools.
export class OrchestrationPolicy {
  getIdentity: () => string;
  getDesktopId: () => string;
  getBridge: () => BridgeCapabilities | null | undefined;
  getMode: () => OrchestrationMode | null | undefined;
  onChange: (state: PolicyState) => void;
  validDesktopId: (value: string) => boolean;
  desktopPortalName: (id: string) => string;
  state: PolicyState;

  constructor({
    getIdentity, getDesktopId, getBridge, getMode, onChange = () => {},
    validDesktopId = defaultValidDesktopId, desktopPortalName = defaultDesktopPortalName,
  }: OrchestrationPolicyOptions) {
    this.getIdentity = getIdentity; this.getDesktopId = getDesktopId; this.getBridge = getBridge; this.getMode = getMode;
    this.onChange = onChange; this.validDesktopId = validDesktopId; this.desktopPortalName = desktopPortalName;
    this.state = { status: 'unchecked', scope: 'desktop', detail: '本机工具绑定尚未核验。' };
  }

  publish(status: string, detail: string): void {
    if (this.state.status === status && this.state.detail === detail) return;
    this.state = { status, scope: 'desktop', detail };
    this.onChange({ ...this.state });
  }

  async configure(enabled: boolean): Promise<void> {
    if (!this.getIdentity()) throw error('请先连接 Being。');
    if (!this.validDesktopId(this.getDesktopId())) throw error('Desktop 身份尚未就绪。');
    this.publish(enabled ? 'pending' : 'disabled', enabled ? '本机编排已配置，等待 Worker 工具连接。' : '本机已切换为直接模式，其他 Desktop 的模式与模型配置不变。');
  }

  async syncBridge(): Promise<void> {
    if (this.getMode()?.enabled !== true) { this.publish('disabled', '本机已切换为直接模式，其他 Desktop 的模式与模型配置不变。'); return; }
    const bridge = this.getBridge();
    if (this.getIdentity() && this.validDesktopId(this.getDesktopId()) && bridge?.place === this.desktopPortalName(this.getDesktopId())
      && (bridge.status === 'connecting' || bridge.status === 'connected' && !bridge.tools?.length)) {
      this.publish('pending', bridge.status === 'connecting' ? '配置已保存，正在连接本机调度工具。' : '调度连接已建立，正在初始化 Worker 工具。'); return;
    }
    await this.inspectForMessage();
  }

  async inspectForMessage(): Promise<PolicyState> {
    // Chat and Being-native tools do not depend on this local execution bridge.
    // Dispatch/presentation still call assertEnforced and fail closed.
    if (this.getMode()?.enabled !== true) return { status: 'disabled', scope: 'desktop' };
    try { await this.assertEnforced(); }
    catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ORCHESTRATION_NOT_ENFORCED') throw failure; }
    return { ...this.state };
  }

  async assertEnforced(): Promise<void> {
    try {
      const id = this.getDesktopId(), bridge = this.getBridge();
      if (!this.getIdentity() || !this.validDesktopId(id) || this.getMode()?.enabled !== true) throw error('本机编排模式未启用或 Desktop 身份无效。');
      if (bridge?.place !== this.desktopPortalName(id) || bridge.status !== 'connected' || !bridge.tools?.includes('desktop_worker_start')) throw error('本机 Worker 工具尚未连接，请重新连接本机调度工具。');
      if (bridge.tools.some((name) => !name.startsWith('desktop_worker_'))) throw error('本机编排工具范围未生效，本机执行已阻塞。');
      this.publish('enforced', '已核验当前 Desktop：本机执行通过 Worker 调度，Being 原生能力可直接使用。其他 Desktop 独立运行。');
    } catch (failure) {
      this.publish('blocked', (failure as NodeJS.ErrnoException).code === 'ORCHESTRATION_NOT_ENFORCED' ? (failure as Error).message : '本机工具绑定检查失败，任务未发送。');
      throw error(this.state.detail!);
    }
  }
}
