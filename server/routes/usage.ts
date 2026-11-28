/**
 * THE ONE DOOR for "what is this costing", per session and per project.
 *
 * Both numbers already existed and neither had a way out of the server: the
 * native runtime's per-session token totals lived in an in-memory registry only
 * the dispatcher could see (`providers/native-usage-registry.ts`), and the
 * per-project consumption existed only as a grouping nobody had written yet.
 * This router is the two of them, and nothing else.
 *
 * NOT THE SAME QUESTION AS `/api/context/cost`, which stays where it is: that
 * one reads every `messages` row of ONE session to answer "how much does the
 * next call cost". These answer "how much has been spent", for many at a time.
 */
import type { AppContext, RouteHandler } from "../types";
import { listNativeUsage } from "../providers/native-usage-registry";
import { unknownPricedModels } from "../usage/pricing";
import { projectUsage, type ProjectUsageResult } from "../usage/project-usage";
import { getSessionConsumption } from "../services/session-consumption-wiring";
// THE ANSWER IS TYPED AT THE DOOR, not just described in a comment. The shape
// says the thing this route must never be read as - `absentMeansUnmeasured`,
// and a `cacheWrite1hTokens` that is a SUBSET and not another addend - so the
// annotation is what makes a field renamed in `shared/` a compile error here
// instead of a number that quietly stops arriving.
import type { SessionUsageResponse } from "../../shared/usage-shapes";
import type { Database } from "bun:sqlite";
import { computeCalls, peopleUsage, personDetail, type Computed } from "../usage/person-usage";
import { projectQuota, withLimits } from "../usage/project-quota";
import type { ProjectQuotaResponse, ProjectQuotaResult } from "../../shared/usage-shapes";
import { claudeProjectsRoot, topSessions } from "../usage/top-sessions";
import { sendToSession } from "../usage/top-sessions-send";
import type { WaitingStore } from "../attention/waiting-items";
import type { TopSessionsResult } from "../../shared/top-sessions";
import { authorForSender, mergeChannelPerson, parseSender, senderAllowed, type Sender } from "../lib/person-identities";

/**
 * The per-project aggregate is a GROUP BY over the whole `messages` table, and
 * that table is wide (`content`, `blocks` and `tool_calls` sit on the same row
 * as the usage columns, so the scan pulls overflow pages it does not need).
 * Measured on the live database, 23k messages and 3.8k tasks: 1.2 s on a
 * process's first call, 91 ms once the pages are warm, 24 ms for a 7-day
 * window. Cheap enough to ask for, far too expensive to poll - so a reading is
 * reused for a minute and `cachedAt` says how old the one you got is.
 *
 * The alternative would be a covering index, which is a migration - and a
 * migration file lands on the LIVE database seconds after it is saved. Not for
 * a panel that can read a value up to sixty seconds old.
 */
const PROJECT_TTL_MS = 60_000;

/** A transcript scan costs enough that every reader shares one reading; a minute keeps the meter within a minute of the truth. */
const PROJECT_QUOTA_TTL_MS = 60_000;

/** One transcript scan is shared by every reader for a minute. */
const TOP_SESSIONS_TTL_MS = 60_000;

export function createUsageRouter(ctx: AppContext, deps: { waiting?: WaitingStore; topSessionsRoot?: string } = {}): RouteHandler {
  const { db, json } = ctx;
  let topSessionsCache: { at: number; data: TopSessionsResult } | null = null;

  let cached: { at: number; days: number | null; data: ProjectUsageResult } | null = null;
  let peopleCache: { at: number; days: number; data: Computed } | null = null;
  let projectQuotaCache: { at: number; data: ProjectQuotaResult } | null = null;

  return async function usageRouter(
    _req: Request,
    url: URL,
    pathname: string,
    method: string,
  ): Promise<Response | null> {

    /**
     * GET /api/usage/sessions — token totals for EVERY live native session.
     *
     * One map read, no I/O, no database: safe to poll. The registry is capped
     * at 200 entries with eviction of the oldest, so a session that fell off
     * the end is ABSENT from `sessions` rather than present with zeros. Absent
     * means "this server has no measurement", never "it cost nothing" - the
     * same distinction `readNativeUsage` keeps by returning `null`.
     *
     * Deliberately NOT wired to the transcript reader that `getSessionUsage`
     * falls back to: that one opens multi-MB JSONL files, and a heavy probe
     * behind a polled route is how a panel starts costing more than what it
     * measures.
     */
    if (method === "GET" && pathname === "/api/usage/sessions") {
      const body: SessionUsageResponse = {
        sessions: listNativeUsage().map((u) => ({
          sessionKey: u.sessionKey,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheWriteTokens: u.cacheWriteTokens,
          cacheWrite1hTokens: u.cacheWrite1hTokens,
          cacheReadTokens: u.cacheReadTokens,
          billableTokens: u.billableTokens,
        })),
        source: "native-runtime",
        absentMeansUnmeasured: true,
      };
      return json(body);
    }

    /**
     * GET /api/usage/consumption: what each LIVE session costs, process by
     * process: the same answer the load screen of the PC reads, joined from the
     * existing sources (the fleet's process table, the native registry, the
     * transcripts, the card's counter) and written nowhere. It reads a cached
     * table (2 s), so it is safe to poll.
     */
    if (method === "GET" && pathname === "/api/usage/consumption") {
      return json(await getSessionConsumption(ctx).read());
    }

    // GET /api/usage/top-sessions: the heaviest sessions of the last 24 h, from the user's own transcripts.
    if (method === "GET" && pathname === "/api/usage/top-sessions") {
      const now = Date.now();
      if (!topSessionsCache || now - topSessionsCache.at >= TOP_SESSIONS_TTL_MS) {
        topSessionsCache = { at: now, data: await topSessions({ root: deps.topSessionsRoot, now }) };
        for (const s of topSessionsCache.data.sessions) {
          if (s.hog) deps.waiting?.open({ tipo: "decisione", key: `hog:${s.id}`, title: s.title || s.id, why: `One session has been open for over 24 h and does at least half of the consumption (${Math.round(s.weekShare * 100)}% of the week).`, from: "usage" }, { at: now });
        }
      }
      return json(topSessionsCache.data);
    }

    // POST /api/usage/top-sessions/send {sessionId, text}: writes into one of the listed sessions.
    if (method === "POST" && pathname === "/api/usage/top-sessions/send") {
      if (!senderAllowed(ctx.requestIdentity?.(_req) ?? null)) return json({ error: "owner only" }, 403);
      const body = (await _req.json().catch(() => null)) as { sessionId?: unknown; text?: unknown } | null;
      const known = topSessionsCache?.data.sessions.find((s) => s.id === body?.sessionId);
      if (!known || typeof body?.text !== "string" || !body.text.trim()) return json({ error: "sessionId must be one of the listed sessions and text is required" }, 400);
      const sent = await sendToSession(known.id, known.cwd, body.text, { root: deps.topSessionsRoot ?? claudeProjectsRoot() });
      return json(sent, sent.live ? 409 : 200);
    }

    // GET /api/usage/projects?range=7d|30d|all
    if (method === "GET" && pathname === "/api/usage/projects") {
      const range = url.searchParams.get("range") || "all";
      const days = range === "1d" ? 1 : range === "7d" ? 7 : range === "30d" ? 30 : null;

      if (cached && cached.days === days && Date.now() - cached.at < PROJECT_TTL_MS) {
        return json({ range, cachedAt: new Date(cached.at).toISOString(), ...cached.data });
      }

      try {
        // `unpricedModels` comes from the SAME process-wide registry
        // `/api/system/status` reports, so a client that shows both cannot see
        // two different answers to "is anything running unpriced".
        const data = projectUsage(db, { days, unpricedModels: unknownPricedModels() });
        cached = { at: Date.now(), days, data };
        return json({ range, cachedAt: new Date(cached.at).toISOString(), ...data });
      } catch (err: any) {
        console.error("[Usage] project aggregate failed:", err);
        return ctx.errorResponse(500, err?.message || "Failed to compute project usage");
      }
    }

    // POST /api/usage/people/merge {from, into}: the same human seen on two channels becomes one person.
    // Owner only, like the senders: it rewrites who did the work.
    if (method === "POST" && pathname === "/api/usage/people/merge") {
      if (!senderAllowed(ctx.requestIdentity?.(_req) ?? null)) return json({ error: "owner only" }, 403);
      let body: Record<string, unknown> | null = null;
      try { body = (await _req.json()) as Record<string, unknown>; } catch { /* malformed */ }
      const from = typeof body?.from === "string" ? body.from : "";
      const into = typeof body?.into === "string" ? body.into : "";
      try {
        const r = mergeChannelPerson(db, from, into);
        if (!r.ok) return json({ error: r.error }, r.status);
        peopleCache = null;
        return json({ into, moved: r.moved });
      } catch (err) {
        console.error("[Usage] people merge failed:", err);
        return ctx.errorResponse(500, err instanceof Error ? err.message : "Failed to merge people");
      }
    }

    // GET /api/usage/people?days=7: who spent the quota; /api/usage/people/:personId: per request.
    // `:personId` = `none` for the calls with no author.
    if (method === "GET" && (pathname === "/api/usage/people" || pathname.startsWith("/api/usage/people/"))) {
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 7));
      try {
        const now = Date.now();
        if (!peopleCache || peopleCache.days !== days || now - peopleCache.at >= PROJECT_TTL_MS) {
          peopleCache = { at: now, days, data: computeCalls(db, { days, now }) };
        }
        const cachedAt = new Date(peopleCache.at).toISOString();
        if (pathname === "/api/usage/people") return json({ cachedAt, ...peopleUsage(peopleCache.data, db) });
        const raw = decodeURIComponent(pathname.slice("/api/usage/people/".length));
        return json({ cachedAt, ...personDetail(peopleCache.data, db, raw === "none" ? null : raw) });
      } catch (err) {
        console.error("[Usage] people aggregate failed:", err);
        return ctx.errorResponse(500, err instanceof Error ? err.message : "Failed to compute people usage");
      }
    }

    // POST /api/usage/records: a call made outside the engine (sandboxed channels), with its author.
    if (method === "POST" && pathname === "/api/usage/records") {
      if (!senderAllowed(ctx.requestIdentity?.(_req) ?? null)) return json({ error: "owner only" }, 403);
      let body: Record<string, unknown> | null = null;
      try { body = (await _req.json()) as Record<string, unknown>; } catch { /* malformed */ }
      const parsed = parseUsageRecord(body);
      if (typeof parsed === "string") return json({ error: parsed }, 400);
      try {
        const r = insertUsageRecord(db, parsed);
        peopleCache = null;
        return json(r, r.duplicate ? 200 : 201);
      } catch (err) {
        console.error("[Usage] record insert failed:", err);
        return ctx.errorResponse(500, err instanceof Error ? err.message : "Failed to store usage record");
      }
    }

    // GET /api/usage/projects/quota: every project's share of the weekly Claude
    // quota (project quota, USAGE-28), not to be confused with
    // `/api/usage/projects` (`projectUsage`, dollar/token cost: a different
    // question, see the header of this file).
    if (method === "GET" && pathname === "/api/usage/projects/quota") {
      try {
        const now = Date.now();
        if (!projectQuotaCache || now - projectQuotaCache.at >= PROJECT_QUOTA_TTL_MS) {
          projectQuotaCache = { at: now, data: projectQuota(db, { now }) };
        }
        const body: ProjectQuotaResponse = { cachedAt: new Date(projectQuotaCache.at).toISOString(), ...withLimits(db, projectQuotaCache.data) };
        return json(body);
      } catch (err) {
        console.error("[Usage] project quota failed:", err);
        return ctx.errorResponse(500, err instanceof Error ? err.message : "Failed to compute project quota");
      }
    }

    return null;
  };
}

/** The body of `POST /api/usage/records`, validated; a string = why it was refused. */
export function parseUsageRecord(b: Record<string, unknown> | null): UsageRecordInput | string {
  if (!b) return "body required";
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  const ts = typeof b.ts === "number" ? b.ts : typeof b.ts === "string" ? Date.parse(b.ts) : NaN;
  if (!Number.isFinite(ts)) return "ts required (epoch ms or ISO)";
  if (typeof b.model !== "string" || !b.model.trim()) return "model required";
  if (typeof b.purpose !== "string" || !b.purpose.trim()) return "purpose required";
  const sender = parseSender(b.sender);
  if (!sender) return "sender required";
  const id = typeof b.id === "string" && b.id.trim() ? b.id.trim().slice(0, 200) : null;
  return {
    id, ts, model: b.model.trim().slice(0, 200), purpose: b.purpose.trim().slice(0, 64),
    label: typeof b.label === "string" ? b.label.slice(0, 200) : null,
    sessionKey: typeof b.sessionKey === "string" && b.sessionKey.trim() ? b.sessionKey.trim() : null,
    inputTokens: num(b.inputTokens) ?? 0, outputTokens: num(b.outputTokens) ?? 0,
    cacheReadTokens: num(b.cacheReadTokens) ?? 0, cacheCreationTokens: num(b.cacheCreationTokens) ?? 0,
    costUsd: typeof b.costUsd === "number" && Number.isFinite(b.costUsd) ? b.costUsd : null,
    sender,
    projectPath: typeof b.projectPath === "string" && b.projectPath.trim() ? b.projectPath.trim().slice(0, 500) : null,
  };
}

export interface UsageRecordInput {
  id: string | null; ts: number; model: string; purpose: string; label: string | null; sessionKey: string | null;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number | null;
  sender: Sender;
  /** Where a delegated job ran; it has no topic, so the project comes from here. */
  projectPath: string | null;
}

/**
 * Writes a call made outside the engine, with its author. Idempotent on the
 * caller's `id`: the same call sent again after a network error stays one row.
 */
export function insertUsageRecord(db: Database, r: UsageRecordInput): { id: string; duplicate: boolean } {
  const { authorPersonId } = authorForSender(db, r.sender);
  const id = r.id ?? crypto.randomUUID();
  const res = db.query(
    `INSERT OR IGNORE INTO usage_records (id, timestamp, session_key, topic_id, model, input_tokens, output_tokens, total_tokens, cost_usd,
       purpose, provider, cache_read_tokens, cache_creation_tokens, measured, label, author_person_id, project_path)
     VALUES (?, ?, ?, (SELECT id FROM topics WHERE session_key = ?), ?, ?, ?, ?, ?, ?, 'external', ?, ?, 1, ?, ?, ?)`,
  ).run(
    id, r.ts, r.sessionKey ?? "external", r.sessionKey, r.model, r.inputTokens, r.outputTokens,
    r.inputTokens + r.outputTokens, r.costUsd, r.purpose, r.cacheReadTokens, r.cacheCreationTokens,
    r.label, authorPersonId, r.projectPath,
  );
  return { id, duplicate: res.changes === 0 };
}
