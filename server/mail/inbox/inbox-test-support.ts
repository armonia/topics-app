/** Shared pieces of the inbox tests: a file database with the real migrations, a clock, a scripted adapter. */
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContractMessage, ListAdapter, ListRequest, ListResponse } from "./contract";
import type { Mailbox } from "./mailboxes";

const MIGRATIONS = join(import.meta.dir, "../../db/migrations");
const FILES = ["20261126100000-scheduled-delivery.sql", "20261128100000-mail-inbox.sql"];
// The settings column belongs to the real migration chain; the tables are what is under test.
const SQL = FILES.map((file) => readFileSync(join(MIGRATIONS, file), "utf8").replace(/ALTER TABLE app_settings[^;]*;/g, "")).join("\n");

export interface TestDb { path: string; open: () => Database; dispose: () => void }

/** A database FILE, so two connections can share it like two servers would. */
export function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), "mail-inbox-"));
  const path = join(dir, "test.db");
  const opened: Database[] = [];
  const open = () => {
    const db = new Database(path);
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;"); // the same pragmas as the real database
    opened.push(db);
    return db;
  };
  open().exec(SQL);
  return { path, open, dispose: () => { for (const db of opened) { try { db.close(true); } catch { /* closed */ } } rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
}

export const clock = (start = "2026-11-28T10:00:00.000Z") => {
  const state = { at: new Date(start) };
  return { now: () => state.at, advance: (ms: number) => { state.at = new Date(state.at.getTime() + ms); } };
};

export const mailbox = (patch: Partial<Mailbox> = {}): Mailbox => ({
  name: "box", addresses: ["me@example.test"], adapter: { argv: ["/bin/adapter"], env: {} }, trustedAuthserv: "mx.example.test",
  agentsMayWait: true, rulesEnabled: false, windowHours: 72, fromEnv: false, ...patch,
});

export const message = (id: string, receivedAt: string, patch: Partial<ContractMessage> = {}): ContractMessage => ({
  id, threadId: `t-${id}`, messageId: `<${id}@example.test>`, inReplyTo: null, from: "sender@example.test", to: ["me@example.test"],
  subject: `Subject ${id}`, snippet: `Snippet ${id}`, authResults: "mx.example.test; dmarc=pass", sentAt: receivedAt, receivedAt, ...patch,
});

/** An adapter that serves the oldest `limit` messages after the cursor (a timestamp in ms) and records every request. */
export function scriptedAdapter(all: ContractMessage[]) {
  const requests: ListRequest[] = [];
  const state = { failWith: null as Error | null, expireCursors: false, gate: null as Promise<void> | null };
  const adapter: ListAdapter = async (request) => {
    requests.push(request);
    if (state.gate) await state.gate;
    if (state.failWith) throw state.failWith;
    if (request.cursor && state.expireCursors) return { messages: [], cursor: null, more: false, expired: true } satisfies ListResponse;
    const from = request.cursor ? Number(request.cursor) : request.sinceMs;
    const after = all.filter((item) => Date.parse(item.receivedAt) > from).sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
    const messages = after.slice(0, request.limit);
    const newest = messages.length ? Date.parse(messages[messages.length - 1]!.receivedAt) : null;
    return { messages, cursor: newest === null ? request.cursor : String(newest), more: after.length > messages.length, expired: false };
  };
  return { adapter, requests, state };
}
