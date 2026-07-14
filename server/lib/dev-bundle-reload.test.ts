import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDevBundleReload, readBundleRev } from "./dev-bundle-reload";

const html = (hash: string) =>
  `<html><script src="/assets/index-${hash}.js"></script><link href="/assets/index-${hash}.css"></html>`;

function scaffold(withFlag: boolean) {
  const root = mkdtempSync(join(tmpdir(), "dev-reload-"));
  const publicDir = join(root, "public");
  mkdirSync(publicDir);
  writeFileSync(join(publicDir, "index.html"), html("AAA"));
  if (withFlag) writeFileSync(join(root, "topics-dev.json"), "{}");
  return { root, publicDir };
}

describe("startDevBundleReload", () => {
  test("no flag file → inert (no watcher, no broadcast, null rev)", async () => {
    const { root, publicDir } = scaffold(false);
    const sent: object[] = [];
    const reload = startDevBundleReload({
      publicDir,
      stateDir: root,
      broadcastToAll: (m) => sent.push(m),
      debounceMs: 20,
    });
    expect(reload.getRev()).toBeNull();
    writeFileSync(join(publicDir, "index.html"), html("BBB"));
    await Bun.sleep(120);
    expect(sent.length).toBe(0);
    reload.stop();
  });

  test("flag on: burst of writes ending in a new bundle → ONE debounced ui:bundle-updated carrying the rev", async () => {
    const { root, publicDir } = scaffold(true);
    const sent: Array<{ type?: string; rev?: string }> = [];
    const reload = startDevBundleReload({
      publicDir,
      stateDir: root,
      broadcastToAll: (m) => sent.push(m as { type?: string; rev?: string }),
      // Wide enough to absorb macOS FSEvents coalescing latency (~100ms), which
      // otherwise re-arms the timer AFTER the first broadcast and doubles it.
      debounceMs: 200,
    });
    expect(reload.getRev()).toBe(readBundleRev(publicDir));
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(publicDir, `chunk-${i}.js`), String(i));
      await Bun.sleep(5);
    }
    writeFileSync(join(publicDir, "index.html"), html("BBB"));
    await Bun.sleep(600);
    expect(sent.length).toBe(1);
    expect(sent[0]?.type).toBe("ui:bundle-updated");
    expect(sent[0]?.rev).toContain("index-BBB.js");
    expect(reload.getRev()).toBe(sent[0]?.rev ?? null);
    reload.stop();
  });

  test("byte-identical redeploy (same rev) → NO broadcast, no window blanked", async () => {
    const { root, publicDir } = scaffold(true);
    const sent: object[] = [];
    const reload = startDevBundleReload({
      publicDir,
      stateDir: root,
      broadcastToAll: (m) => sent.push(m),
      debounceMs: 60,
    });
    writeFileSync(join(publicDir, "index.html"), html("AAA")); // same content, fresh mtime
    await Bun.sleep(300);
    expect(sent.length).toBe(0);
    reload.stop();
  });

  test("stop() silences pending debounce", async () => {
    const { root, publicDir } = scaffold(true);
    const sent: object[] = [];
    const reload = startDevBundleReload({
      publicDir,
      stateDir: root,
      broadcastToAll: (m) => sent.push(m),
      debounceMs: 60,
    });
    writeFileSync(join(publicDir, "index.html"), html("BBB"));
    await Bun.sleep(20);
    reload.stop();
    await Bun.sleep(150);
    expect(sent.length).toBe(0);
  });
});

describe("readBundleRev", () => {
  test("sorted unique asset names; missing index.html → empty string", () => {
    const { publicDir } = scaffold(false);
    expect(readBundleRev(publicDir)).toBe("/assets/index-AAA.css,/assets/index-AAA.js");
    expect(readBundleRev(join(publicDir, "nope"))).toBe("");
  });
});
