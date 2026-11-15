import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config } from "./config.js";

type Account = { sub: string; email: string; refresh: string };
type Task = { id: string; title: string; status?: string; due?: string; notes?: string; position?: string; parent?: string; updated?: string };
type TaskList = { id: string; title: string };
const keys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const scopes = "openid email https://www.googleapis.com/auth/tasks";

export class GoogleTasks {
  private accounts: Account[] = [];
  private states = new Map<string, number>();
  private key: Buffer;
  private saving = Promise.resolve();
  constructor(private config: NonNullable<Config["google"]>, private origin: string) {
    this.key = Buffer.from(config.tokenKey, "base64");
    if (this.key.length !== 32) throw new Error("GOOGLE_TOKEN_KEY must be 32 random bytes encoded as base64");
    if (!origin.startsWith("https://") && !origin.startsWith("http://127.0.0.1:") && !origin.startsWith("http://localhost:")) {
      throw new Error("Google OAuth requires HTTPS PUBLIC_ORIGIN");
    }
  }
  async initialize() {
    try {
      const encrypted = await readFile(this.config.store, "utf8");
      const [iv, tag, data] = encrypted.split(".").map((s) => Buffer.from(s, "base64url"));
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      this.accounts = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString()) as Account[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private async save() {
    this.saving = this.saving.then(async () => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(this.accounts)), cipher.final()]);
      const content = [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
      await mkdir(path.dirname(this.config.store), { recursive: true });
      const temp = `${this.config.store}.${process.pid}.tmp`;
      await writeFile(temp, content, { mode: 0o600 });
      await rename(temp, this.config.store);
    });
    return this.saving;
  }
  authorizeUrl() {
    for (const [state, expiry] of this.states) if (expiry < Date.now()) this.states.delete(state);
    const state = randomBytes(32).toString("base64url");
    this.states.set(state, Date.now() + 10 * 60_000);
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: `${this.origin}/api/google/callback`,
      response_type: "code", scope: scopes, access_type: "offline", prompt: "select_account consent", state }).toString();
    return url.toString();
  }
  async connect(state: string, code: string) {
    const expiry = this.states.get(state);
    this.states.delete(state);
    if (!expiry || expiry < Date.now()) throw new Error("Invalid or expired authorization state");
    const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: this.config.clientId, client_secret: this.config.clientSecret,
        redirect_uri: `${this.origin}/api/google/callback`, grant_type: "authorization_code" }) });
    if (!response.ok) throw new Error("Google authorization failed");
    const token = await response.json() as { refresh_token?: string; id_token?: string };
    if (!token.id_token) throw new Error("Google did not return account identity");
    const { payload } = await jwtVerify(token.id_token, keys, { audience: this.config.clientId,
      issuer: ["https://accounts.google.com", "accounts.google.com"] });
    if (payload.email_verified !== true || typeof payload.email !== "string" || !payload.sub) throw new Error("Unverified Google account");
    const existing = this.accounts.find((account) => account.sub === payload.sub);
    const refresh = token.refresh_token ?? existing?.refresh;
    if (!refresh) throw new Error("Google did not grant offline access; reconnect and approve consent");
    this.accounts = [...this.accounts.filter((account) => account.sub !== payload.sub), { sub: payload.sub, email: payload.email, refresh }];
    await this.save();
  }
  listAccounts() { return this.accounts.map(({ sub, email }) => ({ id: sub, email })); }
  async disconnect(id: string) {
    const account = this.account(id);
    this.accounts = this.accounts.filter((a) => a.sub !== id);
    await this.save();
    // Token revocation is best effort; never restore credentials after disconnect.
    await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: account.refresh }) }).catch(() => undefined);
  }
  private account(id: string) {
    const account = this.accounts.find((a) => a.sub === id);
    if (!account) throw new Error("Google account is not connected");
    return account;
  }
  private async request<T>(id: string, endpoint: string, init?: RequestInit): Promise<T> {
    const account = this.account(id);
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret,
        grant_type: "refresh_token", refresh_token: account.refresh }) });
    if (!tokenResponse.ok) throw new Error(`Google account ${account.email} needs reconnection`);
    const token = await tokenResponse.json() as { access_token: string };
    const response = await fetch(`https://tasks.googleapis.com/tasks/v1/${endpoint}`, {
      ...init, headers: { authorization: `Bearer ${token.access_token}`, ...(init?.body ? { "content-type": "application/json" } : {}) }
    });
    if (!response.ok) throw new Error(`Google Tasks request failed (${response.status}) for ${account.email}`);
    return response.status === 204 ? undefined as T : await response.json() as T;
  }
  async lists(id: string) {
    const lists: TaskList[] = [];
    let pageToken: string | undefined;
    do {
      const result: { items?: TaskList[]; nextPageToken?: string } = await this.request(id, `users/@me/lists?${new URLSearchParams({ maxResults: "100", ...(pageToken ? { pageToken } : {}) })}`);
      lists.push(...result.items ?? []);
      pageToken = result.nextPageToken;
    } while (pageToken);
    return lists;
  }
  async tasks(id: string, list: string) {
    const tasks: Task[] = [];
    let pageToken: string | undefined;
    do {
      const result: { items?: Task[]; nextPageToken?: string } = await this.request(id, `lists/${encodeURIComponent(list)}/tasks?${new URLSearchParams({ maxResults: "100", showCompleted: "true", showHidden: "true", showAssigned: "true", ...(pageToken ? { pageToken } : {}) })}`);
      tasks.push(...result.items ?? []);
      pageToken = result.nextPageToken;
    } while (pageToken);
    return tasks;
  }
  async overview() {
    return Promise.all(this.listAccounts().map(async (account) => {
      try {
        const lists = await this.lists(account.id);
        return { ...account, lists: await Promise.all(lists.map(async (list) => ({ ...list, tasks: await this.tasks(account.id, list.id) }))) };
      } catch (error) { return { ...account, lists: [], error: (error as Error).message }; }
    }));
  }
  async create(id: string, list: string, title: string, due?: string) {
    return this.request<Task>(id, `lists/${encodeURIComponent(list)}/tasks`, { method: "POST",
      body: JSON.stringify({ title, ...(due ? { due: `${due}T00:00:00.000Z` } : {}) }) });
  }
  async update(id: string, list: string, task: string, changes: { title?: string; status?: "completed" | "needsAction"; due?: string | null }) {
    const body = { ...changes, ...(changes.due === null ? { due: null } : changes.due ? { due: `${changes.due}T00:00:00.000Z` } : {}) };
    return this.request<Task>(id, `lists/${encodeURIComponent(list)}/tasks/${encodeURIComponent(task)}`, { method: "PATCH", body: JSON.stringify(body) });
  }
}
