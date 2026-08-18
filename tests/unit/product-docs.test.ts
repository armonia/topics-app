/**
 * The three product documents a stranger reads before anything of ours runs:
 * `.env.example` (which README tells them to copy verbatim), the README
 * configuration table, and the README download table.
 *
 * ── WHY A TEST AND NOT A PROOFREAD ──────────────────────────────────────────
 * Because each of these was true when it was written, and stopped being true
 * without breaking a build:
 *
 *  - `.env.example` pinned `AI_PROVIDER=openclaw`. README says
 *    `cp .env.example .env`, and Bun auto-loads `.env`, so the pin reached
 *    every fresh clone. An explicit `AI_PROVIDER` beats connectivity in
 *    `recomputeDefault()` (server/providers/index.ts), so a first boot routed
 *    every chat at a gateway that is not installed. Nothing errors: the chat
 *    just never answers.
 *  - The README `AI_PROVIDER` row listed the three API-shaped providers and
 *    omitted `claude-code` and `codex`, which rank ABOVE them in
 *    PROVIDER_PREFERENCE_ORDER precisely because they are the only paths a
 *    paid subscription pays for. A row that hides the free options is worse
 *    than no row.
 *  - The README promised a Linux `.AppImage`. CI stopped building one
 *    (`--bundles deb,rpm`); a promised asset that is not on the release page
 *    reads as a broken download.
 *
 * ── WHY IT READS SOURCE INSTEAD OF IMPORTING ────────────────────────────────
 * PROVIDER_PREFERENCE_ORDER lives in `server/providers/index.ts`, whose import
 * graph reaches `services/app-settings` -> `getDatabase()`: importing the
 * barrel opens the real SQLite database. A doc test must never touch it, so we
 * parse the array out of the file. The point stands either way: the expected
 * values come from the code, so adding a provider fails this test until the
 * README names it.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/**
 * The preference order, taken from the code. A literal array in the test would
 * only assert that we can copy, which is the mistake this file exists to catch.
 */
function providerPreferenceOrder(): string[] {
  const src = read("server/providers/index.ts");
  const block = src.match(/const PROVIDER_PREFERENCE_ORDER\s*=\s*\[([\s\S]*?)\]/);
  expect(block, "PROVIDER_PREFERENCE_ORDER no longer parses out of server/providers/index.ts").toBeTruthy();
  const names = [...block![1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  expect(names.length).toBeGreaterThan(1);
  return names;
}

/**
 * The BOOT default, taken from the code: the env-driven ternary in `server.ts`
 * that names a provider before any preference order has run.
 *
 * This is the fact both documents got wrong. They described `PROVIDER_PREFERENCE_ORDER`
 * as the auto-detection rule ("first one connected wins"), but `recomputeDefault()`
 * (server/providers/index.ts) returns early while the current default is still
 * connected, so with a key set the order never executes at all. It chooses the
 * REPLACEMENT, and its own docstring calls it the order "di RIPIEGO".
 */
function bootDefaultChain(): { pairs: [string, string][]; fallback: string } {
  const src = read("server.ts");
  const decl = src.match(/const providerType =([\s\S]*?);\n/);
  expect(decl, "the providerType boot default no longer parses out of server.ts").toBeTruthy();
  const pairs = [...decl![1].matchAll(/process\.env\.([A-Z0-9_]+)\s*\?\s*['"]([a-z0-9-]+)['"]/g)].map(
    (m) => [m[1], m[2]] as [string, string],
  );
  const tail = decl![1].match(/['"]([a-z0-9-]+)['"]\s*\)?\s*$/);
  expect(tail, "the keyless fallback no longer parses out of server.ts").toBeTruthy();
  // Fewer than three pairs means the parse broke, not that the rule got simpler.
  expect(pairs.length).toBeGreaterThanOrEqual(3);
  return { pairs, fallback: tail![1] };
}

/**
 * Where a document spells out PROVIDER_PREFERENCE_ORDER as a chain, or -1.
 * Built from the parsed order so the arrow style (`->` in a comment, `→` in a
 * table) does not matter and a reordered table has to move the prose with it.
 */
function preferenceChainIndex(text: string): number {
  const names = providerPreferenceOrder();
  const re = new RegExp(names.join("[^A-Za-z0-9_]{1,12}"));
  return text.match(re)?.index ?? -1;
}

/** The `.env.example` block that documents AI_PROVIDER, up to the next heading. */
function envProviderBlock(): string {
  const env = read(".env.example");
  const start = env.indexOf("# ==== AI provider ====");
  expect(start, ".env.example lost its AI provider section").toBeGreaterThan(-1);
  const rest = env.slice(start + 1);
  const end = rest.indexOf("# ==== ");
  return end === -1 ? rest : rest.slice(0, end);
}

/** The bundle formats CI actually produces for Linux. */
function linuxBundles(): string[] {
  const wf = read(".github/workflows/tauri-release.yml");
  const m = wf.match(/--bundles\s+([a-z0-9,]+)/);
  expect(m, "--bundles no longer parses out of tauri-release.yml").toBeTruthy();
  return m![1].split(",").filter(Boolean);
}

/**
 * The README passage that documents `label`, from its first mention to the next
 * heading.
 *
 * IT USED TO BE THE TABLE ROW ALONE, and that is what broke. The facts these
 * assertions guard — which keys decide the default, in which order, and the
 * fallback — never fit in a three-column cell: the row said "Pins one provider"
 * and the rule lived in the paragraph under the table. Pinning the assertions to
 * the row meant they went red on 2026-08-18 for a README that stated every fact
 * correctly, just one paragraph lower. A doc contract has to survive its
 * document being edited; what it must NOT survive is a fact going missing.
 *
 * The window is deliberately generous (to the next `##`, or `</details>`): a
 * reader who opens that section sees all of it, so "the section says it" is the
 * honest unit of measure. It is not the whole file — a claim made three sections
 * away still fails, which is the point.
 */
function readmeBlock(label: string, options: { prose?: boolean } = {}): string {
  const lines = read("README.md").split("\n");
  // `prose: true` skips the variables TABLE. Anchoring on the `AI_PROVIDER` row
  // dragged in the rows under it — `GATEWAY_URL` among them — so "the keys are
  // listed in the order server.ts tests them" measured the table's alphabet
  // instead of the paragraph's argument. The rule is explained in prose; that
  // is the text to read.
  const start = lines.findIndex(
    (line) => line.includes(label) && !(options.prose && line.trimStart().startsWith("|")),
  );
  expect(start, `the README never mentions ${label}`).toBeGreaterThan(-1);
  const rest = lines.slice(start);
  const end = rest.findIndex((line, i) => i > 0 && (line.startsWith("## ") || line.startsWith("</details>")));
  const block = (end === -1 ? rest : rest.slice(0, end)).join("\n");
  expect(block.length, `the README block for ${label} is empty`).toBeGreaterThan(0);
  return block;
}

/**
 * The clause of the Install line that talks about one platform.
 *
 * One sentence names three platforms — "`.dmg` for macOS, `.exe` or `.msi` for
 * Windows, `.deb` or `.rpm` for Linux" — so the whole sentence cannot answer
 * "which formats does Linux get". The comma-separated clause can, and it keeps
 * the assertion two-sided: naming a Linux format CI does not build still fails.
 */
function readmePlatformClause(platform: string): string {
  const clause = readmeBlock("## Install")
    .split(/[,.]\s|\n/)
    .find((part) => part.includes(platform) && part.includes("`."));
  expect(clause, `the README Install section names no file format for ${platform}`).toBeTruthy();
  return clause!;
}

describe("product docs match the code", () => {
  it(".env.example does not pin AI_PROVIDER", () => {
    // Commented-out examples are the whole point of the file, so only an
    // assignment at the start of a line counts: that is what Bun loads.
    const pinned = read(".env.example")
      .split("\n")
      .filter((line) => /^\s*(?:export\s+)?AI_PROVIDER\s*=/.test(line));
    expect(
      pinned,
      "an uncommented AI_PROVIDER in .env.example reaches every fresh clone via `cp .env.example .env`",
    ).toEqual([]);
  });

  it(".env.example names every valid AI_PROVIDER value in a comment", () => {
    const env = read(".env.example");
    for (const name of providerPreferenceOrder()) {
      // Delimited, not `toContain`: `claude` is a substring of `claude-code`,
      // so the plain check passed on a file that named only the CLI. The README
      // assertion below solved this with a code span; a comment has no spans,
      // so the boundary has to treat `-` as part of the name.
      expect(env, `.env.example never mentions the ${name} provider on its own`).toMatch(
        new RegExp(`(?<![\\w-])${name}(?![\\w-])`),
      );
    }
  });

  it("the provider-name sieve is not satisfied by a longer name", () => {
    // The bug it replaced, stated as a fact: without the boundaries, a file
    // that only ever writes `claude-code` reads as if it also named `claude`.
    const onlyTheCli = "# Valid values: claude-code\n";
    expect(onlyTheCli).toContain("claude");
    expect(onlyTheCli).not.toMatch(new RegExp("(?<![\\w-])claude(?![\\w-])"));
    expect("# claude | codex").toMatch(new RegExp("(?<![\\w-])claude(?![\\w-])"));
  });

  it("the README AI_PROVIDER row names every provider in PROVIDER_PREFERENCE_ORDER", () => {
    const row = readmeBlock("AI_PROVIDER", { prose: true });
    for (const name of providerPreferenceOrder()) {
      // `claude` is a substring of `claude-code`: require the code span so a
      // row naming only `claude-code` cannot pass as if it named `claude`.
      expect(row, `the README AI_PROVIDER row does not name \`${name}\``).toContain(`\`${name}\``);
    }
  });

  it("both documents state the env key that actually decides the default", () => {
    // The claim they used to make ("auto-detect, first one connected wins") is
    // false the moment any of these three variables is set: server.ts picks the
    // default from them, and recomputeDefault() keeps it while it is connected.
    // Naming the variables IN THE ORDER THE CODE TESTS THEM is the whole point:
    // a reader with both ANTHROPIC_API_KEY and GATEWAY_URL set has to be able to
    // work out which one wins.
    const { pairs, fallback } = bootDefaultChain();
    for (const [where, text] of [
      ["the README AI_PROVIDER section", readmeBlock("AI_PROVIDER", { prose: true })],
      ["the .env.example AI provider block", envProviderBlock()],
    ] as const) {
      const at: number[] = [];
      for (const [envName, provider] of pairs) {
        const i = text.indexOf(envName);
        expect(i, `${where} never says ${envName} decides the default`).toBeGreaterThan(-1);
        expect(text, `${where} names ${envName} without the provider it selects`).toContain(provider);
        at.push(i);
      }
      expect(
        at,
        `${where} lists the keys in a different order than server.ts tests them`,
      ).toEqual([...at].sort((a, b) => a - b));
      expect(text, `${where} omits the keyless fallback (${fallback})`).toContain(fallback);

      // Order on the page, not just presence. Both documents already happened
      // to mention the three variables somewhere; what made them wrong is that
      // they led with PROVIDER_PREFERENCE_ORDER, so a reader took the ranking
      // for the rule and the keys for a detail. The rule comes first.
      const chain = preferenceChainIndex(text);
      expect(chain, `${where} no longer shows the preference order at all`).toBeGreaterThan(-1);
      expect(
        at[0],
        `${where} presents the preference order before the key that actually decides`,
      ).toBeLessThan(chain);
    }
  });

  it("neither document promises that an offline provider fails silently", () => {
    // `.env.example` said a chat aimed at a gateway you never installed "does
    // not error, it simply never answers". server/providers/index.ts documents
    // the opposite outcome at the point where it re-picks the default.
    expect(
      read("server/providers/index.ts"),
      "the error this doc line was corrected against is gone: re-read the doc",
    ).toContain("Gateway unreachable");
    expect(envProviderBlock(), ".env.example still promises a silent no-answer").not.toMatch(
      /does not error/i,
    );
  });

  it(".env.example flags the providers that register without their backend", () => {
    // "a provider is registered only when it is really there" was false for two
    // of the five. `claude` is registered unconditionally by initProvider() at
    // boot, with an empty key, as the last-resort default; `claude-code` is
    // registered by CLAUDE_CODE_ENABLED alone. Both then sit in the picker
    // looking available.
    const providers = read("server/providers/index.ts");
    expect(
      providers,
      "claude-code no longer registers on the flag alone: this doc caveat can go",
    ).toMatch(/explicitlyEnabled\s*\|\|\s*cliAvailable/);
    const block = envProviderBlock();
    expect(block, ".env.example does not warn that CLAUDE_CODE_ENABLED registers a missing CLI").toContain(
      "CLAUDE_CODE_ENABLED",
    );
    expect(block, ".env.example still claims every provider is registered only when present").not.toMatch(
      /registered only when it\s*\n?#?\s*is really there/i,
    );
  });

  it("the README Linux row names exactly the bundles CI builds", () => {
    const bundles = linuxBundles();
    const row = readmePlatformClause("Linux");
    // Case-insensitive on purpose: the row this test was written against said
    // `.AppImage`, and a lowercase-only class silently skipped it, leaving the
    // assertion green over a README that promised an asset CI never builds.
    const named = [...row.matchAll(/`\.([A-Za-z0-9]+)`/g)].map((m) => m[1].toLowerCase());
    expect(named.length, "the README Linux clause names no file format").toBeGreaterThan(0);
    expect(
      [...new Set(named)].sort(),
      "the README Install line and the workflow's --bundles disagree",
    ).toEqual([...new Set(bundles)].sort());
  });
});
