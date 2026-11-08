/**
 * A chat created in a new folder can use that folder at once.
 *
 * The project allowlist is cached for five seconds, and a refusal recomputes
 * it at most once every half second. A topic saved with a new `projectPath`
 * therefore stayed refused ("This topic has no project directory") whenever
 * another refusal had used up that recompute just before: chat-live-work went
 * red on the first try in every CI run. Saving the topic now empties the
 * cache, and the boundary itself does not move.
 * @covers CMDRUN-03
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase } from "./db";
import type { AppContext, Topic } from "./types";
import { createAppContext } from "./utils";

const envKeys = ["TOPICS_DATA_DIR", "DATA_DIR", "TOPICS_HOME", "APP_DATA_DIR", "OPENCLAW_DIR"] as const;
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let root: string;
let ctx: AppContext;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "topics-known-dirs-")));
  process.env.TOPICS_DATA_DIR = join(root, "state");
  process.env.DATA_DIR = join(root, "state", "data");
  process.env.TOPICS_HOME = join(root, "topics-home");
  process.env.APP_DATA_DIR = join(root, "app-data");
  process.env.OPENCLAW_DIR = join(root, "app-data");
  closeDatabase();
  ctx = createAppContext(join(root, "state"));
});

afterAll(() => {
  closeDatabase();
  for (const key of envKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

function topicIn(projectPath: string): Topic {
  const now = new Date().toISOString();
  return {
    id: "knowndir-aaaa-bbbb-cccc-000000000001",
    name: "Fresh folder",
    slug: "fresh-folder",
    parentId: null,
    links: [],
    sessionKey: "topic:knowndir01",
    color: "#aabbcc",
    icon: "chat",
    createdAt: now,
    updatedAt: now,
    archived: false,
    projectPath,
  };
}

describe("project allowlist after a topic is saved", () => {
  test("a new folder is usable at once, even right after another refusal", () => {
    const elsewhere = join(root, "elsewhere");
    const fresh = join(root, "projects", "fresh");
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(fresh, { recursive: true });

    // A folder nobody opened is refused, and that refusal uses up the recompute.
    expect(ctx.resolveProjectPath(elsewhere)).toBeNull();

    const topic = topicIn(fresh);
    ctx.saveSingleTopic(topic);
    expect(ctx.resolveProjectPath(fresh)).toBe(fresh);
    expect(ctx.resolveTopicCwd(topic)).toBe(fresh);

    // The boundary is unchanged: the other folder is still outside it.
    expect(ctx.resolveProjectPath(elsewhere)).toBeNull();
  });
});
