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
  test("every prefix form of engine.log, and process.log, resolve to an agent, a chat and a level", () => {
    const home = mkdtempSync(join(tmpdir(), "engine-log-"));
    try {
      expect(readEngineLog(home)).toMatchObject({ exists: false, lines: [] });
      writeFileSync(join(home, "config.json"), JSON.stringify({ channels: { whatsapp: {}, discord: {} } }));
      writeFileSync(join(home, "engine.json"), JSON.stringify({
        agents: { alpha: { workspace: "/w/a", account: "jarvis" }, beta: { workspace: "/w/b", account: "visione" }, gamma: { workspace: "/w/c" } },
      }));
      writeFileSync(join(home, "jobs.json"), JSON.stringify([{ id: "job1", run: { kind: "agent", agent: "beta" } }]));
      writeFileSync(join(home, "engine.log"), [
        `${STAMP} whatsapp:111@g.us: boom one`,
        `${STAMP} jarvis:whatsapp:111@g.us: boom two`,
        `${STAMP} discord:visione:222:333 boom three`,
        `${STAMP} cron:job1 boom four`,
        `${STAMP} cli:delta boom five`,
        `${STAMP} discord:default:444 boom six`,
      ].join("\n") + "\n");
      writeFileSync(join(home, "process.log"), "visione: all fine\nvisione: send failed\n");

      const titles = { "111@g.us": "Family group", "222": "#pm" };
      const all = readEngineLog(home, { titles }).lines;
      // No account on the first line: it falls to the engine's default agent.
      expect(all.map((l) => l.agent)).toEqual(["gamma", "alpha", "beta", "beta", "delta", "gamma", "beta", "beta"]);
      expect(all.map((l) => l.chat)).toEqual(["Family group", "Family group", "#pm", null, null, "444", null, null]);
      expect(all.map((l) => l.level)).toEqual(["error", "error", "error", "error", "error", "error", "info", "error"]);
      expect(all[0]).toMatchObject({ time: STAMP, text: "boom one" });
      expect(all[6]).toMatchObject({ time: null, text: "all fine" });
      expect(readEngineLog(home, { level: "error", agent: "beta" }).lines).toHaveLength(3);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the limit applies to each file, so live output does not push turn errors out", () => {
    const home = mkdtempSync(join(tmpdir(), "engine-log-"));
    try {
      writeFileSync(join(home, "engine.log"), `${STAMP} cli:alpha one\n${STAMP} cli:alpha two\n`);
      writeFileSync(join(home, "process.log"), "jarvis: a\njarvis: b\njarvis: c\n");
      const lines = readEngineLog(home, { level: "info", limit: 2 }).lines;
      expect(lines.map((l) => l.text)).toEqual(["one", "two", "b", "c"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
