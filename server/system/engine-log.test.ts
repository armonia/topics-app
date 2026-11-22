/**
 * @covers SYSTEM-PAGE-01
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readEngineLog } from "./engine-log";

const STAMP = "2026-11-22 10:00:00";

describe("engine log tail", () => {
  test("every prefix form of engine.log, and process.log, resolve to an agent and a level", () => {
    const home = mkdtempSync(join(tmpdir(), "engine-log-"));
    try {
      expect(readEngineLog(home)).toMatchObject({ exists: false, lines: [] });
      writeFileSync(join(home, "engine.json"), JSON.stringify({
        agents: { alpha: { workspace: "/w/a" }, beta: { workspace: "/w/b", account: "acc2" } },
      }));
      writeFileSync(join(home, "jobs.json"), JSON.stringify([{ id: "job1", run: { kind: "agent", agent: "beta" } }]));
      writeFileSync(join(home, "engine.log"), [
        `${STAMP} whatsapp:111@g.us: boom one`,
        `${STAMP} acct:whatsapp:111@g.us: boom two`,
        `${STAMP} discord:acc2:333:444 boom three`,
        `${STAMP} cron:job1 boom four`,
        `${STAMP} cli:gamma boom five`,
      ].join("\n") + "\n");
      writeFileSync(join(home, "process.log"), "acc2: all fine\nacc2: send failed\n");

      const all = readEngineLog(home).lines;
      expect(all.map((l) => l.agent)).toEqual(["alpha", "alpha", "beta", "beta", "gamma", "beta", "beta"]);
      expect(all.map((l) => l.level)).toEqual(["error", "error", "error", "error", "error", "info", "error"]);
      expect(readEngineLog(home, { level: "error", agent: "beta" }).lines).toHaveLength(3);
      expect(readEngineLog(home, { limit: 2 }).lines).toHaveLength(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
