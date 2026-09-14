import { useLayoutEffect, useRef } from "react";
import { TownModel, definitions, list, str } from "./models/town";
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
export function Town({ model }: { model: TownModel }) {
  const town = useModel(model),
    definition = definitions[town.view],
    channel = town.channel(),
    social = Boolean(channel),
    root = useRef<HTMLElement>(null);
  useLayoutEffect(() => { if (root.current) root.current.scrollTop = 0; }, [town.view, town.directId]);
  return (
    <section
      id="town-view"
      ref={root}
      className={`view${social ? " social-view" : ""}${town.view === "embers" ? " bookshelf-view" : ""}${town.view === "kits" && town.tab === "grove" && !town.directId ? " kit-catalog" : ""}${town.view === "seeds" && !town.directId ? " seed-catalog" : ""}`}
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
              hidden={!channel}
              disabled={
                town.live?.phase !== "connected" ||
                (town.view === "firesides" &&
                  !(town.directId || town.selectedRing))
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
              onClick={() => void town.load()}
            >
              ↻
            </button>
          </div>
        </div>
        <div className="town-live-row">
          <span
            id="town-live-status"
            role="status"
            data-phase={town.live?.phase || "connecting"}
          >
            {town.view === "seeds" ? "Seed Garden · 公开经验" : town.live?.message || "正在读取 Town 连接状态"}
          </span>
          <button
            id="town-live-retry"
            className="text-button"
            hidden={
              town.view === "seeds" || !town.live ||
              !["reconnecting", "auth-error"].includes(town.live.phase)
            }
            onClick={() => void town.run(() => town.api.reconnectTown())}
          >
            重新连接
          </button>
          <button
            id="town-updates"
            className="text-button"
            hidden={!channel || !town.unread(channel)}
            onClick={() => void town.load()}
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
function TownBody({ town }: { town: TownModel }) {
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
  if (town.directId)
    return town.view === "firesides" ? (
      <div className="direct-reading">
        <FiresideThread town={town} />
      </div>
    ) : town.view === "seeds" ? <SeedDetail town={town} direct /> : (
      <CatalogDetail town={town} direct />
    );
  if (town.library) return <LocalKits town={town} />;
  if (!town.data) return null;
  if (town.view === "town") return <TownHome town={town} data={town.data} />;
  if (town.view === "bonfire" || town.view === "mail")
    return (
      <TownFeed
        key={`${town.view}:${town.tab}:${town.live?.generation}`}
        town={town}
        data={town.data}
        filterKey={town.view === "mail" ? town.tab : town.view}
      />
    );
  if (town.view === "firesides") return <Firesides town={town} />;
  if (town.view === "seeds") return <SeedGarden town={town} data={town.data} />;
  return <Catalog town={town} data={town.data} />;
}
function Firesides({ town }: { town: TownModel }) {
  const entries = town.rooms(),
    owned = new Set(list(town.data!, "owned").map((entry) => str(entry.id))),
    query = town.ringSearch.trim().toLowerCase();
  if (!entries.length)
    return (
      <div className="feed-empty">
        尚未加入围炉。你的 Being 创建或加入围炉后，会显示在这里。
      </div>
    );
  const visible = entries.filter((entry) =>
    `${str(entry.name, `围炉 #${str(entry.id)}`)} ${str(entry.description)}`
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
          {entries
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
  const data = town.ringData?.data;
  if (!data) return null;
  return (
    <>
      <div className="fireside-thread-heading">
        <h2>{town.ringTitle}</h2>
        <button
          className="secondary"
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
        key={`${town.ringData?.id}:${town.live?.generation}`}
        town={town}
        data={data}
        filterKey="firesides"
      />
    </>
  );
}
