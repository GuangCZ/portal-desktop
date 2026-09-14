import type { UpdateActivity } from '../../../shared/types';
import { Dialog } from '../../shared/components/dialog';

const stages: Record<UpdateActivity['phase'], string> = {
  metadata: '正在读取更新信息…',
  downloading: '正在下载安装包…',
  verifying: '正在校验安装包…',
  preparing: '正在准备安装文件…',
  ready: '下载和校验已完成',
  installing: '正在停止 Portal，准备安装…',
};
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function UpdateProgress({ activity, onCancel }: { activity?: UpdateActivity; onCancel: () => void }) {
  const cancellable = activity && !['ready', 'installing'].includes(activity.phase);
  const ratio = activity?.phase === 'downloading' && activity.total
    ? Math.min(1, (activity.received || 0) / activity.total) : undefined;
  return (
    <Dialog id="update-progress-dialog" open={Boolean(activity)} onClose={onCancel} busy={!cancellable} aria-labelledby="update-progress-title">
      <h2 id="update-progress-title">更新至 {activity?.version}</h2>
      <p id="update-progress-status" role="status">{activity ? stages[activity.phase] : ''}</p>
      <progress max={1} value={activity?.phase === 'ready' ? 1 : ratio} aria-label="客户端更新进度" />
      {activity?.phase === 'downloading' && <p id="update-progress-bytes">
        已下载 {size(activity.received || 0)}{activity.total ? ` / ${size(activity.total)} · ${Math.floor((ratio || 0) * 100)}%` : ''}
      </p>}
      <p className="update-progress-note">{activity?.phase === 'installing'
        ? '客户端即将退出，安装器会继续显示安装进度。'
        : activity?.phase === 'ready' ? '请在确认窗口中选择是否停止 Portal 并安装。' : '下载完成后再确认安装，下载期间不会停止 Portal。'}</p>
      {cancellable && <button id="cancel-update-download" type="button" onClick={onCancel}>取消下载</button>}
    </Dialog>
  );
}
