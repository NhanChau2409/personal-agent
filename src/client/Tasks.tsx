import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, Check, Circle, ExternalLink, FileText, Pencil, Plus, RefreshCw, X } from "lucide-react";

type Task = { id: string; title: string; status?: string; due?: string; position?: string };
type List = { id: string; title: string; tasks: Task[] };
type Account = { id: string; email: string; lists: List[]; error?: string };
type Item = Task & { account: string; email: string; list: string; listTitle: string };
type CalendarEvent = { id: string; summary?: string; htmlLink?: string; calendar?: string; start?: { date?: string; dateTime?: string }; end?: { date?: string; dateTime?: string } };
type DriveFile = { id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string };

function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: init?.body ? { "content-type": "application/json" } : undefined, cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function Tasks() {
  const [open, setOpen] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [editing, setEditing] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editDue, setEditDue] = useState("");
  const [tab, setTab] = useState<"tasks" | "calendar" | "files">("tasks");
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [eventTitle, setEventTitle] = useState("");
  const [eventStart, setEventStart] = useState("");
  const [eventEnd, setEventEnd] = useState("");
  const [fileTitle, setFileTitle] = useState("");
  const refresh = useCallback(async () => {
    try {
      const connection = await api<{ configured: boolean; accounts: { id: string; email: string }[] }>("/api/google/accounts");
      setConfigured(connection.configured);
      if (connection.configured && connection.accounts.length) {
        const from = new Date(); from.setDate(from.getDate() - 7);
        const to = new Date(); to.setDate(to.getDate() + 90);
        const [tasks, calendar, drive] = await Promise.all([
          api<{ accounts: Account[] }>("/api/tasks"),
          api<{ events: CalendarEvent[] }>(`/api/calendar?timeMin=${encodeURIComponent(from.toISOString())}&timeMax=${encodeURIComponent(to.toISOString())}`),
          api<{ files: DriveFile[] }>("/api/drive/files")
        ]);
        setAccounts(tasks.accounts); setEvents(calendar.events); setFiles(drive.files);
      } else { setAccounts([]); setEvents([]); setFiles([]); }
      setError("");
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60_000);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  const destinations = accounts.flatMap((account) => account.lists.map((list) => ({ key: `${account.id}:${list.id}`, ...account, list })));
  const selected = destinations.find((destination) => destination.key === target) ?? destinations[0];
  const items = useMemo(() => accounts.flatMap((account) => account.lists.flatMap((list) => list.tasks.map((task) => ({
    ...task, account: account.id, email: account.email, list: list.id, listTitle: list.title
  })))), [accounts]);
  const date = today();
  const groups: [string, Item[]][] = [
    ["Overdue", items.filter((item) => item.status !== "completed" && item.due && item.due.slice(0, 10) < date)],
    ["Today", items.filter((item) => item.status !== "completed" && item.due?.slice(0, 10) === date)],
    ["Upcoming", items.filter((item) => item.status !== "completed" && item.due && item.due.slice(0, 10) > date)],
    ["Unscheduled", items.filter((item) => item.status !== "completed" && !item.due)],
    ["Completed", items.filter((item) => item.status === "completed")]
  ];
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !title.trim()) return;
    setBusy(true);
    try {
      await api("/api/tasks", { method: "POST", body: JSON.stringify({ account: selected.id, list: selected.list.id, title: title.trim(), ...(due ? { due } : {}) }) });
      setTitle(""); setDue(""); await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function saveEdit(event: React.FormEvent, item: Item) {
    event.preventDefault();
    if (!editTitle.trim()) return;
    setBusy(true);
    try {
      await api(`/api/tasks/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({
        account: item.account, list: item.list, title: editTitle.trim(), due: editDue || null
      }) });
      setEditing(""); await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function toggle(item: Item) {
    setBusy(true);
    try {
      await api(`/api/tasks/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({
        account: item.account, list: item.list, status: item.status === "completed" ? "needsAction" : "completed"
      }) });
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function createEvent(event: React.FormEvent) {
    event.preventDefault(); if (!eventTitle || !eventStart || !eventEnd) return; setBusy(true);
    try { await api("/api/calendar/events", { method: "POST", body: JSON.stringify({ summary: eventTitle, start: new Date(eventStart).toISOString(), end: new Date(eventEnd).toISOString() }) });
      setEventTitle(""); setEventStart(""); setEventEnd(""); await refresh(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function createFile(kind: "documents" | "sheets") {
    if (!fileTitle.trim()) return; setBusy(true);
    try { await api(`/api/drive/${kind}`, { method: "POST", body: JSON.stringify({ title: fileTitle.trim() }) }); setFileTitle(""); await refresh(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <>
    <button className="tasks-trigger" onClick={() => setOpen(true)}>Workspace <span>{items.filter((item) => item.status !== "completed").length}</span></button>
    {open && <button className="tasks-backdrop" aria-label="Close tasks" onClick={() => setOpen(false)} />}
    <aside className={`tasks-panel ${open ? "tasks-open" : ""}`} aria-label="Google Workspace">
      <div className="tasks-heading"><div><p>GOOGLE WORKSPACE</p><h2>{tab === "tasks" ? "Tasks" : tab === "calendar" ? "Calendar" : "Files"}</h2></div><div className="tasks-actions">
        <button aria-label="Refresh tasks" onClick={() => void refresh()}><RefreshCw size={18} /></button>
        <button className="tasks-close" aria-label="Close tasks" onClick={() => setOpen(false)}><X size={20} /></button>
      </div></div>
      {error && <p className="tasks-error" role="alert">{error}</p>}
      {!configured ? <p className="tasks-hint">Google Tasks is not configured on the server yet.</p> : <>
        <div className="tasks-accounts">
          {accounts.map((account) => <div key={account.id} className="tasks-account"><span title={account.email}>{account.email}</span>
            <button title={`Disconnect ${account.email}`} aria-label={`Disconnect ${account.email}`} onClick={async () => {
              if (!window.confirm(`Disconnect ${account.email} from Google Tasks?`)) return;
              try { await api(`/api/google/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" }); await refresh(); }
              catch (e) { setError((e as Error).message); }
            }}><X size={14} /></button></div>)}
          <a className="tasks-connect" href="/api/google/connect"><Plus size={16} /> {accounts.length ? "Reconnect Google account" : "Connect Google account"}</a>
        </div>
        {!!accounts.length && <nav className="workspace-tabs">
          <button className={tab === "tasks" ? "active" : ""} onClick={() => setTab("tasks")}><Check size={15} />Tasks</button>
          <button className={tab === "calendar" ? "active" : ""} onClick={() => setTab("calendar")}><CalendarDays size={15} />Calendar</button>
          <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}><FileText size={15} />Files</button>
        </nav>}
        {accounts.map((account) => account.error && <p key={account.id} className="tasks-error">{account.email}: {account.error}</p>)}
        {tab === "tasks" && !!destinations.length && <form className="tasks-create" onSubmit={(event) => void create(event)}>
          <input aria-label="New task" placeholder="Add a task…" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={1024} required />
          <div><select aria-label="Account and list" value={selected?.key} onChange={(event) => setTarget(event.target.value)}>
            {destinations.map((destination) => <option key={destination.key} value={destination.key}>{destination.email} · {destination.list.title}</option>)}
          </select><input aria-label="Due date" type="date" value={due} onChange={(event) => setDue(event.target.value)} />
          <button disabled={busy} aria-label="Create task" type="submit"><Plus size={18} /></button></div>
        </form>}
        {tab === "tasks" && <div className="tasks-scroll">
          {loading && <p className="tasks-hint">Loading workspace…</p>}
          {!loading && !accounts.length && <p className="tasks-hint">Connect a Google account to see its tasks here.</p>}
          {groups.map(([name, tasks]) => !!tasks.length && <section className="tasks-group" key={name}>
            <button className="tasks-group-title" onClick={() => name === "Completed" && setShowCompleted(!showCompleted)} aria-expanded={name === "Completed" ? showCompleted : undefined}>
              {name} <span>{tasks.length}</span>
            </button>
            {(name !== "Completed" || showCompleted) && tasks.map((item) => <div className="tasks-item" key={`${item.account}:${item.list}:${item.id}`}>
              <button disabled={busy} aria-label={`${item.status === "completed" ? "Reopen" : "Complete"} ${item.title}`} onClick={() => void toggle(item)}>
                {item.status === "completed" ? <Check size={18} /> : <Circle size={18} />}</button>
              <div className="tasks-item-content">{editing === `${item.account}:${item.list}:${item.id}` ?
                <form className="tasks-edit" onSubmit={(event) => void saveEdit(event, item)}>
                  <input aria-label="Task title" value={editTitle} onChange={(event) => setEditTitle(event.target.value)} maxLength={1024} required />
                  <input aria-label="Task due date" type="date" value={editDue} onChange={(event) => setEditDue(event.target.value)} />
                  <button type="submit" disabled={busy}>Save</button><button type="button" onClick={() => setEditing("")}>Cancel</button>
                </form> : <><div className={item.status === "completed" ? "tasks-done" : ""}>{item.title}</div>
                  <small>{item.email} · {item.listTitle}{item.due ? ` · ${item.due.slice(0, 10)}` : ""}</small></>}
              </div><button aria-label={`Edit ${item.title}`} onClick={() => {
                setEditing(`${item.account}:${item.list}:${item.id}`); setEditTitle(item.title); setEditDue(item.due?.slice(0, 10) ?? "");
              }}><Pencil size={15} /></button>
            </div>)}
          </section>)}
        </div>}
        {tab === "calendar" && <><form className="tasks-create" onSubmit={(event) => void createEvent(event)}>
          <input placeholder="Event title" value={eventTitle} onChange={(event) => setEventTitle(event.target.value)} required />
          <div><input type="datetime-local" value={eventStart} onChange={(event) => setEventStart(event.target.value)} required />
            <input type="datetime-local" value={eventEnd} onChange={(event) => setEventEnd(event.target.value)} required />
            <button disabled={busy} aria-label="Create event"><Plus size={18} /></button></div>
        </form><div className="tasks-scroll">{events.map((event) => <div className="workspace-entry" key={`${event.calendar}:${event.id}`}>
          <CalendarDays size={17} /><div><strong>{event.summary || "Untitled event"}</strong><small>{event.calendar} · {new Date(event.start?.dateTime ?? event.start?.date ?? "").toLocaleString()}</small></div>
          {event.htmlLink && <a href={event.htmlLink} target="_blank" rel="noreferrer" aria-label="Open event"><ExternalLink size={15} /></a>}
        </div>)}</div></>}
        {tab === "files" && <><div className="tasks-create"><input placeholder="New document or sheet title" value={fileTitle} onChange={(event) => setFileTitle(event.target.value)} />
          <div><button type="button" disabled={busy} onClick={() => void createFile("documents")}>New Doc</button><button type="button" disabled={busy} onClick={() => void createFile("sheets")}>New Sheet</button></div>
        </div><div className="tasks-scroll">{files.map((file) => <div className="workspace-entry" key={file.id}><FileText size={17} /><div><strong>{file.name}</strong><small>{file.mimeType.replace("application/vnd.google-apps.", "Google ")}</small></div>
          {file.webViewLink && <a href={file.webViewLink} target="_blank" rel="noreferrer" aria-label={`Open ${file.name}`}><ExternalLink size={15} /></a>}</div>)}</div></>}
      </>}
    </aside>
  </>;
}
