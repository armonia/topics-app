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
import { readAgentActivity, readAgentTurns, type AgentActivityRow, type AgentTurn } from "../services/agent-activity";
import { readChannelPlacesById } from "../services/channel-place";
import { channelsDbPath } from "../services/channels-db-path";
import type { AppContext, RouteHandler } from "../types";

export { channelsDbPath };

const CACHE_MS = 60_000;

/** The channel names the bridge recorded on its turns (empty when the column or the file is missing). */
export function readTurnChannels(path: string): string[] {
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    const hasChannel = (db.query("PRAGMA table_info(turns)").all() as { name: string }[]).some((c) => c.name === "channel");
    if (!hasChannel) return [];
    return (db.query("SELECT DISTINCT channel FROM turns WHERE channel IS NOT NULL AND channel <> ''").all() as { channel: string }[]).map((r) => r.channel);
  } catch {
    return [];
  } finally {
    db.close();
  }
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
    // Threads the bridge opened itself for a new conversation (its `threads`
    // table, 09/11) have a title before anyone answers in them.
    for (const r of openedThreads(db)) out[`${r.chat}:${r.thread}`] ??= r.title;
    // A thread says the channel it lives in: «#pm-jarvis › Migrazione siti».
    for (const key of Object.keys(out)) {
      const [chat, thread] = key.split(":");
      const parent = thread ? out[chat] : undefined;
      if (parent && out[key] !== parent && !out[key].startsWith(`${parent} › `)) out[key] = `${parent} › ${out[key].replace(/^#/, "")}`;
    }
    return out;
  } catch {
    return {};
  } finally {
    db.close();
  }
}

export type OpenedThread = { chat: string; thread: string; title: string; link: string; card: string | null };

function openedThreads(db: Database): OpenedThread[] {
  const has = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get();
  if (!has) return [];
  return db.query("SELECT chat, thread, title, link, card FROM threads ORDER BY rowid").all() as OpenedThread[];
}

/** The Discord threads tied to a card (by full id or 8-char prefix), newest last. */
export function readCardThreads(path: string, cardId: string): OpenedThread[] {
  if (!existsSync(path) || !cardId) return [];
  const db = new Database(path, { readonly: true });
  try {
    return openedThreads(db).filter((t) => !!t.card && (cardId.startsWith(t.card) || t.card.startsWith(cardId)));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function createAgentChannelsRouter(ctx: Pick<AppContext, "json">, path: () => string = () => channelsDbPath()): RouteHandler {
  let cache: { at: number; titles: Record<string, string> } | null = null;
  let activityCache: { at: number; rows: AgentActivityRow[]; turns: AgentTurn[] } | null = null;
  let placesCache: { at: number; places: ReturnType<typeof readChannelPlacesById> } | null = null;
  return async function agentChannelsRouter(_req, _url, pathname, method) {
    // `GET /api/agent-channels/card/<id>`: the Discord threads opened for that card, with their links.
    const card = /^\/api\/agent-channels\/card\/([\w-]+)$/.exec(pathname);
    if (card && method === "GET") return ctx.json({ threads: readCardThreads(path(), card[1]) });
    // `GET /api/agent-channels/places`: the server/channel/thread each chat lives in — the Agents
    // channel tree (Configure › Canali e chat) groups chats under their Discord server with it.
    if (pathname === "/api/agent-channels/places" && method === "GET") {
      if (!placesCache || Date.now() - placesCache.at > CACHE_MS) placesCache = { at: Date.now(), places: readChannelPlacesById(path()) };
      return ctx.json({ places: placesCache.places });
    }
    // `GET /api/agent-channels/activity`: what each agent handled in the last 7 days, per channel.
    if (pathname === "/api/agent-channels/activity" && method === "GET") {
      if (!activityCache || Date.now() - activityCache.at > CACHE_MS) activityCache = { at: Date.now(), rows: readAgentActivity(path()), turns: readAgentTurns(path()) };
      return ctx.json({ days: 7, rows: activityCache.rows, turns: activityCache.turns });
    }
    if (pathname !== "/api/agent-channels" || method !== "GET") return null;
    if (!cache || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), titles: readChannelTitles(path()) };
    return ctx.json({ titles: cache.titles });
  };
}
