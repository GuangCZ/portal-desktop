// The message-channel page: three cards, three states, one wizard; 2026-09-16.
// Ported rule for rule from BeingDesktop 0.8.26 renderer/town-app.js lines
// 908-985 (`buildChannel` / `renderChannel`). Every sentence below is that
// file's, verbatim.
//
// The three states of the body, in the source's order:
//
//   wecom          permanently unsupported, and says which two to use instead
//   connected      no wizard, no「配置新连接」— re-binding a bound channel is the
//                  one action this page must never invite (docs/channel-sessions.md)
//   not connected  a read-only status check, and「配置新连接」only when the service
//                  has not already registered something
import { useModel } from "../../shared/hooks/use-model";
import { CHANNEL_CARDS, CHANNEL_STATUS } from "../models/channel";
import type { ChannelModel } from "../models/channel";

/** renderer/town-app.js `badge`. */
function Badge({ status }: { status: string }) {
  return <span className="channel-badge" data-status={status}>{CHANNEL_STATUS[status] || "待确认"}</span>;
}

export function ChannelPage({ model }: { model: ChannelModel }) {
  const channel = useModel(model);
  return (
    <aside className="channel-panel" aria-label="消息渠道">
      <header className="channel-panel-head">
        <h2>消息渠道</h2>
        <button type="button" className="icon-button close" aria-label="关闭消息渠道" title="关闭消息渠道"
          onClick={() => channel.show(false)} />
      </header>
      <nav className="channel-tabs" aria-label="消息渠道与 Town 功能">
        <button type="button" aria-current={channel.tab === "channel" ? "page" : undefined}
          onClick={() => channel.selectTab("channel")}>消息渠道</button>
        <button type="button" aria-current={channel.tab === "features" ? "page" : undefined}
          onClick={() => channel.selectTab("features")}>Town 功能</button>
      </nav>
      {channel.tab === "channel" ? <ChannelTab model={channel} /> : <FeaturesTab model={channel} />}
    </aside>
  );
}

function ChannelTab({ model }: { model: ChannelModel }) {
  return (
    <>
      <div className="channel-cards">
        {CHANNEL_CARDS.map(card => (
          <button type="button" key={card.id} className="channel-card" data-channel={card.id}
            aria-pressed={model.selected === card.id} onClick={() => model.select(card.id)}>
            <strong>{card.name}</strong>
            <span className="channel-card-note">{model.cardStatus(card.id)}</span>
          </button>
        ))}
      </div>
      <div className="channel-body">
        <ChannelBody model={model} />
      </div>
    </>
  );
}

function ChannelBody({ model }: { model: ChannelModel }) {
  if (model.selected === "wecom") {
    return (
      <div className="channel-message">
        <h3>暂不支持企业微信</h3>
        <p>当前连接服务未提供企业微信接入。请选择飞书，或检查微信可用的连接方式。</p>
      </div>
    );
  }
  const feishu = model.selected === "feishu";
  const name = feishu ? "飞书" : "微信";
  const disabled = !model.connected || model.pending;
  return (
    <>
      <div className="channel-heading">
        <h3>{`${name}渠道`}</h3>
        <Badge status={model.status} />
      </div>
      {model.readError && <p className="channel-notice">{model.readError}</p>}
      {!model.connected && <p className="channel-notice">请先在连接设置中连接 Being，再完成渠道配置。</p>}
      {model.status === "connected" ? (
        <>
          <p className="channel-copy">{`${name}已连接，无需重复绑定。`}</p>
          {model.detail && <p className="channel-notice">{model.detail}</p>}
          <div className="channel-actions">
            <button type="button" id="channel-refresh" className="secondary" disabled={disabled} onClick={() => void model.inspect()}>
              {model.busy.has("inspect") ? "正在读取…" : "刷新绑定状态"}
            </button>
            <button type="button" id="channel-check" className="secondary" disabled={disabled} onClick={() => void model.check()}>
              请 Being 核对状态
            </button>
          </div>
        </>
      ) : !model.wizard ? (
        <>
          <p className="channel-copy">
            {model.detail || (model.bound
              ? `${name}已有渠道登记，可继续核对连接状态。`
              : "尚未确认已有绑定状态，不代表未绑定。已绑定时无需配置新连接。")}
          </p>
          <div className="channel-actions">
            <button type="button" id="channel-check" className="primary" disabled={disabled} onClick={() => void model.check()}>
              {model.busy.has("inspect") ? "正在读取绑定状态…" : model.busy.has("status") ? "Being 正在核对…" : "请 Being 核对绑定状态"}
            </button>
            {!model.bound && (
              <button type="button" id="channel-connect" className="secondary" disabled={disabled} onClick={() => model.startWizard()}>
                配置新连接
              </button>
            )}
          </div>
        </>
      ) : (
        <Wizard model={model} feishu={feishu} disabled={disabled} />
      )}
    </>
  );
}

function Wizard({ model, feishu, disabled }: { model: ChannelModel; feishu: boolean; disabled: boolean }) {
  const labels = feishu ? ["请求 Being", "配置说明", "确认状态"] : ["请求 Being", "查看回复", "确认状态"];
  return (
    <>
      <ol className="channel-steps">
        {labels.map((label, index) => (
          <li key={label} className={index === model.step ? "is-current" : undefined}>
            <span className="channel-step-number">{index + 1}</span>
            <span>{label}</span>
          </li>
        ))}
      </ol>
      <div className="channel-wizard">
        {feishu ? (
          <>
            <h4>飞书连接说明</h4>
            <p>Being 会在这里回复机器人配置步骤。应用凭据请按 Being 提供的安全配置方式填写。</p>
          </>
        ) : (
          <>
            <h4>微信接入状态</h4>
            <p>{model.qr
              ? "使用微信扫描 Being 返回的二维码，完成微信接入后请 Being 确认连接状态。"
              : "Being 会检查微信的可用接入方式，并在这里回复操作步骤或连接状态。"}</p>
            {model.qr && <img className="channel-qr" src={model.qr} alt="微信连接授权二维码" />}
          </>
        )}
        <div className="channel-actions">
          <button type="button" id="channel-check" className="secondary" disabled={disabled} onClick={() => void model.check()}>
            {model.pending ? "Being 正在处理…" : "请 Being 检查状态"}
          </button>
        </div>
        {model.detail && <p className="channel-notice">{model.detail}</p>}
      </div>
    </>
  );
}

/** The Town feature catalogue (renderer/app.js lines 900-1010). Nine rows, three
 * behaviours: a page in this client, a public web page in the tool browser, or a
 * fixed prompt placed in the conversation for the user to finish and send. */
function FeaturesTab({ model }: { model: ChannelModel }) {
  if (model.catalogStatus === "loading") return <p className="channel-copy">正在读取 Town 功能目录…</p>;
  if (model.catalogStatus === "error") {
    return (
      <div className="channel-message">
        <p className="channel-notice">{model.catalogError}</p>
        <div className="channel-actions">
          <button type="button" className="secondary" onClick={() => void model.loadCatalog()}>重新读取</button>
        </div>
      </div>
    );
  }
  return (
    <div className="channel-features">
      {model.draftError && <p className="channel-notice">{model.draftError}</p>}
      {model.draftReady && <p className="channel-copy">{model.draftReady}</p>}
      {model.catalog.map(feature => {
        const draft = feature.mode === "being" && model.hasDraft(feature.id);
        const actionable = feature.mode !== "being" || draft;
        return (
          <div className="channel-feature" key={feature.id} data-feature={feature.id}>
            <div className="channel-feature-copy">
              <strong>{feature.label}</strong>
              <small>{feature.description}</small>
            </div>
            {actionable && (
              <button type="button" className="secondary" disabled={Boolean(model.drafting)}
                onClick={() => model.activate(feature)}>
                {model.drafting === feature.id ? "正在准备…"
                  : feature.mode === "web" ? "在内置浏览器中打开"
                  : feature.mode === "app" ? "打开功能页"
                  : "填入对话草稿"}
              </button>
            )}
          </div>
        );
      })}
      {model.checkedAt && <p className="channel-checked">{`目录核对于 ${model.checkedAt}`}</p>}
    </div>
  );
}
