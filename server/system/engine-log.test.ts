import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseLogLine, readEngineLog } from "./engine-log";

describe("engine log tail", () => {
  test("a line carries its level and its agent", () => {
    expect(parseLogLine("2026-11-22 WARN agent=gtm quota near")).toMatchObject({ level: "warn", agent: "gtm" });
    expect(parseLogLine("plain text")).toMatchObject({ level: "info", agent: null });
  });

  test("filters by agent and level, and a missing file is not an error", () => {
    const home = mkdtempSync(join(tmpdir(), "engine-log-"));
    try {
      expect(readEngineLog(home)).toMatchObject({ exists: false, lines: [] });
      mkdirSync(join(home, "logs"));
      writeFileSync(join(home, "logs", "engine.log"), "INFO agent=main ok\nERROR agent=gtm boom\nERROR agent=main bad\nDEBUG agent=main noise\n");
      expect(readEngineLog(home, { level: "error" }).lines.map((l) => l.agent)).toEqual(["gtm", "main"]);
      expect(readEngineLog(home, { agent: "main", level: "warn" }).lines).toHaveLength(1);
      expect(readEngineLog(home, { limit: 2 }).lines).toHaveLength(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
