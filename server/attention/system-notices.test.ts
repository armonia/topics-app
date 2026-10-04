/**
 * Infrastructure notices are rows of the system, not of a chat (ATTN-10,
 * design section 10.4, defect D5): a swap freeze and its thaw are ONE row of
 * kind `system` under `system:<key>`, and no `topic:` subject lights up.
 * @covers ATTN-10
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { configureNotificationRegistry, __resetNotificationRegistry } from "../notification-registry";
import { unseenSnapshot } from "../db/notification-log";
import { closeSystemCycle, openSystemCycle, recordSystemNotice } from "./system-notices";
import { attentionInitFrame, resetAttentionStore } from "./store";

let tmpRoot: string;
beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "attn-system-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const real = join(import.meta.dir, "..", "db", "migrations");
  for (const f of readdirSync(real)) if (f.endsWith(".sql")) writeFileSync(join(migDir, f), readFileSync(join(real, f), "utf-8"));
  initDatabase(tmpRoot);
  configureNotificationRegistry({ isTopicArchived: () => false });
});
afterAll(() => { resetAttentionStore(); __resetNotificationRegistry(); try { closeDatabase(); } catch { /* closed */ } try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });
beforeEach(() => { resetAttentionStore(); getDatabase().run("DELETE FROM notification_log"); });

const all = () => getDatabase().query("SELECT kind, title, target_kind, group_key FROM notification_log ORDER BY created_at").all() as Array<Record<string, string | null>>;

describe("a system notice", () => {
  it("a freeze and its thaw are one system row, on a system subject, and no chat lights up", () => {
    openSystemCycle("swap-freeze:root-7", { title: "Congelato: bun test", body: "swap" }, 1000);
    closeSystemCycle("swap-freeze:root-7", { title: "Congelato e ripreso: bun test", body: "ripreso" }, 2000);
    expect(all()).toEqual([{ kind: "system", title: "Congelato e ripreso: bun test", target_kind: null, group_key: "system:swap-freeze:root-7" }]);
    expect(unseenSnapshot().unseenKeys.some((k) => k.startsWith("topic:"))).toBe(false);
    expect((attentionInitFrame() as unknown as { rows: unknown[] }).rows).toEqual([]);
  });

  it("a second freeze of the same command is a second cycle, a second row", () => {
    openSystemCycle("swap-freeze:root-8", { title: "Congelato: a" }, 1000);
    closeSystemCycle("swap-freeze:root-8", { title: "Congelato e ripreso: a" }, 2000);
    openSystemCycle("swap-freeze:root-8", { title: "Congelato: a" }, 3000);
    expect(all()).toHaveLength(2);
  });

  it("a held restart is one row per wait", () => {
    recordSystemNotice({ key: "restart-held", cycle: "watch:1", title: "Riavvio trattenuto" });
    recordSystemNotice({ key: "restart-held", cycle: "watch:1", title: "Riavvio trattenuto" });
    expect(all()).toEqual([{ kind: "system", title: "Riavvio trattenuto", target_kind: null, group_key: "system:restart-held" }]);
  });
});
