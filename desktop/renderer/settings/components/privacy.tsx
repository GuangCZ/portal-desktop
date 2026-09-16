// 隐私说明. New in the portal-desktop shell on 2026-09-16 (integration unit I6).
//
// BeingDesktop 0.8.26 has no such page — the client's data handling is described
// only in its README. Every sentence here is a claim about code in this
// repository, and each is written beside the file that makes it true, so a change
// that falsifies one is a change to a file named in a comment below. Nothing here
// is aspirational: if a rule is only mostly true, it is not on this page.
import type { AppModel } from "../../app/models/app";

export function PrivacyPage({ app }: { app: AppModel }) {
  return (
    <div className="shell-page" id="privacy-page">
      <h3>隐私说明</h3>
      <p className="field-help">
        这个客户端不做任何统计上报，也没有自己的服务器。除了你的 Being、你配置的 Town
        与检查更新用的发布页面，它不连别的地方。
      </p>
      <dl className="shell-facts shell-facts-block">
        <div>
          {/* main/chat/cache.ts: safeStorage ciphertext, one file per Being identity. */}
          <dt>对话记录</dt>
          <dd>
            留在这台机器的客户端配置目录里（<span className="shell-mono">chat-cache</span>），
            按 Being 身份分文件，用系统密钥库加密。「删除会话」删的是这份本机记录——Being 仍然记得你们说过的话。
          </dd>
        </div>
        <div>
          {/* main/app/settings.ts: settings.json, credential encrypted with safeStorage, mode 0600. */}
          <dt>连接凭据</dt>
          <dd>
            Being 的地址与令牌加密后保存在 <span className="shell-mono">settings.json</span> 里，
            文件权限 0600。系统密钥库不可用时，客户端拒绝保存，而不是退回明文。
          </dd>
        </div>
        <div>
          {/* main/shell/sidebar-state.ts — this unit. */}
          <dt>侧栏的置顶、归档与项目</dt>
          <dd>
            只保存在本机，按 Being 分开存放，不会发给 Being，也不会发给小镇。
            换一个 Being，侧栏换一套；同一个 Being 换一台机器，这些不会跟过去。
          </dd>
        </div>
        <div>
          {/* main/app/error-log.ts `redact` + main.ts `diagnose`. */}
          <dt>诊断与日志</dt>
          <dd>
            「导出诊断」写出的是版本、平台、Portal 运行状态和最近的 Portal 日志；
            令牌与中继密钥会被替换成占位符，主目录路径缩写成 <span className="shell-mono">~</span>，不含对话内容。
            导出到哪里由你选。
          </dd>
        </div>
        <div>
          {/* tests/architecture.test.ts: the renderer may not name fetch/WebSocket/… */}
          <dt>界面不自己联网</dt>
          <dd>
            你看到的每一个字节都由主进程通过 IPC 送来；界面层连 <span className="shell-mono">fetch</span> 都不允许出现，
            这条由仓库里的架构测试守着。
          </dd>
        </div>
      </dl>
      <p className="field-help">
        客户端配置目录里还有 Portal 的运行状态与更新记录。
        要整个清空，退出客户端后删除这个 profile 目录即可；Being 那边不受影响。
        {app.snapshot?.settings.hasToken ? "" : " 现在还没有连接任何 Being，所以本机也还没有对话记录。"}
      </p>
    </div>
  );
}
