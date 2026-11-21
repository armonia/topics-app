/**
 * @covers QUOTA-SAMPLER-01
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pointsPerHour, readHistory, usageHistoryFile } from "./person-usage";
import { sampleQuotaOnce, QUOTA_SAMPLE_EVERY_MS } from "./quota-sampler";

const loginAs = (id: string) => async () => id;
const usage = (pct: number) => async () => ({ fiveHour: null, sevenDay: { utilization: pct, resetsAtMs: null } });
const total = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);

describe("quota sampler", () => {
  test("clean folder: two samples 3 points apart give 3 points", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-"));
    try {
      const file = usageHistoryFile({ TOPICS_USAGE_HISTORY_DIR: dir });
      const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
      expect(await sampleQuotaOnce({ file, nowMs: t0, account: loginAs("login-a"), read: usage(20) })).toBe(true);
      expect(await sampleQuotaOnce({ file, nowMs: t0 + QUOTA_SAMPLE_EVERY_MS, account: loginAs("login-a"), read: usage(23) })).toBe(true);
      const h = readHistory(file)!;
      expect(h.length).toBe(2);
      expect(total(pointsPerHour(h, t0 - 1000, t0 + 3_600_000))).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("an external writer on the same file: no doubled points", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-"));
    try {
      const file = join(dir, "history.jsonl");
      const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
      const ext = (ms: number, v: number) => appendFileSync(file, `${JSON.stringify({ t: ms / 1000, s: { "claude|login-a|7d": v } })}\n`);
      ext(t0, 20);
      expect(await sampleQuotaOnce({ file, nowMs: t0 + 10_000, account: loginAs("login-a"), read: usage(20) })).toBe(false);
      ext(t0 + QUOTA_SAMPLE_EVERY_MS, 23);
      expect(await sampleQuotaOnce({ file, nowMs: t0 + QUOTA_SAMPLE_EVERY_MS + 5_000, account: loginAs("login-a"), read: usage(23) })).toBe(false);
      expect(readFileSync(file, "utf8").trim().split("\n").length).toBe(2);
      expect(total(pointsPerHour(readHistory(file)!, t0 - 1000, t0 + 3_600_000))).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("unreadable usage writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-"));
    try {
      const file = join(dir, "history.jsonl");
      expect(await sampleQuotaOnce({ file, account: loginAs("login-a"), read: async () => null })).toBe(false);
      expect(readHistory(file)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("intermittent external writer with the same account id: 3 points, not 6", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-"));
    try {
      const file = join(dir, "history.jsonl");
      const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
      const ext = new Map([[0, 20], [400, 21], [1000, 22], [1300, 23]]);
      for (let sec = 0; sec <= 1300; sec += 100) {
        const v = ext.get(sec);
        if (v !== undefined) appendFileSync(file, `${JSON.stringify({ t: t0 / 1000 + sec, s: { "claude|login-a|7d": v } })}\n`);
        if (sec % 300 === 0) await sampleQuotaOnce({ file, nowMs: t0 + sec * 1000, account: loginAs("Login-A"), read: usage(20 + Math.min(3, Math.floor(sec / 450))) });
      }
      const lines = readHistory(file)!;
      expect(lines.length).toBeGreaterThan(4); // the sampler filled gaps in the SAME series
      expect(total(pointsPerHour(lines, t0 - 1000, t0 + 3_600_000))).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("an external writer with other keys keeps the sampler silent while alive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-"));
    try {
      const file = join(dir, "history.jsonl");
      const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
      appendFileSync(file, `${JSON.stringify({ t: t0 / 1000, s: { "claude|foreign-key|7d": 20 } })}\n`);
      expect(await sampleQuotaOnce({ file, nowMs: t0 + 20 * 60_000, account: loginAs("login-mine"), read: usage(30) })).toBe(false);
      expect(await sampleQuotaOnce({ file, nowMs: t0 + 70 * 60_000, account: loginAs("login-mine"), read: usage(30) })).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("login switch A 46 -> B 100 -> A 47 counts 1 point", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-"));
    try {
      const file = join(dir, "history.jsonl");
      const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
      const step = QUOTA_SAMPLE_EVERY_MS;
      expect(await sampleQuotaOnce({ file, nowMs: t0, account: loginAs("login-a"), read: usage(46) })).toBe(true);
      expect(await sampleQuotaOnce({ file, nowMs: t0 + step, account: loginAs("login-b"), read: usage(100) })).toBe(true);
      expect(await sampleQuotaOnce({ file, nowMs: t0 + 2 * step, account: loginAs("login-a"), read: usage(47) })).toBe(true);
      expect(total(pointsPerHour(readHistory(file)!, t0 - 1000, t0 + 3_600_000))).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
