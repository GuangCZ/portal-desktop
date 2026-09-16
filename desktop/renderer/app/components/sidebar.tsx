// The conversation sidebar. Ported from BeingDesktop 0.8.26 renderer/sidebar.js
// and the inline rename editor in renderer/app.js (line 1475); 2026-09-16.
// Behaviour rules: docs/sidebar-interaction.md — 「会话列表按最后消息时间排列；
// 打开会话不会将它重新置顶」,「归档只修改本机侧栏元数据」.
//
// DEVIATIONS from 0.8.26, all recorded in docs/migration/p1-ui.md:
// · the session menu is drawn here rather than by Electron's native menu, since
//   this shell has no `showSessionMenu` channel;
// · pins, projects and archives are in memory only (OrganizerModel);
// · deleting a conversation asks a second time in the shell's own dialog, where
//   0.8.26 relied on the native menu being a deliberate act.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AppModel } from "../models/app";
import { useModel } from "../../shared/hooks/use-model";
import { Dialog } from "../../shared/components/dialog";
import { age, basename } from "../../conversation/models/organizer";
import type { ConversationModel } from "../../conversation/models/conversation";
import type { ChatSessionSummary } from "../../../shared/desktop-types";

export function Sidebar({ model }: { model: AppModel }) {
  const app = useModel(model);
  const conversation = useModel(app.conversation);
  const organizer = useModel(app.conversation.organizer);
  const [menu, setMenu] = useState("");
  const [editing, setEditing] = useState("");
  const [forgetting, setForgetting] = useState<ChatSessionSummary | null>(null);
  const [search, setSearch] = useState(false);
  const connected = conversation.connected;
  const groups = organizer.groups(conversation.sessions);
  useEffect(() => {
    organizer.setProjects(app.snapshot?.settings.workspace ? [app.snapshot.settings.workspace] : []);
  }, [organizer, app.snapshot?.settings.workspace]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.repeat) return;
      if (document.querySelector("dialog[open]")) return;
      const key = event.key.toLowerCase();
      // ⌘1 is the shell's "back to the conversation", so 0.8.26's ⌘1–9 session
      // switching is not bound here (docs/migration/p1-ui.md).
      if (key === "n" && connected) { event.preventDefault(); void conversation.create(); }
      if (key === "k") { event.preventDefault(); setSearch(true); }
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [conversation, connected]);
  const row = (session: ChatSessionSummary) => (
    <SessionRow
      key={session.id}
      session={session}
      app={app}
      conversation={conversation}
      editing={editing === session.id}
      menuOpen={menu === session.id}
      onMenu={open => setMenu(open ? session.id : "")}
      onEdit={open => setEditing(open ? session.id : "")}
      onForget={() => setForgetting(session)}
    />
  );
  return (
    <nav className="session-sidebar" aria-label="会话">
      <div className="sidebar-head">
        <button
          type="button"
          className="sidebar-action"
          disabled={!connected}
          title={app.api?.platform === "win32" ? "新会话 Ctrl N" : "新会话 ⌘ N"}
          onClick={() => void conversation.create()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          新会话
        </button>
        <button
          type="button"
          className="sidebar-action"
          title={app.api?.platform === "win32" ? "搜索会话 Ctrl K" : "搜索会话 ⌘ K"}
          onClick={() => setSearch(true)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
          搜索会话
        </button>
      </div>
      <div className="sidebar-scroll">
        {groups.pinned.length > 0 && (
          <section className="sidebar-section" aria-label="已置顶">
            <h2 className="sidebar-section-title">已置顶</h2>
            {groups.pinned.map(row)}
          </section>
        )}
        {groups.projects.map(project => (
          <ProjectGroup key={project.path} project={project} connected={connected} conversation={conversation}>
            {project.sessions.map(row)}
          </ProjectGroup>
        ))}
        <section className="sidebar-section" aria-label="会话">
          <h2 className="sidebar-section-title">会话</h2>
          {groups.standalone.map(row)}
          {!groups.standalone.length && (
            <p className="sidebar-empty">
              {connected ? "暂无独立会话" : "连接 Being 后，会话会显示在这里。"}
            </p>
          )}
        </section>
      </div>
      <div className="sidebar-foot">
        <span className="sidebar-being">{app.snapshot?.settings.being || "Being"}</span>
        <span className="sidebar-being-status">
          {connected ? "已连接" : app.snapshot?.settings.hasToken ? "连接中…" : "未连接"}
        </span>
      </div>
      <SearchDialog open={search} onClose={() => setSearch(false)} app={app} />
      <Dialog
        className="utility-dialog"
        aria-label="删除会话"
        open={Boolean(forgetting)}
        onClose={() => setForgetting(null)}
      >
        <div className="chat-confirm">
          <p>{`删除「${forgetting?.title || "新会话"}」的本机记录？Being 的记忆不会被删除，它仍然记得你们说过的话。`}</p>
          <div className="dialog-footer">
            <button type="button" className="secondary" onClick={() => setForgetting(null)}>取消</button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                const target = forgetting;
                setForgetting(null);
                if (target) void conversation.forget(target.id);
              }}
            >
              删除本机记录
            </button>
          </div>
        </div>
      </Dialog>
    </nav>
  );
}

function ProjectGroup({ project, connected, conversation, children }: {
  project: { path: string; name: string; sessions: ChatSessionSummary[] };
  connected: boolean;
  conversation: ConversationModel;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const id = useId();
  return (
    <section className="sidebar-section" aria-label={`项目 ${project.name}`}>
      <div className="sidebar-project-row">
        <button
          type="button"
          className="sidebar-project-toggle"
          aria-expanded={open}
          aria-controls={id}
          title={project.path}
          onClick={() => setOpen(value => !value)}
        >
          <svg className={`sidebar-chevron${open ? " is-open" : ""}`} viewBox="0 0 12 12" aria-hidden="true"><path d="m4.5 3 3 3-3 3" /></svg>
          {project.name}
        </button>
        <button
          type="button"
          className="icon-button compact"
          aria-label={`在 ${project.name} 中新建会话`}
          title={`在 ${project.name} 中新建会话`}
          disabled={!connected}
          onClick={() => void conversation.create().then(id => { if (id) conversation.organizer.move(id, project.path); })}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>
      <div id={id} hidden={!open}>
        {children}
        {!project.sessions.length && <p className="sidebar-empty">这个项目里还没有会话</p>}
      </div>
    </section>
  );
}

function SessionRow({ session, app, conversation, editing, menuOpen, onMenu, onEdit, onForget }: {
  session: ChatSessionSummary;
  app: AppModel;
  conversation: ConversationModel;
  editing: boolean;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  onEdit: (open: boolean) => void;
  onForget: () => void;
}) {
  const organizer = conversation.organizer;
  const value = organizer.metadata(session.id);
  const active = session.id === conversation.activeId && app.view === "chat";
  const activity = session.busy ? "talking" : session.inFlight ? "waiting" : "";
  const label = activity === "talking" ? "进行中" : activity === "waiting" ? "等待回复" : "";
  const menu = useRef<HTMLDivElement>(null);
  // The close callback is read through a ref rather than depended on: a reply
  // streaming into another conversation re-renders this row several times a
  // second, and an effect that re-ran would pull focus back to the first menu
  // item every time.
  const close = useRef(onMenu);
  useLayoutEffect(() => { close.current = onMenu; });
  useEffect(() => {
    if (!menuOpen) return;
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: Event) => {
      if (!menu.current?.parentElement?.contains(event.target as Node)) close.current(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menuOpen]);
  if (editing)
    return (
      <RenameEditor
        session={session}
        onDone={() => onEdit(false)}
        rename={(title) => conversation.rename(session.id, title)}
      />
    );
  return (
    <div className="sidebar-task-row" onContextMenu={event => { event.preventDefault(); onMenu(true); }}>
      <button
        type="button"
        className={`session-shortcut${active ? " active" : ""}`}
        aria-current={active ? "page" : undefined}
        aria-label={`${session.title || "新会话"}${label ? `，${label}` : ""}`}
        title={[session.title, label, value.project].filter(Boolean).join("\n")}
        disabled={!conversation.connected}
        onClick={() => {
          app.navigate("chat");
          void conversation.select(session.id);
        }}
      >
        <span className={`session-activity-light ${activity || "inactive"}`} aria-hidden="true" />
        <span className="session-title">{session.title || "新会话"}</span>
        <span className="task-age">{age(session)}</span>
      </button>
      <button
        type="button"
        className="icon-button compact task-more"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`会话「${session.title || "新会话"}」的更多操作`}
        onClick={() => onMenu(!menuOpen)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg>
      </button>
      {menuOpen && (
        <div
          className="sidebar-menu"
          ref={menu}
          role="menu"
          aria-label="会话操作"
          onKeyDown={event => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onMenu(false); return; }
            if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
            event.preventDefault();
            const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || [])];
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1) + buttons.length) % buttons.length]?.focus();
          }}
        >
          <button type="button" role="menuitem" onClick={() => { onMenu(false); organizer.pin(session.id); }}>
            {value.pinned ? "取消置顶" : "置顶"}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!conversation.connected}
            onClick={() => { onMenu(false); onEdit(true); }}
          >
            重命名
          </button>
          {organizer.projects.filter(path => path !== value.project).map(path => (
            <button key={path} type="button" role="menuitem" onClick={() => { onMenu(false); organizer.move(session.id, path); }}>
              移到 {basename(path)}
            </button>
          ))}
          {value.project && (
            <button type="button" role="menuitem" onClick={() => { onMenu(false); organizer.move(session.id, ""); }}>
              移出项目
            </button>
          )}
          <div className="sidebar-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onMenu(false);
              organizer.archive(session.id);
              app.toast(value.archived ? "会话已恢复" : "会话已归档，可从搜索中恢复。");
            }}
          >
            {value.archived ? "取消归档" : "归档会话"}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!conversation.connected}
            onClick={() => { onMenu(false); onForget(); }}
          >
            删除会话
          </button>
        </div>
      )}
    </div>
  );
}

/** 0.8.26's inline editor: Enter saves, Escape cancels, blur saves, and an
 * unchanged or empty title just closes without calling the channel. A refusal
 * keeps the editor open with what was typed (renderer/app.js line 1486). */
function RenameEditor({ session, rename, onDone }: {
  session: ChatSessionSummary;
  rename: (title: string) => Promise<boolean>;
  onDone: () => void;
}) {
  const [value, setValue] = useState(session.title);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { input.current?.select(); }, []);
  const save = async () => {
    if (saving || done.current) return;
    const title = value.trim();
    if (!title || title === session.title) { done.current = true; onDone(); return; }
    setSaving(true);
    if (await rename(title)) { done.current = true; onDone(); return; }
    setSaving(false);
    input.current?.focus();
    input.current?.select();
  };
  return (
    <div className="sidebar-task-row session-editing">
      <input
        ref={input}
        className="session-name-input"
        autoFocus
        maxLength={80}
        aria-label="会话名称"
        title="Enter 保存，Esc 取消"
        readOnly={saving}
        value={value}
        onChange={event => setValue(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!saving) { done.current = true; onDone(); } }
          if (event.key === "Enter") { event.preventDefault(); void save(); }
        }}
      />
    </div>
  );
}

function SearchDialog({ open, onClose, app }: { open: boolean; onClose: () => void; app: AppModel }) {
  const conversation = useModel(app.conversation);
  const organizer = useModel(app.conversation.organizer);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"active" | "archived">("active");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = organizer.search(conversation.sessions, query, filter);
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setFilter("active");
    setIndex(0);
    input.current?.focus();
  }, [open]);
  const selected = Math.min(index, Math.max(0, results.length - 1));
  const openResult = (session: ChatSessionSummary) => {
    if (organizer.metadata(session.id).archived) organizer.archive(session.id);
    onClose();
    app.navigate("chat");
    void conversation.select(session.id);
  };
  return (
    <Dialog id="session-search" aria-label="搜索会话" open={open} onClose={onClose} dismissOnBackdrop>
      <div className="chat-search-field">
        <input
          ref={input}
          type="search"
          placeholder="搜索会话名…"
          aria-label="搜索会话"
          autoComplete="off"
          value={query}
          onChange={event => { setQuery(event.target.value); setIndex(0); }}
          onKeyDown={event => {
            if (["ArrowDown", "ArrowUp"].includes(event.key)) {
              event.preventDefault();
              setIndex(value => (value + (event.key === "ArrowDown" ? 1 : -1) + Math.max(1, results.length)) % Math.max(1, results.length));
            }
            if (event.key === "Enter" && !event.nativeEvent.isComposing && results[selected]) {
              event.preventDefault();
              openResult(results[selected]);
            }
          }}
        />
        <button className="icon-button close" type="button" aria-label="关闭搜索" onClick={onClose} />
      </div>
      <div className="sidebar-search-filters">
        {(["active", "archived"] as const).map(value => (
          <button
            key={value}
            type="button"
            className="secondary"
            aria-pressed={filter === value}
            onClick={() => { setFilter(value); setIndex(0); }}
          >
            {value === "active" ? "会话" : "已归档"}
          </button>
        ))}
      </div>
      <div className="sidebar-search-results" role="listbox" aria-label="会话搜索结果">
        {results.map((session, at) => (
          <button
            key={session.id}
            type="button"
            role="option"
            aria-selected={at === selected}
            className={`sidebar-search-result${at === selected ? " is-selected" : ""}`}
            onClick={() => openResult(session)}
          >
            <span className="search-result-title">{session.title || "新会话"}</span>
            <span className="search-result-project">
              {organizer.metadata(session.id).project ? basename(organizer.metadata(session.id).project) : "独立会话"}
            </span>
          </button>
        ))}
        {!results.length && (
          <p className="sidebar-empty">
            {query.trim() ? "没有找到匹配的会话" : filter === "archived" ? "没有已归档的会话" : "暂无会话"}
          </p>
        )}
      </div>
    </Dialog>
  );
}
