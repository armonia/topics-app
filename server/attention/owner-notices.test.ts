/**
 * The failure of a scheduled job is a row under the job's own subject (rule R24):
 * unlike a system row it counts on the bell, and it lights no chat.
 * @covers SCHED-07
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { configureNotificationRegistry, __resetNotificationRegistry } from "../notification-registry";
import { unseenSnapshot } from "../db/notification-log";
import { recordSubjectNotice } from "./owner-notices";
import { jobSubject } from "../../shared/attention";
import { createOwnerAlert } from "../schedule/deliver/owner-alert";
import { configureAttentionStore, resetAttentionStore } from "./store";

let tmpRoot: string;
beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "attn-job-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const real = join(import.meta.dir, "..", "db", "migrations");
  for (const f of readdirSync(real)) if (f.endsWith(".sql")) writeFileSync(join(migDir, f), readFileSync(join(real, f), "utf-8"));
  initDatabase(tmpRoot);
  configureNotificationRegistry({ isTopicArchived: () => false });
});
afterAll(() => { resetAttentionStore(); __resetNotificationRegistry(); try { closeDatabase(); } catch { /* closed */ } try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });
const frames: Array<Record<string, any>> = [];
beforeEach(() => {
  resetAttentionStore();
  frames.length = 0;
  configureAttentionStore({ broadcast: (f) => { frames.push(f as Record<string, any>); } });
  getDatabase().run("DELETE FROM notification_log");
  getDatabase().run("DELETE FROM owner_alerts");
});

const all = () => getDatabase().query("SELECT kind, title, target_kind, group_key FROM notification_log ORDER BY created_at").all() as Array<Record<string, string | null>>;

describe("a job failure notice", () => {
  it("has the subject of the job and enters the unseen count, which a system row never does", () => {
    recordSubjectNotice({ subject: jobSubject("j-1"), title: "Backup has failed 3 times in a row", dedupeKey: "alert:job:j-1:2026-11-26" });
    expect(all()).toEqual([{ kind: "other", title: "Backup has failed 3 times in a row", target_kind: null, group_key: "job:j-1" }]);
    expect(unseenSnapshot()).toEqual({ unseen: 1, unseenKeys: ["job:j-1"] });
    expect(unseenSnapshot().unseenKeys.some((k) => k.startsWith("topic:"))).toBe(false);
  });

  it("raised through the owner alert door it is one row a day, and the count stays at one", () => {
    const raise = createOwnerAlert({
      db: getDatabase(), settings: () => ({ adapter: null, owner: null, quietHours: null, agentJobs: "ask" }),
      sender: Object.assign(async () => "not_delivered" as const, { registry: {} as never }),
      now: () => new Date("2026-11-26T10:00:00Z"),
    });
    const request = { subject: jobSubject("j-2"), scope: "job:j-2", title: "Sync broke", body: "three errors" };
    expect(raise(request)).toBe("sent");
    expect(raise(request)).toBe("already_today");
    expect(all()).toHaveLength(1);
    expect(unseenSnapshot().unseenKeys).toEqual(["job:j-2"]);
  });
});
