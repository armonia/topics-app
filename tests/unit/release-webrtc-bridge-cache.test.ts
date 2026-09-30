/**
 * The release reuses the WebRTC bridge sidecar when nothing it is built from
 * changed, and the cache key covers every file it is built from.
 *
 * WHY THIS TEST EXISTS. The crate did not change after 12/08, and every
 * release rebuilt it on the macOS critical path anyway (180 s and 200 s in
 * runs 36707071391 and 36710886768). The cache that fixes that is only safe if
 * its key moves whenever the binary would: a key that misses an input ships a
 * stale bridge, silently. So the key is checked against the files of the crate
 * as they are on disk, not against a list written here.
 *
 * Text scan and not a YAML parse, like the other workflow tests: the repo has
 * no YAML dependency.
 * @covers RELEASE-03
 */
import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const WF = readFileSync(resolve(ROOT, ".github/workflows/tauri-release.yml"), "utf8");
const CRATE = "desktop-tauri/webrtc-bridge";

type Step = { name: string; body: string; index: number };

function steps(): Step[] {
  const lines = WF.split("\n");
  const out: Step[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {6}- name: (.+)$/.exec(lines[i]!);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !/^ {6}- /.test(lines[j]!) && !/^ {2}\S/.test(lines[j]!)) j++;
    // Comments are dropped: the block above a step would otherwise count as the
    // body of the step before it.
    const body = lines.slice(i, j).filter((l) => !/^\s*#/.test(l)).join("\n");
    out.push({ name: m[1]!.trim(), body, index: out.length });
  }
  return out;
}

const all = steps();
const cache = all.find((s) => /uses: actions\/cache@/.test(s.body) && /binaries\/webrtc-bridge-/.test(s.body));
const builds = all.filter((s) => /build-webrtc-bridge\.sh/.test(s.body) && /\brun: /.test(s.body));
const key = cache ? (/^\s*key: (.+)$/m.exec(cache.body)?.[1] ?? "") : "";

describe("release: the WebRTC bridge sidecar is cached by a hash of its sources", () => {
  it("a cache step saves the built sidecar, before any build step", () => {
    expect(cache).toBeDefined();
    expect(builds.length).toBe(3);
    for (const b of builds) expect(b.index).toBeGreaterThan(cache!.index);
  });

  it("every build step is skipped on a cache hit", () => {
    const id = /^\s*id: (\S+)$/m.exec(cache?.body ?? "")?.[1];
    expect(id).toBeDefined();
    for (const b of builds) {
      expect(b.body).toContain(`steps.${id}.outputs.cache-hit != 'true'`);
    }
  });

  it("the key moves with the OS and the compiler, not only with the sources", () => {
    expect(key).toContain("runner.os");
    expect(key).toMatch(/steps\.\w+\.outputs\.version/);
  });

  it("the key does not hash the whole crate folder, which includes the target/ rust-cache restores", () => {
    expect(key).not.toContain(`'${CRATE}/**'`);
  });

  it("every file the build reads is in the key: sources, manifest, lockfile, the build script", () => {
    // What cargo reads from the crate: src/, Cargo.toml, Cargo.lock, and a
    // build.rs or .cargo/ if one ever appears. Docs and the node harness are not
    // build inputs. A new top-level entry that is not listed here fails the
    // test until someone decides whether the key needs it.
    const notInputs = new Set([".gitignore", "README.md", "DECISIONE-turn-oltre-lan.md", "turn-oltre-lan.svg", "test-harness.mjs", "target"]);
    const inputs = readdirSync(resolve(ROOT, CRATE)).filter((f) => !notInputs.has(f));
    expect(inputs.length).toBeGreaterThan(0);
    for (const f of inputs) {
      const pattern = f === "src" ? `'${CRATE}/src/**'` : `'${CRATE}/${f}'`;
      expect({ file: f, inKey: key.includes(pattern) }).toEqual({ file: f, inKey: true });
    }
    expect(key).toContain("'scripts/build-webrtc-bridge.sh'");
  });
});
