import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDevBundleReload } from "./dev-bundle-reload";

function scaffold(withFlag: boolean) {
  const root = mkdtempSync(join(tmpdir(), "dev-reload-"));
  const publicDir = join(root, "public");
  mkdirSync(publicDir);
  if (withFlag) writeFileSync(join(root, "topics-dev.json"), "{}");
  return { root, publicDir };
}

describe("startDevBundleReload", () => {
  test("no flag file → inert (no watcher, no broadcast)", async () => {
    const { root, publicDir } = scaffold(false);
    const sent: object[] = [];
    const stop = startDevBundleReload({
      publicDir,
      stateDir: root,
      broadcastToAll: (m) => sent.push(m),
      debounceMs: 20,
    });
    writeFileSync(join(publicDir, "index.html"), "x");
    await Bun.sleep(120);
    expect(sent.length).toBe(0);
    stop();
  });

  test("flag on: burst of writes → ONE debounced ui:bundle-updated", async () => {
    const { root, publicDir } = scaffold(true);
    const sent: Array<{ type?: string }> = [];
    const stop = startDevBundleReload({
      publicDir,
      stateDir: root,
      broadcastToAll: (m) => sent.push(m as { type?: string }),
      // Wide enough to absorb macOS FSEvents coalescing latency (~100ms), which
      // otherwise re-arms the timer AFTER the first broadcast and doubles it.
      debounceMs: 200,
    });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(publicDir, `chunk-${i}.js`), String(i));
      await Bun.sleep(5);
    }
    await Bun.sleep(600);
    expect(sent.length).toBe(1);
    expect(sent[0]?.type).toBe("ui:bundle-updated");
    stop();
  });

  test("stop() silences pending debounce", async () => {
    const { root, publicDir } = scaffold(true);
    const sent: object[] = [];
    const stop = startDevBundleReload({
      publicDir,
      stateDir: root,
      broadcastToAll: (m) => sent.push(m),
      debounceMs: 60,
    });
    writeFileSync(join(publicDir, "index.html"), "x");
    await Bun.sleep(20);
    stop();
    await Bun.sleep(150);
    expect(sent.length).toBe(0);
  });
});
