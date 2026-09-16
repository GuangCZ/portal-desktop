import { useLayoutEffect, useRef } from "react";
import { TownModel, definitions, str } from "./models/town";
import { useModel } from "../shared/hooks/use-model";
import {
  TownHome,
  Catalog,
  CatalogDetail,
  Pagination,
  LocalKits,
  DetailError,
} from "./components/catalog";
import { TownFeed } from "./components/feed";
import { SeedGarden, SeedDetail, SeedSearch } from "./components/seeds";

/** Town, as one page: the public catalogue the shell browses without a
 * credential, and the three feeds the paired client reads directly. Rewired
 * 2026-09-16 — see ./models/town.ts for what moved and why. */
export function Town({ model }: { model: TownModel }) {
  const town = useModel(model),
    definition = definitions[town.view],
    feed = town.feedKind(),
    social = Boolean(feed),
    paginated =
      !town.directId &&
      (["embers", "scrolls", "seeds"].includes(town.view) ||
        (town.view === "kits" && town.tab === "grove")),
    root = useRef<HTMLElement>(null);
  useLayoutEffect(() => { if (root.current) root.current.scrollTop = 0; }, [town.view, town.directId]);
  return (
    <section
      id="town-view"
      ref={root}
      className={`view${social ? " social-view" : ""}${paginated ? " paginated-view" : ""}${town.view === "embers" ? " bookshelf-view" : ""}${town.view === "kits" && town.tab === "grove" && !town.directId ? " kit-catalog" : ""}${town.view === "seeds" && !town.directId ? " seed-catalog" : ""}`}
      hidden={!definition}
    >
      <div className="town-content">
        <div className="town-heading" hidden>
          <div>
            <div id="town-eyebrow" hidden>
              {definition?.eyebrow}
            </div>
            <h1 id="town-title">{definition?.title || "小镇广场"}</h1>
            <p id="town-description">{definition?.description}</p>
          </div>
        </div>
        <div className="town-toolbar">
          <div
            id="town-tabs"
            className="segmented"
            role="tablist"
            hidden={Boolean(town.directId) || !definition?.tabs.length}
          >
            {definition?.tabs.map(([value, label]) => (
              <button
                key={value}
                role="tab"
                aria-selected={value === town.tab}
                className={value === town.tab ? "selected" : ""}
                onClick={() => town.selectTab(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <select
            id="scroll-kind"
            aria-label="卷轴类型"
            hidden={town.view !== "scrolls" || Boolean(town.directId)}
            value={town.scrollKind}
            onChange={(event) => {
              town.scrollKind = event.target.value;
              town.offset = 0;
              void town.load();
            }}
          >
            {[
              ["", "所有类型"],
              ["note", "笔记"],
              ["procedure", "操作流程"],
              ["lesson", "经验教训"],
              ["pattern", "方法模式"],
              ["guide", "指南"],
              ["skill", "技能"],
            ].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <input
            id="town-search"
            type="search"
            aria-label={social ? "搜索已加载的消息与作者" : "筛选当前列表"}
            placeholder={social ? "搜索消息、作者…" : "筛选当前列表…"}
            hidden={Boolean(town.directId) || town.view === "seeds"}
            value={town.search}
            onChange={(event) => town.setSearch(event.target.value)}
          />
          {town.view === "seeds" && !town.directId && <SeedSearch town={town} />}
          <div className="town-header-actions">
            <button
              id="town-write"
              className="secondary"
              hidden={!feed}
              disabled={
                !town.connected ||
                (feed === "fireside" && !(town.directId || town.selectedRing))
              }
              onClick={() => town.compose()}
            >
              {town.view === "mail" ? "写私信" : "写一句"}
            </button>
            <button
              id="town-auth-button"
              className="secondary"
              hidden={town.view === "seeds"}
              onClick={() => void town.auth()}
            >
              {town.authLabel}
            </button>
            <button
              id="town-refresh"
              className="icon-button"
              title="刷新内容"
              aria-label="刷新内容"
              disabled={town.reading}
              onClick={() => void (feed ? town.refresh() : town.load())}
            >
              ↻
            </button>
          </div>
        </div>
        <div className="town-live-row">
          <span
            id="town-live-status"
            role="status"
            data-phase={town.townApp?.client.status || "connecting"}
          >
            {town.view === "seeds" ? "Seed Garden · 公开经验" : liveMessage(town)}
          </span>
          <button
            id="town-live-retry"
            className="text-button"
            hidden={
              town.view === "seeds" || !town.townApp ||
              !["reconnecting", "auth_required", "identity_mismatch", "pair_storage_error"].includes(town.townApp.client.status)
            }
            onClick={() => void town.auth()}
          >
            重新连接
          </button>
          <button
            id="town-updates"
            className="text-button"
            hidden={!feed || !town.unread(feed)}
            onClick={() => void town.refresh()}
          >
            有新内容 · 更新
          </button>
        </div>
        <div
          id="town-status"
          className="list-status"
          role="status"
          aria-live="polite"
        >
          {town.status}
        </div>
        <div id="town-body" aria-busy={town.loading ? true : undefined}>
          {definition && <TownBody town={town} />}
        </div>
        <div id="town-pagination" className="pagination">
          {definition && <Pagination town={town} />}
        </div>
      </div>
    </section>
  );
}

/** The one sentence that says where the feed stands. The paired client reports
 * its own status and the background reader reports the feed's, and they are
 * different facts: a stale feed on a live connection is not a disconnection. */
export function liveMessage(town: TownModel): string {
  const client = town.townApp?.client;
  if (!client) return "正在读取 Town 连接状态";
  if (client.pairingPending) return "配对已完成但未能写入本机密钥库，请在连接面板重试保存。";
  if (!client.paired) return "尚未配对 Town。点右侧按钮，用 Being 提供的六位配对码连接。";
  if (client.status === "connected") return town.timelineStatus?.stale ? "已连接 Town · 当前内容可能不是最新" : "已连接 Town";
  // A refused credential stops the reads; it does not take back what was already
  // read. Saying so is the difference between a page that looks broken and one
  // that is merely no longer refreshing.
  if (client.status === "auth_required") return "Town 拒绝了本机凭据，请重新配对；已读取的内容仍可阅读。";
  if (client.status === "identity_mismatch") return "Town 返回的身份与已保存的配对不一致，读取已停止；已读取的内容仍可阅读。";
  if (client.status === "paused") return "Town 连接已暂停（离线或休眠）。";
  return "正在连接 Town…";
}

function TownBody({ town }: { town: TownModel }) {
  const feed = town.feedKind();
  if (town.error)
    return (
      <div className="empty-state">
        <div className="empty-symbol">{town.error.auth ? "⌑" : "↻"}</div>
        <h2>{town.error.auth ? "连接 Town，继续阅读" : "暂时未能读取内容"}</h2>
        <p>{town.error.message}</p>
        <button
          className="primary"
          onClick={() => {
            if (town.error?.auth) void town.auth();
            else void town.load();
          }}
        >
          {town.error.auth ? "配置 Town 连接" : "重试"}
        </button>
        {town.error.auth && (
          <button
            className="text-button"
            onClick={() => town.navigate("embers")}
          >
            阅读已公开的书架
          </button>
        )}
      </div>
    );
  if (town.loading) return <div className="loading-block">正在读取…</div>;
  if (town.directId && feed !== "fireside")
    return town.view === "seeds" ? <SeedDetail town={town} direct /> : <CatalogDetail town={town} direct />;
  if (feed === "fireside") return town.directId ? (
    <div className="direct-reading">
      <FiresideThread town={town} />
    </div>
  ) : <Firesides town={town} />;
  if (feed)
    return (
      <TownFeed
        key={`${town.view}:${town.tab}:${town.connectionRevision}`}
        town={town}
        messages={town.messages()}
        filterKey={town.view === "mail" ? town.tab : town.view}
      />
    );
  if (town.library) return <LocalKits town={town} />;
  if (!town.data) return null;
  if (town.view === "town") return <TownHome town={town} data={town.data} />;
  if (town.view === "seeds") return <SeedGarden town={town} data={town.data} />;
  return <Catalog town={town} data={town.data} />;
}

function Firesides({ town }: { town: TownModel }) {
  const entries = town.rooms(),
    owned = town.ownedRooms(),
    query = town.ringSearch.trim().toLowerCase();
  if (!entries.length)
    return (
      <div className="feed-empty">
        尚未加入围炉。你的 Being 创建或加入围炉后，会显示在这里。
      </div>
    );
  const visible = entries.filter((entry) =>
    str(entry.name, `围炉 #${str(entry.id)}`)
      .toLowerCase()
      .includes(query),
  );
  return (
    <div className="fireside-layout">
      <aside className="fireside-rooms" aria-label="围炉列表">
        <h2>我的围炉 · {entries.length}</h2>
        <input
          type="search"
          placeholder="查找围炉…"
          aria-label="查找围炉"
          value={town.ringSearch}
          onChange={(event) => {
            town.ringSearch = event.target.value;
            town.changed();
          }}
        />
        <div className="fireside-room-list">
          {[...entries]
            .sort((a, b) => str(a.name).localeCompare(str(b.name), "zh-CN"))
            .map((entry) => {
              const id = str(entry.id),
                title = str(entry.name, `围炉 #${id}`);
              return (
                <button
                  className={`fireside-room${id === town.selectedRing ? " selected" : ""}`}
                  data-id={id}
                  key={id}
                  hidden={!visible.includes(entry)}
                  aria-pressed={id === town.selectedRing}
                  onClick={() => void town.loadFireside(id, title)}
                >
                  <strong>{title}</strong>
                  <span>{`${owned.has(id) ? "我创建的" : "已加入"}${entry.member_count !== undefined ? " · " + str(entry.member_count) + " 位成员" : ""}`}</span>
                </button>
              );
            })}
        </div>
        <p className="empty-inline" hidden={visible.length > 0}>
          没有匹配的围炉
        </p>
      </aside>
      <section className="fireside-thread" aria-label="围炉消息">
        <FiresideThread town={town} />
      </section>
    </div>
  );
}

function FiresideThread({ town }: { town: TownModel }) {
  if (town.detailLoading)
    return <p className="empty-inline">正在读取围炉消息…</p>;
  if (town.detailError) return <DetailError town={town} />;
  if (!town.timeline) return null;
  return (
    <>
      <div className="fireside-thread-heading">
        <h2>{town.ringTitle}</h2>
        <button
          className="secondary"
          disabled={town.reading}
          onClick={() =>
            void town.loadFireside(
              town.directId || town.selectedRing,
              town.ringTitle,
              true,
            )
          }
        >
          刷新消息
        </button>
      </div>
      <TownFeed
        key={`${town.selectedRing}:${town.connectionRevision}`}
        town={town}
        messages={town.messages()}
        filterKey="firesides"
      />
    </>
  );
}
