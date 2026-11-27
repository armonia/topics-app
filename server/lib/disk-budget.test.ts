/**
 * Pure math, so every case is an exact number: no fixture folder, no `du`.
 *
 * @covers SYSTEM-DISK-01
 */
import { describe, expect, test } from "bun:test";
import { diskBudgetConfig, evaluateDiskBudget } from "./disk-budget";

describe("diskBudgetConfig", () => {
  test("defaults to a ratio cap of 3 with no folder caps", () => {
    const config = diskBudgetConfig({}, ["logs", "chromium-sidecar"]);
    expect(config.ratioCap).toBe(3);
    expect(config.folderCaps).toEqual({});
  });

  test("reads TOPICS_DISK_RATIO_CAP", () => {
    const config = diskBudgetConfig({ TOPICS_DISK_RATIO_CAP: "5" }, []);
    expect(config.ratioCap).toBe(5);
  });

  test("a non-numeric or non-positive ratio falls back to the default", () => {
    expect(diskBudgetConfig({ TOPICS_DISK_RATIO_CAP: "nope" }, []).ratioCap).toBe(3);
    expect(diskBudgetConfig({ TOPICS_DISK_RATIO_CAP: "0" }, []).ratioCap).toBe(3);
    expect(diskBudgetConfig({ TOPICS_DISK_RATIO_CAP: "-1" }, []).ratioCap).toBe(3);
  });

  test("builds the per-folder env name by uppercasing and replacing separators", () => {
    const config = diskBudgetConfig(
      { TOPICS_DISK_CAP_CHROMIUM_SIDECAR: "1000" },
      ["chromium-sidecar", "logs"],
    );
    expect(config.folderCaps).toEqual({ "chromium-sidecar": 1000 });
  });
});

describe("evaluateDiskBudget", () => {
  test("ok when the total stays within the ratio and no folder is capped", () => {
    const result = evaluateDiskBudget(
      1_000,
      [{ name: "logs", bytes: 500 }, { name: "workspace", bytes: 1_000 }],
      { ratioCap: 3, folderCaps: {} },
    );
    expect(result.ratio).toBe(1.5);
    expect(result.ratioOverCap).toBe(false);
    expect(result.ok).toBe(true);
  });

  test("red when the ratio exceeds the cap, matching the 2026-11-19 case (20x against a cap of 3)", () => {
    const result = evaluateDiskBudget(
      760,
      [{ name: "agents", bytes: 15_300 - 760 }],
      { ratioCap: 3, folderCaps: {} },
    );
    expect(result.ratioOverCap).toBe(true);
    expect(result.ok).toBe(false);
  });

  test("a folder over its own cap is red even when the ratio is fine", () => {
    const result = evaluateDiskBudget(
      10_000,
      [{ name: "logs", bytes: 2_000 }],
      { ratioCap: 3, folderCaps: { logs: 1_000 } },
    );
    expect(result.ratioOverCap).toBe(false);
    expect(result.folders[0]?.overCap).toBe(true);
    expect(result.ok).toBe(false);
  });

  test("a zero database size skips the ratio check and judges only the folder caps", () => {
    const result = evaluateDiskBudget(
      0,
      [{ name: "logs", bytes: 2_000 }],
      { ratioCap: 3, folderCaps: {} },
    );
    expect(result.ratioOverCap).toBe(false);
    expect(result.ok).toBe(true);
  });

  test("a folder with no configured cap never turns red on its own", () => {
    const result = evaluateDiskBudget(
      100,
      [{ name: "uncapped", bytes: 1_000_000 }],
      { ratioCap: 1_000_000, folderCaps: {} },
    );
    expect(result.folders[0]?.capBytes).toBeNull();
    expect(result.folders[0]?.overCap).toBe(false);
  });
});

describe("every folder counts", () => {
  test("user-work folders are inside the ratio and carry growth per day", () => {
    const now = 10 * 86_400_000;
    const r = evaluateDiskBudget(
      100,
      [
        { name: "agents", bytes: 10_000 },
        { name: "logs", bytes: 50 },
      ],
      { ratioCap: 3, folderCaps: { agents: 5_000 } },
      { agents: { at: now - 2 * 86_400_000, bytes: 9_000 } },
      now,
    );
    expect(r.outsideBytes).toBe(10_050);
    expect(r.ratioOverCap).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.folders[0]?.growthPerDay).toBe(500);
    expect(r.folders[1]?.growthPerDay).toBeNull();
  });
  test("default caps apply to the folders that grew unbounded, env overrides them", () => {
    const names = ["agents", "media", "backups", "db-backups", "logs"];
    const c = diskBudgetConfig({ TOPICS_DISK_CAP_MEDIA: "123" }, names);
    expect(c.folderCaps.media).toBe(123);
    expect(c.folderCaps.agents).toBeGreaterThan(0);
    expect(c.folderCaps["db-backups"]).toBeGreaterThan(0);
    expect(c.folderCaps.logs).toBeUndefined();
  });
});
