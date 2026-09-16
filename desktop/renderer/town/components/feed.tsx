import { useEffect, useMemo, useRef, useState } from "react";
import {
  feedDisplayName,
  feedReplyAuthor,
  filterMessages,
  mailReply,
  newFeedFilters,
  type FeedFilters,
  type FeedMessage,
} from "../models/feed";
import { TownModel } from "../models/town";
import { sceneExcerpt } from "../../shared/models/scene";
import { Markdown, markdownText } from "../../shared/components/markdown";
import { mentionText, type MentionNames } from '../models/mentions';
import { MentionText } from './mention-text';

/** One feed of the paired Town client: the bonfire, one fireside, or the inbox.
 *
 * Rewired 2026-09-16: the rows arrive already validated (../models/feed.ts), and
 * the names in them are a projection through the member directory, applied at
 * render time. That is what lets a directory arriving after the messages
 * re-render labels without touching a message body — BeingDesktop
 * test/town-conversation-ui.cjs, "late directory arrival rerenders mention
 * labels without mutating messages". */
export function TownFeed({
  town,
  messages,
  filterKey,
}: {
  town: TownModel;
  messages: FeedMessage[];
  filterKey: string;
}) {
  const [filters, setFilters] = useState<FeedFilters>(
    () => town.feedFilters[filterKey] || newFeedFilters(),
  );
  const [selected, setSelected] = useState("");
  const more = useRef<HTMLDetailsElement>(null);
  const me = town.me;
  const mail = town.view === "mail";
  const mentionNames = town.mentionNames;
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
  // The accumulating timeline draws a divider after the newest message the
  // client already held before the last refresh, so「上次刷新到这里」is a real
  // position rather than a guess (docs/town-sdk-integration.md「时间线累积」).
  const boundary = mail ? null : town.timeline?.lastRefresh?.boundarySeq ?? null;
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
      {!mail && town.timeline?.hasOlder && (
        <button
          id="town-load-older"
          className="secondary"
          type="button"
          disabled={town.olderBusy}
          onClick={() => void town.loadOlder()}
        >
          {town.olderBusy ? "正在读取更早的消息…" : "读取更早的消息"}
        </button>
      )}
      <div className="social-messages">
        {filtered.map((message) => (
          <Message
            key={message.id || `${message.authorId}:${message.rawDate}:${message.index}`}
            {...{ message, town, mail, mentionNames }}
            divider={boundary !== null && message.seq > 0 && message.seq === boundary}
            selected={selected === message.id}
            onSelect={() => {
              setSelected(message.id);
              town.choose({
                id: "message:" + message.id,
                title: `${message.author} 的发言`,
                author: message.authorId || message.author,
                revision: message.rawDate,
                excerpt: sceneExcerpt(message.content),
                private: Boolean(town.view === "firesides" || mail),
              });
            }}
          />
        ))}
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
  mentionNames,
  divider,
  selected,
  onSelect,
}: {
  message: FeedMessage;
  town: TownModel;
  mail: boolean;
  mentionNames: MentionNames;
  divider: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const expanded = useRef<HTMLDetailsElement>(null),
    preview = useRef<HTMLElement>(null);
  const via = m.via,
    validTime = Number.isFinite(m.time);
  // A reply needs an addressable parent: Town's sequence in a feed, the message
  // id in the inbox. Without one the button is not offered rather than offered
  // and silently dropping the relation.
  const reply = mail ? mailReply(m) : m.seq > 0
    ? { id: m.seq, author: feedDisplayName(m.author, m.authorId), preview: m.content.slice(0, 500) }
    : undefined;
  const authorName = feedDisplayName(m.author, m.authorId);
  const replyAuthor = feedReplyAuthor(m.replyTo, mentionNames);
  const snippet = useMemo(
    () =>
      markdownText(m.content, text => mentionText(text, mentionNames))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 240),
    [m.content, mentionNames],
  );
  const body = (
    <Markdown className="reading-text social-body" content={m.content}
      renderText={text => <MentionText text={text} names={mentionNames} />} />
  );
  return (
    <>
      {divider && <div className="feed-boundary" role="separator">上次刷新到这里</div>}
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
        {m.replyTo && (
          <blockquote className="feed-reply-preview">
            <strong>
              回复{" "}
              {replyAuthor}
            </strong>
            <span>
              <MentionText text={m.replyTo.preview.slice(0, 500) || "原消息预览不可用"} names={mentionNames} />
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
          {!mail && m.revised ? '已编辑' : ''}
          {town.connected && reply && (
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
    </>
  );
}
