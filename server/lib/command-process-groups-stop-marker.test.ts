/**
 * `clearGroupStopping` only reaches its catch on a real fs error — `rmSync`
 * with `force: true` already swallows a missing file. That real error used
 * to vanish silently, and a stale `.stop` marker left behind blocks the next
 * `START_UNLESS_STOPPING` start. It must at least be logged.
 *
 * @covers CARDPROCESS-01
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousDataDir = process.env.DATA_DIR;
const previousTopicsDataDir = process.env.TOPICS_DATA_DIR;
const previousTopicsHome = process.env.TOPICS_HOME;
const instance = mkdtempSync(join(tmpdir(), "topics-groups-stopmarker-"));
process.env.TOPICS_DATA_DIR = instance;
process.env.TOPICS_HOME = `${instance}-home`;
delete process.env.DATA_DIR;

const { commandProcessGroupStopPath, forgetCommandProcessGroup } = await import("./command-process-groups");

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
  if (previousTopicsDataDir === undefined) delete process.env.TOPICS_DATA_DIR; else process.env.TOPICS_DATA_DIR = previousTopicsDataDir;
  if (previousTopicsHome === undefined) delete process.env.TOPICS_HOME; else process.env.TOPICS_HOME = previousTopicsHome;
  rmSync(instance, { recursive: true, force: true });
});

let warnSpy: typeof console.warn;
const warnCalls: unknown[][] = [];
afterEach(() => { console.warn = warnSpy; warnCalls.length = 0; });

test("a real fs error clearing the stop marker is logged, not swallowed", () => {
  warnSpy = console.warn;
  console.warn = ((...args: unknown[]) => { warnCalls.push(args); }) as never;

  const processId = crypto.randomUUID();
  const stopPath = commandProcessGroupStopPath(processId);
  // A directory at the marker's path makes `rmSync(path, { force: true })`
  // throw EISDIR — `force` only swallows ENOENT, never a real fs error.
  mkdirSync(stopPath, { recursive: true });

  forgetCommandProcessGroup(processId);

  expect(warnCalls.length).toBe(1);
  expect(String(warnCalls[0]![0])).toContain(processId);
  rmSync(stopPath, { recursive: true, force: true });
});
