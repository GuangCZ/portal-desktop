type Entry = Record<string, unknown>;
export interface FeedFilters {
  relation: string;
  order: string;
  days: string;
  author: string;
}
export interface FeedReply {
  id: string | number;
  author: string;
  preview: string;
  recipient?: string;
}
export const newFeedFilters = (): FeedFilters => ({
  relation: "all",
  order: "newest",
  days: "all",
  author: "",
});
const text = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const record = (value: unknown): Entry =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Entry)
    : {};
const identity = (value: unknown): string =>
  text(
    record(value).being_id ||
      record(value).beingId ||
      record(value).id ||
      record(value).name ||
      value,
  ).toLowerCase();
const displayName = (value: unknown): string => {
  const item = record(value);
  return (
    text(item.display_name || item.displayName || item.name || value) ||
    (item.being !== undefined ? displayName(item.being) : "") ||
    (item.identity !== undefined ? displayName(item.identity) : "") ||
    ""
  );
};
const firstText = (...values: unknown[]) => {
  for (const value of values) {
    const name = displayName(value);
    if (name) return name;
  }
  return "";
};

export function feedMessages(
  entries: Entry[],
  options: { me: string; mail?: "all" | "inbox" | "sent" },
) {
  const me = options.me.toLowerCase();
  return entries.map((entry, index) => {
    const authorId = identity(
      options.mail
        ? entry.sender_being_id || entry.sender || entry.from || entry.author
        : entry.being_id || entry.being,
    );
    const author =
      firstText(
        entry.sender_name,
        entry.sender_display_name,
        entry.speaker_name,
        entry.display_name,
        entry.sender,
        entry.sender_being,
        entry.from,
        entry.author,
        entry.being,
        entry.being_id,
      ) ||
      authorId ||
      "未知";
    const recipientId = identity(
      entry.recipient_being_id || entry.recipient || entry.to,
    );
    const recipient =
      firstText(
        entry.recipient_name,
        entry.recipient_display_name,
        entry.recipient,
        entry.recipient_being,
        entry.to,
      ) ||
      recipientId;
    const content = text(entry.message || entry.content);
    const mentionedIds = Array.isArray(entry.mentions)
      ? entry.mentions.map(identity)
      : [];
    // Exact @identifier tokens avoid matching e.g. alice in @alice_work.
    const textMentions = [...content.matchAll(/@([a-zA-Z0-9_-]+)/g)].map(
      (match) => match[1].toLowerCase(),
    );
    const mentioned = Boolean(
      me && (mentionedIds.includes(me) || textMentions.includes(me)),
    );
    const mine = Boolean(me && authorId === me);
    const received = Boolean(
      options.mail === "inbox" || (me && recipientId === me),
    );
    const sent = Boolean(options.mail === "sent" || mine);
    const rawDate = text(entry.at || entry.created_at);
    const time = Date.parse(rawDate);
    return {
      entry,
      index,
      authorId,
      author,
      recipient,
      content,
      mentioned,
      mine: sent,
      received,
      related: mentioned || sent || received,
      rawDate,
      time,
    };
  });
}
export type FeedMessage = ReturnType<typeof feedMessages>[number];
export function filterMessages(
  messages: FeedMessage[],
  filters: FeedFilters,
  search: string,
) {
  const query = search.trim().toLowerCase();
  const cutoff =
    filters.days === "all"
      ? -Infinity
      : Date.now() - Number(filters.days) * 86400000;
  return messages
    .filter(
      (message) =>
        (filters.relation === "all" ||
          (filters.relation === "about" && message.related) ||
          (filters.relation === "mentions" && message.mentioned) ||
          (filters.relation === "mine" && message.mine)) &&
        (!filters.author ||
          (message.authorId || message.author) === filters.author) &&
        (cutoff === -Infinity ||
          (Number.isFinite(message.time) && message.time >= cutoff)) &&
        (!query ||
          [message.author, message.authorId, message.recipient, message.content]
            .join(" ")
            .toLowerCase()
            .includes(query)),
    )
    .sort((a, b) => {
      const delta =
        (Number.isFinite(a.time) ? a.time : 0) -
        (Number.isFinite(b.time) ? b.time : 0);
      const tie =
        Number(a.entry.seq || 0) - Number(b.entry.seq || 0) ||
        a.index - b.index;
      return (delta || tie) * (filters.order === "newest" ? -1 : 1);
    });
}
