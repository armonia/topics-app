/**
 * @covers PROJECT-11
 *
 * A project created right after a denial must be reachable at once: the denial
 * refresh is rate limited and the allowlist cache lives 5 s, so neither may
 * hide a project that was just created.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "./types";
import { closeDatabase } from "./db";
import { createAppContext } from "./utils";

let root: string;
let ctx: AppContext;
const envKeys = ["DATA_DIR", "TOPICS_DATA_DIR", "APP_DATA_DIR", "TOPICS_HOME", "GATEWAY_TOKEN"] as const;
const previous = new Map<string, string | undefined>();

beforeAll(() => {
  closeDatabase();
  root = realpathSync(mkdtempSync(join(tmpdir(), "topics-known-dirs-")));
  for (const key of envKeys) previous.set(key, process.env[key]);
  process.env.DATA_DIR = join(root, "data");
  process.env.TOPICS_DATA_DIR = join(root, "state");
  process.env.APP_DATA_DIR = join(root, "appdata");
  process.env.TOPICS_HOME = join(root, "home");
  process.env.GATEWAY_TOKEN = "isolated-test-placeholder";
  ctx = createAppContext(join(import.meta.dir, ".."));
});

afterAll(() => {
  closeDatabase();
  for (const key of envKeys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("allowed folders cache", () => {
  test("a project created right after a denial is accessible", () => {
    const gone = join(root, "gone");
    expect(ctx.resolveProjectPath(gone)).toBeNull();
    const fresh = join(root, "fresh");
    mkdirSync(fresh);
    ctx.projectStore.create({ name: "Fresh", slug: "fresh", path: fresh });
    expect(ctx.resolveProjectPath(fresh)).toBe(fresh);
  });
});
