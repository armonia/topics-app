/**
 * @covers MACHINE-05
 */
import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { sharedToolingDir } from "./machine-health";

describe("where the health file goes", () => {
  const saved = process.env.TOPICS_TOOLING_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.TOPICS_TOOLING_DIR;
    else process.env.TOPICS_TOOLING_DIR = saved;
  });

  test("by default next to the tray's own files in ~/.topics, not in the server's data folder", () => {
    delete process.env.TOPICS_TOOLING_DIR;
    expect(sharedToolingDir()).toBe(join(homedir(), ".topics"));
  });

  test("an override moves it (tests, unusual installs)", () => {
    process.env.TOPICS_TOOLING_DIR = "/tmp/tooling";
    expect(sharedToolingDir()).toBe("/tmp/tooling");
  });
});
