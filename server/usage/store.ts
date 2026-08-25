import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "fs";
import { join } from "path";
import type { UsageRecord, UsageSummary, DaySummary } from "./types";

let USAGE_DIR = "";
let SUMMARY_FILE = "";

// Write queue to prevent race conditions in appendUsageRecord
let writeQueue: Promise<void> = Promise.resolve();

function enqueue(fn: () => void): Promise<void> {
  writeQueue = writeQueue.then(fn, fn);
  return writeQueue;
}

/** A temp file is orphaned when it is OURS, or when it is provably OLD. */
export const ORPHAN_TMP_AGE_MS = 60_000;

/**
 * `atomicWrite` names its temp `<file>.tmp.<pid>.<epochMs>`, so the name says
 * both who wrote it and when. Anything we cannot date is KEPT: leaving a few
 * stale kilobytes costs nothing, deleting a live write cost 253 tests.
 */
export function isOrphanTmp(name: string, myPid: number, now: number): boolean {
  const marker = name.indexOf(".tmp.");
  if (marker < 0) return false;
  const [pid, stamp] = name.slice(marker + ".tmp.".length).split(".");
  if (/^\d+$/.test(pid ?? "") && Number(pid) === myPid) return true;
  // `Number("")` is 0, not NaN — and a zero stamp reads as "written in 1970",
  // i.e. always old enough to delete. The shape has to be checked, not coerced.
  if (!/^\d+$/.test(stamp ?? "")) return false;
  return now - Number(stamp) >= ORPHAN_TMP_AGE_MS;
}

export function initUsageStore(baseDir: string) {
  USAGE_DIR = join(baseDir, "data", "usage");
  SUMMARY_FILE = join(USAGE_DIR, "summary.json");
  mkdirSync(USAGE_DIR, { recursive: true });

  // Clean up orphaned .tmp files from previous crashes.
  //
  // ORPHANED means OLD, not "belongs to someone else". This loop used to
  // delete every `.tmp.` file in the directory, and `atomicWrite` names its
  // temp `<file>.tmp.<pid>.<now>` — so a second process booting here would
  // delete a temp file another process had written one statement earlier, and
  // that process's `renameSync` failed with ENOENT. Measured on 2026-08-25:
  // four e2e shards sharing this directory, one server dead at boot, 253 tests
  // never run. The directory is no longer shared (see start-test-server.sh),
  // but a production restart racing a worktree server still can be, and a
  // cleanup that destroys a live write is wrong on its own terms.
  try {
    const now = Date.now();
    for (const f of readdirSync(USAGE_DIR)) {
      if (!isOrphanTmp(f, process.pid, now)) continue;
      try {
        unlinkSync(join(USAGE_DIR, f));
        console.log(`[usage] Cleaned up orphaned tmp file: ${f}`);
      } catch {}
    }
  } catch {}
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function dayFilePath(date: string): string {
  return join(USAGE_DIR, `${date}.json`);
}

function atomicWrite(filepath: string, data: object) {
  const tmp = filepath + ".tmp." + process.pid + "." + Date.now();
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, filepath);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

function loadDayRecords(date: string): UsageRecord[] {
  const fp = dayFilePath(date);
  let raw: string;
  try {
    raw = readFileSync(fp, "utf-8");
  } catch {
    return []; // no file for this day yet — the normal case
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    // File exists but doesn't parse (torn write, disk full, external edit).
    // This swallow used to be fully silent — rebuildSummary's "Corrupted
    // usage file" catch could never fire because we never threw — so a whole
    // day just vanished from cost/token totals with zero trace. Keep
    // returning [] (appendUsageRecord may legitimately overwrite with fresh
    // records) but say so loudly.
    console.error(`[usage] Corrupted usage file ${fp} (${(err as Error)?.message}); treating as empty — that day's records are lost`);
    return [];
  }
}

function saveDayRecords(date: string, records: UsageRecord[]) {
  atomicWrite(dayFilePath(date), records);
}

export function appendUsageRecord(record: UsageRecord): Promise<void> {
  return enqueue(() => {
    const date = todayKey();
    const records = loadDayRecords(date);
    records.push(record);
    saveDayRecords(date, records);
    updateSummaryIncremental(record);
  });
}

function loadSummary(): UsageSummary {
  try {
    return JSON.parse(readFileSync(SUMMARY_FILE, "utf-8"));
  } catch {
    return { daily: {}, byModel: {}, byTopic: {}, totalCostUsd: 0, totalTokens: 0, totalRequests: 0 };
  }
}

function saveSummary(summary: UsageSummary) {
  atomicWrite(SUMMARY_FILE, summary);
}

function updateSummaryIncremental(record: UsageRecord) {
  const summary = loadSummary();
  const date = new Date(record.timestamp).toISOString().slice(0, 10);

  // Daily
  if (!summary.daily[date]) {
    summary.daily[date] = { date, totalTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, requestCount: 0 };
  }
  summary.daily[date].totalTokens += record.totalTokens;
  summary.daily[date].inputTokens += record.inputTokens;
  summary.daily[date].outputTokens += record.outputTokens;
  summary.daily[date].costUsd += record.costUsd;
  summary.daily[date].requestCount += 1;

  // By model
  if (!summary.byModel[record.model]) {
    summary.byModel[record.model] = { model: record.model, totalTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, requestCount: 0 };
  }
  summary.byModel[record.model].totalTokens += record.totalTokens;
  summary.byModel[record.model].inputTokens += record.inputTokens;
  summary.byModel[record.model].outputTokens += record.outputTokens;
  summary.byModel[record.model].costUsd += record.costUsd;
  summary.byModel[record.model].requestCount += 1;

  // By topic
  const topicKey = record.topicId || "unknown";
  if (!summary.byTopic[topicKey]) {
    summary.byTopic[topicKey] = { topicId: topicKey, totalTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, requestCount: 0 };
  }
  summary.byTopic[topicKey].totalTokens += record.totalTokens;
  summary.byTopic[topicKey].inputTokens += record.inputTokens;
  summary.byTopic[topicKey].outputTokens += record.outputTokens;
  summary.byTopic[topicKey].costUsd += record.costUsd;
  summary.byTopic[topicKey].requestCount += 1;

  // Totals
  summary.totalCostUsd += record.costUsd;
  summary.totalTokens += record.totalTokens;
  summary.totalRequests += 1;

  saveSummary(summary);
}





// Rebuild summary from all daily files (called on server start)
export function rebuildSummary() {
  const summary: UsageSummary = { daily: {}, byModel: {}, byTopic: {}, totalCostUsd: 0, totalTokens: 0, totalRequests: 0 };
  try {
    const files = readdirSync(USAGE_DIR).filter(f => f.endsWith('.json') && f !== 'summary.json' && !f.includes('.tmp.'));
    for (const f of files) {
      const date = f.replace('.json', '');
      let records: UsageRecord[];
      try {
        records = loadDayRecords(date);
      } catch (err) {
        console.error(`[usage] Corrupted usage file ${f}, skipping:`, err);
        continue;
      }
      if (records.length === 0) continue;

      const daySummary: DaySummary = { date, totalTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, requestCount: records.length };

      for (const r of records) {
        daySummary.totalTokens += r.totalTokens;
        daySummary.inputTokens += r.inputTokens;
        daySummary.outputTokens += r.outputTokens;
        daySummary.costUsd += r.costUsd;

        if (!summary.byModel[r.model]) {
          summary.byModel[r.model] = { model: r.model, totalTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, requestCount: 0 };
        }
        summary.byModel[r.model].totalTokens += r.totalTokens;
        summary.byModel[r.model].inputTokens += r.inputTokens;
        summary.byModel[r.model].outputTokens += r.outputTokens;
        summary.byModel[r.model].costUsd += r.costUsd;
        summary.byModel[r.model].requestCount += 1;

        const topicKey = r.topicId || "unknown";
        if (!summary.byTopic[topicKey]) {
          summary.byTopic[topicKey] = { topicId: topicKey, totalTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, requestCount: 0 };
        }
        summary.byTopic[topicKey].totalTokens += r.totalTokens;
        summary.byTopic[topicKey].inputTokens += r.inputTokens;
        summary.byTopic[topicKey].outputTokens += r.outputTokens;
        summary.byTopic[topicKey].costUsd += r.costUsd;
        summary.byTopic[topicKey].requestCount += 1;

        summary.totalCostUsd += r.costUsd;
        summary.totalTokens += r.totalTokens;
        summary.totalRequests += 1;
      }

      summary.daily[date] = daySummary;
    }
  } catch (err) {
    console.error("[usage] Error rebuilding summary:", err);
  }
  saveSummary(summary);
  return summary;
}
