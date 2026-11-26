/**
 * WHAT A PROJECT HAS SPENT of the weekly Claude quota (project quota).
 *
 * Born from a measured miss: on 2026-11-17 an account rose from 0 to 90% of
 * the week in nine hours and nobody noticed, because `project-usage.ts` (the
 * dashboard's dollar view) never looks at the native engine's share of the real
 * spend, nor at Claude Code transcripts running outside Topics entirely. This
 * module answers a narrower, truer question: not "how many tokens", but "how
 * many points of the weekly quota", the unit `person-usage.ts` already reports
 * per PERSON, reusing its `pointsPerHour` and `splitPoints` rather than writing
 * a second copy.
 *
 * Which calls there are, what each weighs and which project each belongs to is
 * `project-calls.ts`. Here the hour's points are split across them and summed
 * per project, per surface (card, chat, their subagents, outside Topics,
 * one-shot calls) and per chat. Every call lands in exactly one project row or
 * in the "outside projects" row (`projectId: null`), so the rows add up to the
 * quota the account really lost.
 */
import type { Database } from "bun:sqlite";
import { QUOTA_SURFACES, type ProjectQuotaResult, type ProjectQuotaRow, type QuotaChatRow, type QuotaPoints, type QuotaSurface } from "../../shared/usage-shapes";
import { HOUR_MS, pointsPerHour, readHistory, splitPoints, usageHistoryFile } from "./person-usage";
import { collectProjectCalls, type TranscriptFile } from "./project-calls";
import { buildFolderResolver } from "./project-folders";
import { readProjectLimits, resolveProjectLimit } from "./project-limit";

export interface ProjectQuotaOptions {
  now?: number;
  historyFile?: string;
  listTranscripts?: () => TranscriptFile[];
  /** Where the worktree manager keeps worktrees; the server's own root by default. */
  worktreesRoot?: string;
}

const TOP_CHATS = 5;

interface Bucket { w24: number; w7: number; p24: number; p7: number }
const emptyBucket = (): Bucket => ({ w24: 0, w7: 0, p24: 0, p7: 0 });

function add(b: Bucket, weight: number, points: number, in24h: boolean): void {
  b.w7 += weight; b.p7 += points;
  if (in24h) { b.w24 += weight; b.p24 += points; }
}

interface ProjectTotals extends Bucket {
  projectPath: string | null;
  surfaces: Map<QuotaSurface, Bucket>;
  chats: Map<string, Bucket & { surface: "card" | "chat" }>;
}

/** Points in the last 24h and last 7d, per project, from the quota history's hourly rise split by call weight. */
export function projectQuota(db: Database, o: ProjectQuotaOptions = {}): ProjectQuotaResult {
  const untilMs = o.now ?? Date.now();
  const sinceMs = untilMs - 7 * 24 * HOUR_MS;
  const since24hMs = untilMs - 24 * HOUR_MS;
  const folders = buildFolderResolver(db, o.worktreesRoot);
  const calls = collectProjectCalls(db, folders, { sinceMs, untilMs, listTranscripts: o.listTranscripts });
  const history = readHistory(o.historyFile ?? usageHistoryFile());
  const quotaHistory = !!history;
  if (history) splitPoints(calls, pointsPerHour(history, sinceMs, untilMs));

  const OUTSIDE = "\u0000outside";
  const byProject = new Map<string, ProjectTotals>();
  const totalsOf = (key: string, path: string | null): ProjectTotals => {
    let e = byProject.get(key);
    if (!e) byProject.set(key, (e = { ...emptyBucket(), projectPath: path, surfaces: new Map(), chats: new Map() }));
    return e;
  };
  // Registered projects with no calls still get their row: the meter needs their limit.
  for (const p of folders.projects) totalsOf(p.id, p.path);

  const chatNames = new Map((db.query("SELECT id, name FROM topics").all() as Array<{ id: string; name: string }>).map((t) => [t.id, t.name]));
  for (const c of calls) {
    const e = c.projectId ? totalsOf(c.projectId, c.projectPath) : totalsOf(OUTSIDE, null);
    e.projectPath ??= c.projectPath;
    const points = c.points ?? 0;
    const in24h = c.ts > since24hMs;
    add(e, c.weight, points, in24h);
    let s = e.surfaces.get(c.surface);
    if (!s) e.surfaces.set(c.surface, (s = emptyBucket()));
    add(s, c.weight, points, in24h);
    if (c.chatId && c.projectId) {
      let ch = e.chats.get(c.chatId);
      if (!ch) e.chats.set(c.chatId, (ch = { ...emptyBucket(), surface: c.surface === "card" || c.surface === "cardSubagent" ? "card" : "chat" }));
      add(ch, c.weight, points, in24h);
    }
  }

  const pointsOf = (b: Bucket): QuotaPoints => ({ points24h: quotaHistory ? round1(b.p24) : null, points7d: quotaHistory ? round1(b.p7) : null });
  const rows: ProjectQuotaRow[] = [...byProject].map(([key, e]) => {
    const projectId = key === OUTSIDE ? null : key;
    const topChats: QuotaChatRow[] = [...e.chats].map(([chatId, b]) => ({ topicId: chatId, title: chatNames.get(chatId) ?? chatId, surface: b.surface, ...pointsOf(b), _rank: quotaHistory ? [b.p24, b.p7] : [b.w24, b.w7] }))
      .sort((a, b) => b._rank[0]! - a._rank[0]! || b._rank[1]! - a._rank[1]!)
      .slice(0, TOP_CHATS).map(({ _rank, ...row }) => row);
    return {
      projectId, projectPath: e.projectPath, ...pointsOf(e),
      weighted24h: Math.round(e.w24), weighted7d: Math.round(e.w7),
      limit: null,
      surfaces: Object.fromEntries(QUOTA_SURFACES.map((s) => [s, pointsOf(e.surfaces.get(s) ?? emptyBucket())])) as Record<QuotaSurface, QuotaPoints>,
      topChats,
    };
  }).sort((a, b) => (b.points7d ?? b.weighted7d) - (a.points7d ?? a.weighted7d));

  return withLimits(db, { quotaHistory, projects: rows });
}

/**
 * Each row's current limit. Apart from the count so a caller that reuses a
 * minute-old count (the route) still shows a limit changed a second ago.
 */
export function withLimits(db: Database, result: ProjectQuotaResult): ProjectQuotaResult {
  const limits = readProjectLimits(db);
  return {
    ...result,
    projects: result.projects.map((p) => ({
      ...p,
      limit: p.projectId === null ? null : resolveProjectLimit(p.projectId, limits.get(p.projectId)),
    })),
  };
}

function round1(x: number): number { return Math.round(x * 10) / 10; }
