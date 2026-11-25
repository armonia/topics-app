/**
 * @covers GATE-07
 *
 * `check:instance-strings`: no tracked file may carry strings that belong to ONE
 * installation (a person's home, the private harness folder, an account, a
 * phone, a long numeric id, an IP) and would be wrong on any other machine.
 *
 * Two layers:
 *  - the machine's own list: `~/bin/push-guard --scan`, when it exists. The
 *    list of names lives there and never in the repo; in CI the binary is
 *    absent and this layer is skipped, the classes below still run.
 *  - classes that need no list, counted per file against a ratchet
 *    (`instance-strings-baseline.json`): a file's count may go down, never up,
 *    and a file not in the baseline starts at 0. `services/`, `scripts/ops/`
 *    and `harness/` are born at 0 and accept no baseline entry. `openspec/` is
 *    held by one total per class, because its prose quotes real paths.
 *
 * Refresh the baseline after a cleanup with
 * `UPDATE_INSTANCE_BASELINE=1 bun test tests/unit/no-instance-strings.test.ts`;
 * it refuses to write a number higher than the one it replaces.
 *
 * Agent ids are never written here: set `TOPICS_INSTANCE_IDS` (comma list, read
 * by the caller from its own settings) and they are searched as literals.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitEnv } from "../setup/bun-test-preload";

const ROOT = resolve(import.meta.dir, "../..");
const BASELINE_PATH = join(import.meta.dir, "instance-strings-baseline.json");

const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|py|sh|ps1|yml|yaml|plist|toml|md)$/;
const TEST_FILE = /(\.test\.|\.spec\.|(^|\/)(tests?|fixtures|__tests__)\/|(^|\/)test_[^/]+$)/;
const CODE_DIRS = /^(server|shared|client\/src|scripts|cli|relay|deploy|services|harness)\//;
const ZERO_DIRS = /^(services|scripts\/ops|harness)\//;
const OPENSPEC = /^openspec\/(?!changes\/archive\/)/;

const GENERIC_NAMES = "you|user|users|name|me|x|someone|foo|bar|test|runner|shared|username|your-name|yourname|admin|ubuntu|topics|node";

const CLASSES: Record<string, RegExp> = {
  home: new RegExp(
    `(/Users/(?!(?:${GENERIC_NAMES})\\b)[A-Za-z][\\w.-]+|C:\\\\\\\\?Users\\\\\\\\?(?!(?:${GENERIC_NAMES})\\b)[A-Za-z][\\w.-]+)`,
    "g",
  ),
  harness: /\.claude\/jarvis/g,
  account: /[\w.+-]+@(?!example\.|users\.noreply|noreply|localhost)[\w-]+\.[a-z]{2,}/gi,
  phone: /\+\d{10,13}\b/g,
  longId: /(?<![\w.])\d{17,19}(?![\w.])/g,
  ip: /(?<![\w.])(?!127\.|0\.0\.0\.0|255\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w.])/g,
};

type Counts = Record<string, number>;
type Baseline = { files: Record<string, Counts>; openspec: Counts };

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: gitEnv() })
    .split("\0")
    .filter((f) => f && TEXT_EXT.test(f) && !TEST_FILE.test(f));
}

function countFile(text: string, extra: RegExp | null): Counts {
  const out: Counts = {};
  for (const [name, re] of Object.entries(CLASSES)) {
    const n = text.match(re)?.length ?? 0;
    if (n) out[name] = n;
  }
  if (extra) {
    const n = text.match(extra)?.length ?? 0;
    if (n) out.agentId = n;
  }
  return out;
}

function agentIdRegex(): RegExp | null {
  const ids = (process.env.TOPICS_INSTANCE_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return ids.length ? new RegExp(ids.map((i) => i.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : null;
}

function measure(): { files: Record<string, Counts>; openspec: Counts } {
  const extra = agentIdRegex();
  const files: Record<string, Counts> = {};
  const openspec: Counts = {};
  for (const f of trackedFiles()) {
    const inCode = CODE_DIRS.test(f);
    const inSpec = OPENSPEC.test(f);
    if (!inCode && !inSpec) continue;
    let text: string;
    try {
      text = readFileSync(join(ROOT, f), "utf8");
    } catch {
      continue;
    }
    const counts = countFile(text, extra);
    if (inSpec) {
      for (const [k, v] of Object.entries(counts)) openspec[k] = (openspec[k] ?? 0) + v;
    } else if (Object.keys(counts).length) {
      files[f] = counts;
    }
  }
  return { files, openspec };
}

/** Violations of the ratchet: every entry says which path rose above its baseline. */
function compare(current: ReturnType<typeof measure>, baseline: Baseline): string[] {
  const bad: string[] = [];
  for (const [file, counts] of Object.entries(current.files)) {
    const allowed = ZERO_DIRS.test(file) ? {} : (baseline.files[file] ?? {});
    for (const [k, n] of Object.entries(counts)) {
      if (n > (allowed[k as keyof typeof allowed] ?? 0)) bad.push(`${file}: ${k} ${n} > ${allowed[k as keyof typeof allowed] ?? 0}`);
    }
  }
  for (const [k, n] of Object.entries(current.openspec)) {
    if (n > (baseline.openspec[k] ?? 0)) bad.push(`openspec/: ${k} ${n} > ${baseline.openspec[k] ?? 0}`);
  }
  return bad;
}

function loadBaseline(): Baseline {
  return existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : { files: {}, openspec: {} };
}

describe("check:instance-strings", () => {
  test("no path gains instance strings above its ratchet", () => {
    const current = measure();
    const baseline = loadBaseline();
    if (process.env.UPDATE_INSTANCE_BASELINE === "1") {
      const next: Baseline = { files: {}, openspec: current.openspec };
      for (const [f, c] of Object.entries(current.files)) if (!ZERO_DIRS.test(f)) next.files[f] = c;
      // An empty baseline is the first adoption; after that nothing may rise.
      const adopting = Object.keys(baseline.files).length === 0;
      const raised = adopting ? [] : compare(current, baseline);
      if (raised.length) throw new Error(["refusing to raise the baseline:", ...raised].join("\n"));
      writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + "\n");
      return;
    }
    expect(compare(current, baseline)).toEqual([]);
  }, 120_000);

  test("zero-born directories hold no baseline entry", () => {
    const baseline = loadBaseline();
    expect(Object.keys(baseline.files).filter((f) => ZERO_DIRS.test(f))).toEqual([]);
  });

  test("the ratchet turns red on an invented IP, phone and home path", () => {
    const fake = { files: { "services/x.ts": countFile("host 8.8.4.4 tel +393331234567 /Users/zed/p", null) }, openspec: {} };
    const bad = compare(fake, { files: {}, openspec: {} });
    expect(bad.length).toBe(3);
  });

});
