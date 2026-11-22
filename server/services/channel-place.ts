/**
 * Where a channel chat lives, resolved on the server from the channel bridge's
 * own database (read-only): `server › channel › thread` on Discord, group on
 * WhatsApp. The client only draws what it is told, it never asks Discord.
 *
 * No database (another machine, a fresh install) or an unknown chat: no place,
 * and the chip keeps showing the chat's own name.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { channelsDbPath } from "./channels-db-path";
import type { ChannelPlace } from "../../shared/channel-origin";

export type { ChannelPlace };

const CACHE_MS = 60_000;
let cache: { at: number; path: string; byTitle: Map<string, ChannelPlace> } | null = null;

const norm = (s: string) => s.trim().replace(/^#/, "").toLowerCase();

interface TurnRow { chat: string; thread: string | null; title: string | null; guild: string | null }

/** Every titled chat and thread the bridge knows, keyed by its normalized title. */
export function readChannelPlaces(path: string): Map<string, ChannelPlace> {
  const out = new Map<string, ChannelPlace>();
  if (!existsSync(path)) return out;
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.query(
      `SELECT chat, thread, json_extract(meta, '$.chat_title') AS title, json_extract(meta, '$.guild_title') AS guild
       FROM turns WHERE id IN (SELECT max(id) FROM turns WHERE json_extract(meta, '$.chat_title') <> '' GROUP BY chat, coalesce(thread, ''))`,
    ).all() as TurnRow[];
    const parentOf = new Map<string, { title: string; guild: string | null }>();
    for (const r of rows) if (!r.thread && r.title) parentOf.set(r.chat, { title: r.title, guild: r.guild });
    const hasThreads = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get();
    const opened = hasThreads ? (db.query("SELECT chat, thread, title FROM threads").all() as { chat: string; thread: string; title: string }[]) : [];
    const all: TurnRow[] = [...rows, ...opened.map((t) => ({ chat: t.chat, thread: t.thread, title: t.title, guild: null }))];
    for (const r of all) {
      if (!r.title) continue;
      const parent = parentOf.get(r.chat);
      const server = r.guild || parent?.guild || undefined;
      const place: ChannelPlace = r.thread
        ? { ...(server ? { server } : {}), ...(parent ? { channel: parent.title.replace(/^#/, "") } : {}), thread: r.title.replace(/^#/, "") }
        : { ...(server ? { server } : {}), channel: r.title.replace(/^#/, "") };
      // A thread title wins over nothing, never over a channel that carries the same name.
      if (!out.has(norm(r.title)) || !r.thread) out.set(norm(r.title), place);
    }
    return out;
  } catch {
    return out;
  } finally {
    db.close();
  }
}

/** The place of the chat called `name`, or null when the bridge does not know it. */
export function channelPlaceOf(name: string, path: string = channelsDbPath()): ChannelPlace | null {
  if (!name.trim()) return null;
  if (!cache || cache.path !== path || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), path, byTitle: readChannelPlaces(path) };
  return cache.byTitle.get(norm(name)) ?? null;
}

/**
 * Same places as {@link readChannelPlaces}, keyed by the chat/thread RAW ID
 * (`<chat>` or `<chat>:<thread>`, same keying as `readChannelTitles` in
 * `../routes/agent-channels`) instead of by title: the Agents channel tree
 * (`/api/agent-channels/places`) groups chats by server without having to
 * round-trip through a title match.
 */
export function readChannelPlacesById(path: string): Record<string, ChannelPlace> {
  const out: Record<string, ChannelPlace> = {};
  if (!existsSync(path)) return out;
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.query(
      `SELECT chat, thread, json_extract(meta, '$.chat_title') AS title, json_extract(meta, '$.guild_title') AS guild
       FROM turns WHERE id IN (SELECT max(id) FROM turns WHERE json_extract(meta, '$.chat_title') <> '' GROUP BY chat, coalesce(thread, ''))`,
    ).all() as TurnRow[];
    const parentOf = new Map<string, { title: string; guild: string | null }>();
    for (const r of rows) if (!r.thread && r.title) parentOf.set(r.chat, { title: r.title, guild: r.guild });
    const hasThreads = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get();
    const opened = hasThreads ? (db.query("SELECT chat, thread, title FROM threads").all() as { chat: string; thread: string; title: string }[]) : [];
    const all: TurnRow[] = [...rows, ...opened.map((t) => ({ chat: t.chat, thread: t.thread, title: t.title, guild: null }))];
    for (const r of all) {
      const parent = parentOf.get(r.chat);
      const server = r.guild || parent?.guild || undefined;
      const key = r.thread ? `${r.chat}:${r.thread}` : r.chat;
      const place: ChannelPlace = { ...(server ? { server } : {}) };
      if (parent && r.thread) place.channel = parent.title.replace(/^#/, "");
      if (r.thread && r.title) place.thread = r.title.replace(/^#/, "");
      if (Object.keys(place).length) out[key] = place;
    }
    return out;
  } catch {
    return out;
  } finally {
    db.close();
  }
}
