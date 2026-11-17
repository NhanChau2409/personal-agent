import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config } from "./config.js";

type Account = { sub: string; email: string; refresh: string; scopes?: string[] };
type Task = { id: string; title: string; status?: string; due?: string; notes?: string; position?: string; updated?: string };
type TaskList = { id: string; title: string };
type Calendar = { id: string; summary: string; primary?: boolean; selected?: boolean; accessRole?: string };
type CalendarEvent = { id: string; summary?: string; description?: string; htmlLink?: string; status?: string; start?: { date?: string; dateTime?: string }; end?: { date?: string; dateTime?: string } };
type DriveFile = { id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string; iconLink?: string };
const keys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const scopes = ["openid", "email", "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/drive.file"];

export class GoogleTasks {
  private accounts: Account[] = [];
  private states = new Map<string, number>();
  private key: Buffer;
  private saving = Promise.resolve();
  constructor(private config: NonNullable<Config["google"]>, private origin: string) {
    this.key = Buffer.from(config.tokenKey, "base64");
    if (this.key.length !== 32) throw new Error("GOOGLE_TOKEN_KEY must be 32 random bytes encoded as base64");
    if (!origin.startsWith("https://") && !origin.startsWith("http://127.0.0.1:") && !origin.startsWith("http://localhost:")) throw new Error("Google OAuth requires HTTPS PUBLIC_ORIGIN");
  }
  async initialize() {
    try {
      const encrypted = await readFile(this.config.store, "utf8");
      const [iv, tag, data] = encrypted.split(".").map((s) => Buffer.from(s, "base64url"));
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv); decipher.setAuthTag(tag);
      this.accounts = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString()) as Account[];
      if (this.accounts.length > 1) this.accounts = [this.accounts[0]];
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private async save() {
    this.saving = this.saving.then(async () => {
      const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.key, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(this.accounts)), cipher.final()]);
      const content = [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
      await mkdir(path.dirname(this.config.store), { recursive: true });
      const temp = `${this.config.store}.${process.pid}.tmp`; await writeFile(temp, content, { mode: 0o600 }); await rename(temp, this.config.store);
    });
    return this.saving;
  }
  authorizeUrl() {
    for (const [state, expiry] of this.states) if (expiry < Date.now()) this.states.delete(state);
    const state = randomBytes(32).toString("base64url"); this.states.set(state, Date.now() + 600_000);
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: `${this.origin}/api/google/callback`, response_type: "code",
      scope: scopes.join(" "), access_type: "offline", prompt: "select_account consent", include_granted_scopes: "true", state }).toString();
    return url.toString();
  }
  async connect(state: string, code: string) {
    const expiry = this.states.get(state); this.states.delete(state);
    if (!expiry || expiry < Date.now()) throw new Error("Invalid or expired authorization state");
    const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: this.config.clientId, client_secret: this.config.clientSecret, redirect_uri: `${this.origin}/api/google/callback`, grant_type: "authorization_code" }) });
    if (!response.ok) throw new Error("Google authorization failed");
    const token = await response.json() as { refresh_token?: string; id_token?: string; scope?: string };
    if (!token.id_token) throw new Error("Google did not return account identity");
    const { payload } = await jwtVerify(token.id_token, keys, { audience: this.config.clientId, issuer: ["https://accounts.google.com", "accounts.google.com"] });
    if (payload.email_verified !== true || typeof payload.email !== "string" || !payload.sub) throw new Error("Unverified Google account");
    const existing = this.accounts.find((account) => account.sub === payload.sub); const refresh = token.refresh_token ?? existing?.refresh;
    if (!refresh) throw new Error("Google did not grant offline access; reconnect and approve consent");
    this.accounts = [{ sub: payload.sub, email: payload.email, refresh, scopes: token.scope?.split(" ") ?? scopes }];
    await this.save();
  }
  listAccounts() { return this.accounts.map(({ sub, email, scopes: granted }) => ({ id: sub, email, scopes: granted ?? [] })); }
  async disconnect(id: string) {
    const account = this.account(id); this.accounts = []; await this.save();
    await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: account.refresh }) }).catch(() => undefined);
  }
  private account(id?: string) {
    const account = id ? this.accounts.find((a) => a.sub === id) : this.accounts[0];
    if (!account) throw new Error("Google account is not connected"); return account;
  }
  private async accessToken(id?: string) {
    const account = this.account(id);
    const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, grant_type: "refresh_token", refresh_token: account.refresh }) });
    if (!response.ok) throw new Error(`Google account ${account.email} needs reconnection`);
    return (await response.json() as { access_token: string }).access_token;
  }
  private async request<T>(url: string, init?: RequestInit, id?: string): Promise<T> {
    const response = await fetch(url, { ...init, headers: { authorization: `Bearer ${await this.accessToken(id)}`, ...(init?.body ? { "content-type": "application/json" } : {}) } });
    if (!response.ok) { const detail = await response.text(); throw new Error(`Google API request failed (${response.status}): ${detail.slice(0, 200)}`); }
    return response.status === 204 ? undefined as T : await response.json() as T;
  }
  async lists(id?: string) {
    const result = await this.request<{ items?: TaskList[] }>("https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=100", undefined, id); return result.items ?? [];
  }
  async tasks(id: string | undefined, list: string) {
    const result = await this.request<{ items?: Task[] }>(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(list)}/tasks?maxResults=100&showCompleted=true&showHidden=true&showAssigned=true`, undefined, id); return result.items ?? [];
  }
  async overview() {
    const account = this.account();
    try { const lists = await this.lists(account.sub); return [{ id: account.sub, email: account.email, lists: await Promise.all(lists.map(async (list) => ({ ...list, tasks: await this.tasks(account.sub, list.id) }))) }]; }
    catch (error) { return [{ id: account.sub, email: account.email, lists: [], error: (error as Error).message }]; }
  }
  async create(id: string | undefined, list: string, title: string, due?: string) {
    return this.request<Task>(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(list)}/tasks`, { method: "POST", body: JSON.stringify({ title, ...(due ? { due: `${due}T00:00:00.000Z` } : {}) }) }, id);
  }
  async update(id: string | undefined, list: string, task: string, changes: { title?: string; status?: "completed" | "needsAction"; due?: string | null }) {
    const body = { ...changes, ...(changes.due === null ? { due: null } : changes.due ? { due: `${changes.due}T00:00:00.000Z` } : {}) };
    return this.request<Task>(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(list)}/tasks/${encodeURIComponent(task)}`, { method: "PATCH", body: JSON.stringify(body) }, id);
  }
  async calendars() {
    const result = await this.request<{ items?: Calendar[] }>("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=100"); return result.items ?? [];
  }
  async events(timeMin: string, timeMax: string) {
    const calendars = (await this.calendars()).filter((calendar) => calendar.selected !== false);
    const groups = await Promise.all(calendars.map(async (calendar) => {
      const query = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "100" });
      const result = await this.request<{ items?: CalendarEvent[] }>(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.id)}/events?${query}`);
      return (result.items ?? []).map((event) => ({ ...event, calendarId: calendar.id, calendar: calendar.summary }));
    }));
    return { calendars, events: groups.flat().sort((a, b) => (a.start?.dateTime ?? a.start?.date ?? "").localeCompare(b.start?.dateTime ?? b.start?.date ?? "")) };
  }
  async createEvent(input: { calendarId?: string; summary: string; start: string; end: string; allDay?: boolean; description?: string }) {
    const body = { summary: input.summary, description: input.description,
      start: input.allDay ? { date: input.start } : { dateTime: input.start }, end: input.allDay ? { date: input.end } : { dateTime: input.end } };
    return this.request<CalendarEvent>(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId ?? "primary")}/events`, { method: "POST", body: JSON.stringify(body) });
  }
  async files(query?: string) {
    const q = query?.trim() ? `trashed=false and name contains '${query.trim().replaceAll("'", "\\'")}'` : "trashed=false";
    const params = new URLSearchParams({ q, pageSize: "100", orderBy: "modifiedTime desc", fields: "files(id,name,mimeType,modifiedTime,webViewLink,iconLink)" });
    const result = await this.request<{ files?: DriveFile[] }>(`https://www.googleapis.com/drive/v3/files?${params}`); return result.files ?? [];
  }
  async createDocument(title: string) {
    return this.request<{ documentId: string; title: string }>("https://docs.googleapis.com/v1/documents", { method: "POST", body: JSON.stringify({ title }) });
  }
  async createSheet(title: string) {
    return this.request<{ spreadsheetId: string; spreadsheetUrl: string }>("https://sheets.googleapis.com/v4/spreadsheets", { method: "POST", body: JSON.stringify({ properties: { title } }) });
  }
  async readDocument(id: string) {
    const doc = await this.request<{ title: string; body?: { content?: Array<{ paragraph?: { elements?: Array<{ textRun?: { content?: string } }> } }> } }>(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(id)}`);
    return { title: doc.title, text: doc.body?.content?.flatMap((block) => block.paragraph?.elements?.map((element) => element.textRun?.content ?? "") ?? []).join("") ?? "" };
  }
  async readSheet(id: string, range = "A1:Z100") {
    return this.request<{ range: string; values?: unknown[][] }>(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}`);
  }
}
