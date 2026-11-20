/**
 * The Apple adapter, from its two ends.
 *
 * With a fake helper process (same NDJSON protocol, `tests/helpers/fake-reasoning-helper.mjs`)
 * it proves the plumbing on every machine: requests answered in order, a helper
 * that dies mid-request rejects instead of hanging, a missing helper means "not
 * available". The block at the bottom builds and runs the REAL Swift helper and
 * is skipped where that cannot work (not macOS 26, no command line tools, or the
 * English-Italian pair not installed).
 *
 * @covers REASONING-TRANSLATE-01
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { AppleReasoningTranslator } from "./apple-adapter";

const FAKE_HELPER = join(import.meta.dir, "../../tests/helpers/fake-reasoning-helper.mjs");
const made: string[] = [];
const adapters: AppleReasoningTranslator[] = [];

function adapter(options: { helperPath?: string } = {}) {
  const cacheDir = mkdtempSync(join(tmpdir(), "reasoning-adapter-"));
  made.push(cacheDir);
  const a = new AppleReasoningTranslator({ cacheDir, helperPath: options.helperPath ?? FAKE_HELPER });
  adapters.push(a);
  return a;
}

afterEach(() => {
  for (const a of adapters.splice(0)) a.stop();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("with a helper process", () => {
  test("it reports available, detects a language and translates a sentence", async () => {
    const a = adapter();
    expect(await a.available()).toBe(true);
    expect(await a.detect("Then I will check the migration file.")).toEqual({ language: "en", confidence: 0.99 });
    expect(await a.pairReady("en", "it")).toBe(true);
    expect(await a.pairReady("en", "fr")).toBe(false);
    expect(await a.translate("After that the answer can be written.", "en", "it")).toBe("Dopo di che si può scrivere la risposta.");
  });

  test("requests sent together are answered each with its own reply", async () => {
    const a = adapter();
    const answers = await Promise.all([
      a.translate("After that the answer can be written.", "en", "it"),
      a.translate("Then I will check the migration file for the new column.", "en", "it"),
      a.translate("Something the dictionary does not know.", "en", "it"),
    ]);
    expect(answers).toEqual([
      "Dopo di che si può scrivere la risposta.",
      "Poi controllerò il file di migrazione per la nuova colonna.",
      "[it] Something the dictionary does not know.",
    ]);
  });

  test("a helper that dies mid-request rejects the request, and the next one starts a new helper", async () => {
    const a = adapter();
    // `crash` is an operation only the fake knows: it exits without answering.
    const dying = (a as unknown as { request(p: Record<string, unknown>): Promise<unknown> }).request({ op: "crash" });
    await expect(dying).rejects.toThrow("exited");
    expect(await a.translate("After that the answer can be written.", "en", "it")).toBe("Dopo di che si può scrivere la risposta.");
  });
});

describe("with no helper", () => {
  test("a helper path that does not exist means not available, and every call degrades quietly", async () => {
    const a = adapter({ helperPath: "/nonexistent/helper" });
    expect(await a.available()).toBe(false);
    expect(await a.detect("Then I will check the migration file.")).toBeNull();
    expect(await a.pairReady("en", "it")).toBe(false);
    await expect(a.translate("Then I will check.", "en", "it")).rejects.toThrow();
  });
});

// The real thing: only where it can run. The helper is compiled once, in a temp
// folder, with the machine's own compiler.
const isMac26 = process.platform === "darwin" && Number.parseInt(release(), 10) >= 25;
const hasTools = isMac26 && spawnSync("xcode-select", ["-p"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasTools)("the real Swift helper (macOS 26 with the command line tools)", () => {
  test("it compiles, detects English and translates a sentence into Italian", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "reasoning-real-"));
    made.push(cacheDir);
    const real = new AppleReasoningTranslator({ cacheDir });
    adapters.push(real);
    expect(await real.available()).toBe(true);
    const sentence = "I need to check the failing test and then look at the migration file.";
    const detected = await real.detect(sentence);
    expect(detected?.language).toBe("en");
    // A machine without the English-Italian pair installed cannot translate: not a failure of the helper.
    if (!(await real.pairReady("en", "it"))) return;
    const started = Date.now();
    const out = await real.translate(sentence, "en", "it");
    console.log(`REAL-HELPER ${Date.now() - started} ms: ${sentence} -> ${out}`);
    expect(out.trim().length).toBeGreaterThan(10);
    expect(out).not.toBe(sentence);
    expect((await real.detect(out))?.language).toBe("it");
  }, 180_000);
});
