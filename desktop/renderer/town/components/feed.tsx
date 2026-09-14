import { useEffect, useMemo, useRef, useState } from "react";
import {
  feedMessages,
  feedDisplayName,
  filterMessages,
  mailReply,
  newFeedFilters,
  type FeedFilters,
  type FeedMessage,
} from "../models/feed";
import { TownModel, list, str, type Data } from "../models/town";
import { sceneExcerpt } from "../../shared/models/scene";
import { Markdown, markdownText } from "../../shared/components/markdown";
export function TownFeed({
  town,
  data,
  filterKey,
}: {
  town: TownModel;
  data: Data;
  filterKey: string;
}) {
  const [filters, setFilters] = useState<FeedFilters>(
    () => town.feedFilters[filterKey] || newFeedFilters(),
  );
  const [selected, setSelected] = useState("");
  const more = useRef<HTMLDetailsElement>(null);
  const me = town.me || (typeof data.being === "string" ? data.being : "");
  const mail =
    town.view === "mail"
      ? (town.tab as "all" | "inbox" | "sent")
      : undefined;
  const messages = useMemo(
    () => feedMessages(list(data, "messages"), { me, mail }),
    [data, me, mail],
  );
  const authors = useMemo(
    () =>
      [
        ...new Map(
          messages.map((message) => [
            message.authorId || message.author,
            feedDisplayName(message.author, message.authorId),
          ]),
        ).entries(),
      ].sort((a, b) => a[1].localeCompare(b[1], "zh-CN")),
    [messages],
  );
  const effective = {
    ...filters,
    relation:
      !me && (!mail || filters.relation === "mentions")
        ? "all"
        : filters.relation,
    author: authors.some(([id]) => id === filters.author) ? filters.author : "",
  };
  const filtered = filterMessages(messages, effective, town.search),
    limit = town.view === "firesides" ? 50 : 100;
  const serialized = JSON.stringify({ ...effective, search: town.search });
  useEffect(() => {
    town.feedFilters[filterKey] = JSON.parse(serialized);
    town.scenes.update({
      count: filtered.length,
      filters: { tab: town.tab, ...JSON.parse(serialized) },
      scope: `${filtered.length} 条符合筛选 · 最近 ${limit} 条内筛选；未确认阅读`,
    });
  }, [town, filterKey, serialized, filtered.length, limit, town.tab]);
  useEffect(() => {
    const outside = (event: Event) => {
      if (more.current && !more.current.contains(event.target as Node))
        more.current.open = false;
    };
    document.addEventListener("click", outside);
    return () => document.removeEventListener("click", outside);
  }, []);
  const select = (
    label: string,
    values: [string, string][],
    key: "order" | "days" | "author",
  ) => (
    <label className="feed-select">
      {label}
      <select
        aria-label={label}
        value={effective[key]}
        onChange={(event) =>
          setFilters({ ...effective, [key]: event.target.value })
        }
      >
        {values.map(([value, caption]) => (
          <option value={value} key={value}>
            {caption}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="social-feed">
      <div className="feed-controls">
        <div className="feed-relations" aria-label="消息关系筛选">
          {[
            ["all", "全部"],
            ["about", "关于我"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              data-relation={value}
              disabled={!me && !mail && value !== "all"}
              className={effective.relation === value ? "selected" : ""}
              aria-pressed={effective.relation === value}
              onClick={() => setFilters({ ...effective, relation: value })}
            >
              {label}
            </button>
          ))}
        </div>
        <details
          className="feed-options"
          ref={more}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              event.currentTarget.open = false;
              event.currentTarget.querySelector("summary")?.focus();
            }
          }}
        >
          <summary>
            {effective.order !== "newest" ||
            effective.days !== "all" ||
            effective.author
              ? "筛选 · 已设置"
              : "筛选"}
          </summary>
          <div className="feed-selectors">
            {select(
              "排序",
              [
                ["newest", "最新在前"],
                ["oldest", "最早在前"],
              ],
              "order",
            )}
            {select(
              "时间",
              [
                ["all", "全部时间"],
                ["1", "最近 24 小时"],
                ["7", "最近 7 天"],
                ["30", "最近 30 天"],
              ],
              "days",
            )}
            {select("作者", [["", "全部作者"], ...authors], "author")}
          </div>
        </details>
      </div>
      <div
        className="feed-summary"
        role="status"
      >{`${filtered.length} / ${messages.length} 条 · 最近 ${limit} 条内筛选${me ? "" : " · 配对后可识别 @我和我的发言"}`}</div>
      <div className="social-messages">
        {filtered.map((message) => {
          const id = str(
            message.entry.id ||
              message.entry.seq ||
              `${message.authorId}:${message.rawDate}:${message.index}`,
          );
          return (
            <Message
              key={id}
              {...{ message, town, mail }}
              selected={selected === id}
              onSelect={() => {
                setSelected(id);
                town.choose({
                  id: "message:" + id,
                  title: `${message.author} 的发言`,
                  author: message.authorId || message.author,
                  revision: str(message.entry.revised_at || message.rawDate),
                  excerpt: sceneExcerpt(message.content),
                  private: Boolean(town.view === "firesides" || mail),
                });
              }}
            />
          );
        })}
        {!filtered.length && (
          <div className="feed-empty">
            <strong>
              {messages.length ? "没有符合条件的消息" : "暂无消息"}
            </strong>
            <p>
              {messages.length
                ? "试试其他筛选条件，或清空搜索关键词。"
                : "刷新后，新消息会显示在这里。"}
            </p>
            {messages.length > 0 && (
              <button
                className="secondary"
                onClick={() => setFilters(newFeedFilters())}
              >
                重置筛选
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
function Message({
  message: m,
  town,
  mail,
  selected,
  onSelect,
}: {
  message: FeedMessage;
  town: TownModel;
  mail?: "all" | "inbox" | "sent";
  selected: boolean;
  onSelect: () => void;
}) {
  const expanded = useRef<HTMLDetailsElement>(null),
    preview = useRef<HTMLElement>(null);
  const via = str(m.entry.via),
    validTime = Number.isFinite(m.time),
    replyId = Number(m.entry.seq),
    state = str(m.entry.delivery_status);
  const reply = mail ? mailReply(m) : Number.isSafeInteger(replyId) && replyId > 0
    ? { id: replyId, author: feedDisplayName(m.author, m.authorId), preview: m.content.slice(0, 500) }
    : undefined;
  const authorName = feedDisplayName(m.author, m.authorId);
  const replyAuthor = str(m.entry.reply_to_being || m.entry.reply_to_sender);
  const labels: Record<string, string> = {
    delivered: "已送达",
    pending: "待送达",
    failed: "送达失败",
    read: "已读",
  };
  const snippet = useMemo(
    () =>
      markdownText(m.content)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 240),
    [m.content],
  );
  const body = (
    <Markdown className="reading-text social-body" content={m.content} />
  );
  return (
    <article
      className={`social-message${m.mentioned ? " mentions-me" : ""}${selected ? " scene-selected" : ""}`}
    >
      <span className="social-avatar" aria-hidden="true">
        {authorName === '未命名 Being' ? '·' : authorName.slice(0, 1)}
      </span>
      <div className="social-content">
        <div className="social-meta">
          <strong className="social-author" title={m.authorId}>
            {authorName}
          </strong>
          {via.startsWith("client:") && (
            <span
              className="relation-tag via-tag"
              title="人类伙伴通过客户端，以此 Being 的身份发言"
            >
              借 {via.slice(7) || "客户端"}
            </span>
          )}
          {m.mine && <span className="relation-tag">本 Being 发送</span>}
          {m.received && <span className="relation-tag">发给我</span>}
          {m.mentioned && <span className="relation-tag mention-tag">@我</span>}
          {mail && m.recipient && !m.received && (
            <span className="social-recipient" title={m.recipientId}>→ {feedDisplayName(m.recipient, m.recipientId)}</span>
          )}
          <time
            dateTime={validTime ? new Date(m.time).toISOString() : undefined}
          >
            {validTime
              ? new Date(m.time).toLocaleString("zh-CN", {
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : m.rawDate}
          </time>
        </div>
        {m.entry.reply_to != null && (
          <blockquote className="feed-reply-preview">
            <strong>
              回复{" "}
              {replyAuthor && !replyAuthor.startsWith('t_') ? replyAuthor : '原消息'}
            </strong>
            <span>
              {str(m.entry.reply_to_preview).slice(0, 500) ||
                "原消息预览不可用"}
            </span>
          </blockquote>
        )}
        {m.content.length > 480 || m.content.split("\n").length > 8 ? (
          <details className="social-expand" ref={expanded}>
            <summary ref={preview}>
              <span className="social-preview">{snippet}</span>
              <span className="expand-label">展开全文</span>
            </summary>
            {body}
            <button
              className="text-button"
              type="button"
              onClick={() => {
                if (expanded.current) expanded.current.open = false;
                preview.current?.focus();
              }}
            >
              收起全文
            </button>
          </details>
        ) : (
          body
        )}
        <div className="social-foot">
          {mail
            ? labels[state] || state
            : m.entry.revised_at ? '已编辑' : ''}
          {(town.view === "firesides" || town.view === "bonfire" || mail) &&
            town.live?.phase === "connected" &&
            reply && (
              <button
                className="scene-select"
                type="button"
                onClick={() => town.compose(reply)}
              >
                回复
              </button>
            )}
          <button className="scene-select" type="button" onClick={onSelect}>
            一起看
          </button>
        </div>
      </div>
    </article>
  );
}
