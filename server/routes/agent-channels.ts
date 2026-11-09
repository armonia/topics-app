/**
 * `GET /api/agent-channels` - the titles of the Discord and WhatsApp chats the
 * agents answer in, keyed by chat id: `{ titles: { "<chat id>": "#lotto-siti" } }`.
 *
 * The agents' chats are named after the raw chat id («Gruppo 1564…»); the
 * channel bridge (jarvis-channels) already knows each chat's title, in the
 * `chat_title` of its turns. This route reads it, read-only, so the Agents
 * view can say the channel's name instead of a number.
 *
 * No database there (another machine, a fresh install): an empty map, never
 * an error, and the view keeps the stored names.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { AppContext, RouteHandler } from "../types";

const CACHE_MS = 60_000;

export function channelsDbPath(env: Record<string, string | undefined> = process.env): string {
  return env.JARVIS_CHANNELS_DB?.trim() || join(homedir(), "Library", "Application Support", "jarvis-channels", "channels.sqlite");
}

/**
 * The last non-empty title of every chat and of every thread inside it. A
 * thread is keyed `<chat>:<thread>`; a chat with no thread (and the chat's
 * latest title, as a fallback for a thread the bridge never titled) is keyed
 * by the bare `<chat>`.
 */
export function readChannelTitles(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const db = new Database(path, { readonly: true });
  try {
    const out: Record<string, string> = {};
    const titled = `json_extract(meta, '$.chat_title') <> ''`;
    const hasThread = (db.query("PRAGMA table_info(turns)").all() as { name: string }[]).some((c) => c.name === "thread");
    const chats = db.query(
      `SELECT chat, json_extract(meta, '$.chat_title') AS title FROM turns
       WHERE id IN (SELECT max(id) FROM turns WHERE ${titled} GROUP BY chat)`,
    ).all() as { chat: string; title: string | null }[];
    for (const r of chats) if (r.title) out[r.chat] = r.title;
    if (!hasThread) return out;
    // The bare chat prefers its own un-threaded turns over a thread's title.
    const bare = db.query(
      `SELECT chat, json_extract(meta, '$.chat_title') AS title FROM turns
       WHERE (thread IS NULL OR thread = '')
         AND id IN (SELECT max(id) FROM turns WHERE ${titled} AND (thread IS NULL OR thread = '') GROUP BY chat)`,
    ).all() as { chat: string; title: string | null }[];
    for (const r of bare) if (r.title) out[r.chat] = r.title;
    const threads = db.query(
      `SELECT chat, thread, json_extract(meta, '$.chat_title') AS title FROM turns
       WHERE thread IS NOT NULL AND thread <> ''
         AND id IN (SELECT max(id) FROM turns WHERE ${titled} AND thread IS NOT NULL AND thread <> '' GROUP BY chat, thread)`,
    ).all() as { chat: string; thread: string; title: string | null }[];
    for (const r of threads) if (r.title) out[`${r.chat}:${r.thread}`] = r.title;
    return out;
  } catch {
    return {};
  } finally {
    db.close();
  }
}

export function createAgentChannelsRouter(ctx: Pick<AppContext, "json">, path: () => string = () => channelsDbPath()): RouteHandler {
  let cache: { at: number; titles: Record<string, string> } | null = null;
  return async function agentChannelsRouter(_req, _url, pathname, method) {
    if (pathname !== "/api/agent-channels" || method !== "GET") return null;
    if (!cache || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), titles: readChannelTitles(path()) };
    return ctx.json({ titles: cache.titles });
  };
}
