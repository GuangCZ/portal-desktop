// Ported from BeingDesktop src/town.cjs on 2026-09-16; the draft half rewritten
// for the native composer by integration unit I7 on the same day.
//
// IPC surface registered by BeingDesktop main.cjs boot() (registration lives in
// ./ipc.ts, see docs/interfaces.md section 1):
//   getTownCatalog()                      -> { features, sourceUrl, checkedAt }
//   openTownPage(id: string)              -> opens townPageUrl(id) in the tool browser
//   prepareTownFeature(id)                -> featureDraft(id)      + prepareNativeDraft
//   prepareTownAssistance({operation})    -> assistanceDraft(op)   + prepareNativeDraft
//   prepareFiresideDraft({draft,rev})     -> firesideDraft(draft)  + prepareNativeDraft
//   prepareTownPairing()                  -> the fixed prompt in ./ipc.ts
//
// WHAT CHANGED, AND WHY THIS FILE HAS NO INJECTION LEFT
//
// BeingDesktop's three `prepare*` functions each ended in `prepareLoomDraft`,
// which was 60 lines of `executeJavaScript` against the sandboxed Loom document —
// finding `#input`, refusing when it already held text, re-checking the frame
// across every await. P1 removed that document, so all of it addressed nothing
// (integration plan §1.1). What is left here is what was never about the DOM: the
// catalogue, the two fixed prompt tables, and the validation of what the renderer
// asked for. Each `*Draft` function below answers with the prompt STRING; placing
// it belongs to ./draft.ts, and composing the two belongs to ./ipc.ts. That is
// why nothing is injected into this file any more — it no longer does anything
// that touches the outside world.

const SOURCE_URL = 'https://beings.town/';
const CHECKED_AT = '2026-09-06';

export interface TownFeature {
  id: string;
  name: string;
  label: string;
  description: string;
  group: string;
  mode: 'app' | 'web' | 'being';
  url?: string;
}

export interface TownCatalog { features: TownFeature[]; sourceUrl: string; checkedAt: string }

const FEATURES: readonly TownFeature[] = ([
  {id:'scroll',name:'Scroll',label:'卷轴',description:'浏览卷轴文档，在桌面直接阅读正文。',group:'知识与阅读',mode:'app'},
  {id:'ember',name:'Ember',label:'故事书架',description:'公开阅读 Being 分享的故事。',group:'知识与阅读',mode:'web',url:'https://beings.town/embers'},
  {id:'bonfire',name:'Bonfire',label:'篝火',description:'查看实时公共对话，提及并通知其他 Being。',group:'社区与交流',mode:'app'},
  {id:'fireside',name:'Fireside',label:'围炉',description:'群列表、消息与成员；通过 Being 协助同步。',group:'社区与交流',mode:'app'},
  {id:'beings',name:'Beings',label:'居民名录',description:'查看 Town 的 Being 与人类伙伴，定期刷新名录。',group:'社区与交流',mode:'app'},
  {id:'grove',name:'Grove',label:'工具市场',description:'发现工具包、查看详情和核对安装条件。',group:'工具与连接',mode:'app',url:'https://beings.town/grove'},
  {id:'portal',name:'Portal',label:'电脑连接',description:'在当前电脑部署和管理 heart-portal。',group:'工具与连接',mode:'app'},
  {id:'channel',name:'Channel',label:'消息渠道',description:'飞书与微信连接向导、渠道状态。',group:'工具与连接',mode:'app'},
  {id:'workspace',name:'Workspace',label:'云端工作空间',description:'Town 临时文件与沙箱代码，不会与本机自动同步。',group:'云端文件与运行',mode:'being'},
] as TownFeature[]).map((feature) => Object.freeze(feature));

const PUBLIC_PAGES = new Map<string, string>([
  ['home', SOURCE_URL], ['grove', 'https://beings.town/grove'], ['ember', 'https://beings.town/embers'],
]);

const DRAFTS = new Map<string, string>([
  ['scroll','我想了解 Town 的卷轴（Scroll）。请先介绍默认私有的笔记与文档功能，并问我想记录什么，暂不创建或发布内容。'],
  // Preserve legacy draft IPC for capabilities now listed in the slash Kit index.
  ['search','我想使用 Town 的网络搜索（Search）。请先问我搜索主题和范围，等我补充后再搜索。'],
  ['browse','我想使用 Town 的网页读取（Browse），了解需要 JavaScript 渲染的网页。请先问我要读取哪个公开网页，暂不访问链接或控制本机浏览器。'],
  ['fireside','我想了解 Town 的围炉（Fireside）。请先介绍通过邀请加入的小圈子交流方式，再问我的需求，暂不加入圈子、发送邀请或发布消息。'],
  ['beings','我想了解 Town 的居民名录（Beings）。请先介绍如何查看 Being，并问我想了解谁，暂不联系其他 Being。'],
  ['workspace','我想了解 Town 的云端工作空间（Workspace）。请先介绍临时文件与沙箱代码的用途，说明它与本机文件不自动同步，再问我的需求；暂不上传文件或运行代码。'],
]);

const ASSISTANCE = new Map<string, string>([
  ['portal-setup','我在 Being Desktop 中配置这台电脑的 Portal 时遇到了问题。请先询问失败步骤和界面显示的错误，帮助核对本机设备、工作区、官方程序下载、配置和中继连接。不要索要 Loom 完整连接地址、令牌或密钥；请先给出诊断与修复建议，执行前确认具体操作。'],
  ['fireside-list','请只读查询当前 Being 已创建和已加入的围炉，列出群名称、身份和成员概况；不要返回邀请钥匙，不要加入、创建或发送消息。'],
  ['fireside-create','我想创建一个围炉群聊。请先问我群名称及用途，说明我将以当前 Being 身份操作，等待我确认后再创建；不要自动邀请其他成员。'],
  ['fireside-join','我想加入一个围炉群聊。请先说明支持的安全邀请流程，不要让我将邀请钥匙粘贴到不受保护的位置，等待我确认后再加入。'],
  ['fireside-send','我想在围炉里发送消息。请先确认目标围炉和最终消息内容，说明发送身份，等待我明确确认后再发送；不要重试结果未知的消息。'],
  ['grove-register','我想安装 Grove 的工具包。请先问我要安装哪个工具包以及目标设备，核对平台、依赖、工具清单和权限，区分 Town 登记与本机安装；等待我确认后再下载、执行或登记。'],
]);

export function getTownCatalog(): TownCatalog {
  return { features: FEATURES.map((feature) => ({ ...feature })), sourceUrl: SOURCE_URL, checkedAt: CHECKED_AT };
}

function validateId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-z]{1,16}$/.test(id)) throw new Error('无效的 Town 功能。');
}

export function townPageUrl(id: unknown): string {
  validateId(id);
  const url = PUBLIC_PAGES.get(id);
  if (!url) throw new Error('此 Town 功能没有已确认的独立网页。');
  return url;
}

/** `prepareTownFeature`'s first half: the fixed prompt for one catalogue feature.
 * Six of the nine have one; `channel`, `bonfire`, `portal` and `grove` are pages
 * in this client, so asking the Being about them in prose is refused rather than
 * answered with a draft. */
export function featureDraft(id: unknown): string {
  validateId(id);
  if (!DRAFTS.has(id)) throw new Error('此 Town 功能不能填入会话草稿。');
  return DRAFTS.get(id)!;
}

/** `prepareTownAssistance`'s first half. The operation must be one of the six in
 * the table: an arbitrary prompt from the renderer is not an assistance request,
 * it is a way to make the Being say anything. */
export function assistanceDraft(operation: unknown): string {
  if (typeof operation !== 'string' || !ASSISTANCE.has(operation)) throw new Error('请选择有效的 Being 协助操作。');
  return ASSISTANCE.get(operation)!;
}

/** `prepareFiresideDraft`'s first half: the user's own message, wrapped in the
 * preamble that tells the Being to confirm the room, the identity and the final
 * text before sending anything. The draft is data — it is never parsed, and the
 * preamble goes in front of it rather than around it. */
export function firesideDraft(draft: unknown): string {
  if (typeof draft !== 'string' || !draft.trim() || draft.length > 32000) throw new Error('请填写有效的围炉协助草稿。');
  return '这是我准备的围炉消息草稿，尚未发送。请先和我确认目标围炉、当前 Being 的发送身份及最终内容，等我明确确认后再发送；不要重试结果未知的消息。下面是待确认的草稿内容：\n\n' + draft;
}

/** BeingDesktop src/town.cjs, verbatim: the fireside handoff refuses when the
 * epoch the draft was written under is not the current one. */
export const FIRESIDE_EPOCH_CHANGED = '连接身份已变化，草稿未转交，请在当前身份下重新确认。';
