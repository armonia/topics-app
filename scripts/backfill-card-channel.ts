#!/usr/bin/env bun
/**
 * Links the OPEN cards (backlog, todo, in_progress, review) born from a Jarvis
 * channel to that channel's chat (`channel_topic_id`), where the link can be
 * proved. Dry run by default: it prints every card it would link and the proof,
 * and every card it leaves alone and why. `--apply` writes. Safe to run again:
 * a card that already has a channel is skipped.
 *
 *   bun run scripts/backfill-card-channel.ts [--apply] [--db PATH] [--channels-home DIR]
 *
 * The proof, in order of strength (the first that yields ONE chat wins; any
 * rule that yields two different chats stops the card, because in doubt we
 * do not link):
 *   thread-registry   jarvis-channels opened a tracked thread for this very card.
 *   discord-link      the description or a comment holds a Discord link whose
 *                     thread/channel id maps to one chat (Jarvis writes comments
 *                     through the API, so a comment's author says nothing).
 *   same-title        the card's title is the name of exactly one channel chat.
 * A channel name merely cited in a text is too weak (a description often names the
 * thread where the outcome will be posted, not where the work came from): it does not count.
 *
 * The chats come from `topics.json` of jarvis-channels (conversation key ->
 * chat id): it is the live map, while the database also keeps stale chats with
 * the same name. Only the chat's id is written, through the board PATCH.
 */
import { Database } from "bun:sqlite";
import { homedir } from "os";
import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const opt = (name: string, dflt: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
};
const DB_PATH = opt("--db", process.env.TOPICS_DB ?? `${homedir()}/Projects/topics-app/data/topics.db`);
const CHANNELS_HOME = opt("--channels-home", `${homedir()}/Library/Application Support/jarvis-channels`);
const BASE = process.env.TOPICS_URL ?? "https://127.0.0.1:3333";
const CA = process.env.TOPICS_CA ?? `${homedir()}/Projects/topics-app/certs/ca-cert.pem`;
const OPEN = ["backlog", "todo", "in_progress", "review"];

export interface Evidence { topicId: string; rule: "thread-registry" | "discord-link" | "same-title"; why: string }
export type Verdict = { link: Evidence } | { skip: string };

type ChatMap = Record<string, { id: string; name?: string }>;

const normalize = (s: string): string => s.toLowerCase().replace(/^#/, "").replace(/\s+/g, " ").trim();

/**
 * The chat of Jarvis' own conversation in a Discord channel or thread: keys of the
 * form `discord:<channel>:<thread>`. The same thread also has a `visione:` key (the
 * other agent's chat) and a `jarvis:discord:` one (the "Jarvis work" chat): those
 * are other chats, not the channel, and would make every link ambiguous.
 */
export function chatsForDiscordId(chats: ChatMap, id: string): Set<string> {
  const out = new Set<string>();
  for (const [key, chat] of Object.entries(chats)) {
    if (/^discord:\d+:\d+$/.test(key) && key.endsWith(`:${id}`)) out.add(chat.id);
  }
  return out;
}

/** The live channel chats by normalized name: only names that point to ONE chat can prove a title. */
export function chatsByName(chats: ChatMap): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [key, chat] of Object.entries(chats)) {
    if (!key.startsWith("discord:") && !key.startsWith("whatsapp:")) continue;
    const n = normalize(chat.name ?? "");
    if (n) (out.get(n) ?? out.set(n, new Set()).get(n)!).add(chat.id);
  }
  return out;
}

export interface CardFacts {
  id: string;
  title: string;
  /** The description and every comment of the card. */
  texts: string[];
  /** The chats the thread registry ties to this card, already resolved. */
  registryChats: string[];
}

export function judge(card: CardFacts, chats: ChatMap): Verdict {
  const unique = (ids: Iterable<string>) => [...new Set(ids)];
  if (card.registryChats.length) {
    const ids = unique(card.registryChats);
    return ids.length === 1
      ? { link: { topicId: ids[0]!, rule: "thread-registry", why: "jarvis-channels tracked a thread for this card" } }
      : { skip: `thread registry names ${ids.length} different chats` };
  }
  const linked = new Set<string>();
  const links: string[] = [];
  for (const text of card.texts) {
    for (const m of text.matchAll(/discord\.com\/channels\/\d+\/(\d+)(?:\/(\d+))?/g)) {
      const found = chatsForDiscordId(chats, m[2] ?? m[1]!);
      if (found.size) { links.push(m[0]); for (const c of found) linked.add(c); }
    }
  }
  if (linked.size > 1) return { skip: `its Discord links point to ${linked.size} different chats` };
  if (linked.size === 1) return { link: { topicId: [...linked][0]!, rule: "discord-link", why: `written link ${links[0]}` } };
  const named = chatsByName(chats).get(normalize(card.title));
  if (named?.size === 1) return { link: { topicId: [...named][0]!, rule: "same-title", why: "the title is the name of exactly one channel chat" } };
  if (named && named.size > 1) return { skip: "the title names more than one channel chat" };
  return { skip: "no proof: no tracked thread, no Discord link to a known channel, no title equal to a channel" };
}

function token(): string {
  if (process.env.TOPICS_TOKEN) return process.env.TOPICS_TOKEN;
  return spawnSync("security", ["find-generic-password", "-s", "topics", "-a", "agent-token", "-w"], { encoding: "utf8" }).stdout.trim();
}

async function patch(projectId: string, taskId: string, topicId: string): Promise<boolean> {
  const res = await fetch(`${BASE}/api/boards/${projectId}/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-agent-token": token(), "x-topics-agent": "jarvis" },
    body: JSON.stringify({ channelTopicId: topicId }),
    tls: existsSync(CA) ? { ca: readFileSync(CA, "utf8"), checkServerIdentity: () => undefined } : undefined,
  } as RequestInit);
  return res.ok;
}

async function main(): Promise<void> {
  const chats = JSON.parse(readFileSync(`${CHANNELS_HOME}/topics.json`, "utf8")) as ChatMap;
  const db = new Database(DB_PATH, { readonly: true });
  const reg = new Database(`${CHANNELS_HOME}/channels.sqlite`, { readonly: true });
  // Before the migration reaches this database there is no column yet: every card is then without a channel.
  const hasColumn = (db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).some((c) => c.name === "channel_topic_id");
  const cards = db.query(
    `SELECT id, project_id, text, COALESCE(description, '') AS description FROM tasks
     WHERE archived = 0 AND status IN (${OPEN.map(() => "?").join(",")}) ${hasColumn ? "AND channel_topic_id IS NULL" : ""} AND parent_task_id IS NULL`,
  ).all(...OPEN) as Array<{ id: string; project_id: string; text: string; description: string }>;
  const comments = db.prepare("SELECT content FROM task_comments WHERE task_id = ?");
  const threads = reg.prepare("SELECT channel, chat, thread FROM threads WHERE card IS NOT NULL AND (card = ?1 OR ?1 LIKE card || '%')");
  let linked = 0;
  for (const c of cards) {
    const registryChats = (threads.all(c.id) as Array<{ chat: string; thread: string }>).flatMap((t) => [...chatsForDiscordId(chats, t.thread)]);
    const verdict = judge({
      id: c.id, title: c.text,
      texts: [c.description, ...(comments.all(c.id) as Array<{ content: string }>).map((r) => r.content)],
      registryChats,
    }, chats);
    const label = `${c.id.slice(0, 8)} ${c.text.slice(0, 60)}`;
    if ("skip" in verdict) { console.log(`SKIP  ${label} — ${verdict.skip}`); continue; }
    const name = Object.values(chats).find((v) => v.id === verdict.link.topicId)?.name ?? verdict.link.topicId;
    if (!APPLY) { console.log(`LINK  ${label} -> ${name} [${verdict.link.rule}: ${verdict.link.why}]`); linked++; continue; }
    const ok = await patch(c.project_id, c.id, verdict.link.topicId);
    console.log(`${ok ? "DONE " : "FAIL "} ${label} -> ${name} [${verdict.link.rule}: ${verdict.link.why}]`);
    if (ok) linked++;
  }
  console.log(`\n${APPLY ? "linked" : "would link"} ${linked} of ${cards.length} open cards without a channel`);
}

if (import.meta.main) await main();
