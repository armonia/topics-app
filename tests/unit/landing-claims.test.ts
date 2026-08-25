/**
 * Two claims the public site kept making after they stopped being true.
 *
 * ── WHY A TEST AND NOT A PROOFREAD ──────────────────────────────────────────
 * Because both were correct the day they were typed, and neither could fail:
 *
 *  - **"no authentication layer at all"** shipped on the home page, on /v3, in
 *    `llms.txt` and in `agents.md`. Device pairing landed months later
 *    (`server/lib/device-auth.ts`, `server/routes/auth.ts`, `SECURITY.md`) and
 *    none of the four sentences moved. Telling a reader that a server which
 *    listens on every interface has no auth is not an out-of-date detail: it is
 *    an invitation to expose it, and `agents.md` is read by an agent that will
 *    repeat it as fact.
 *
 *  - **hard-coded asset names.** `agents.md` handed out
 *    `releases/latest/download/Topics_2.2.11_universal.dmg` while the tree was
 *    at 2.2.133. Every installer asset carries its version in its own name (see
 *    `.github/workflows/tauri-release.yml`, which builds them with
 *    tauri-action), so `releases/latest/download/<remembered name>` 404s the
 *    moment the next release lands, and releases here are automatic on every
 *    merge to main. The fix is to resolve the name from the release API at run
 *    time; this test is what stops the convenient literal from coming back.
 *
 * ── WHY IT READS THE SHIPPED TEXT ───────────────────────────────────────────
 * `landing/public/*` is served verbatim and the two pages are the rendered
 * copy, so the file is the artefact. Scanning them as text also catches a claim
 * that reappears on a page nobody thought to check.
 *
 * @covers SITE-01
 */
import { describe, expect, it } from "bun:test";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** The four surfaces the claim shipped on, and the ones this change owns. */
const REWRITTEN = [
  "landing/src/pages/index.astro",
  "landing/src/pages/v3.astro",
  "landing/public/llms.txt",
  "landing/public/agents.md",
];

/** The two machine-facing documents that hand out install commands. */
const AGENT_DOCS = ["landing/public/agents.md", "landing/public/llms.txt"];

/**
 * The claim, in shapes that are about MEANING and not about one wording. The
 * first list was four literals lifted off the pages that carried it, which is
 * how `/compare/claude-code-guis` kept "no authentication layer at all" while
 * the suite stayed green: it was in the file, just not in the four files the
 * literals were written against, and "no auth of its own" or "zero
 * authentication built in" would have slipped past even there.
 */
const DENIES_AUTH = [
  /\b(?:no|zero|not?\s+any|without|lacks?|lacking|missing)\s+(?:\w+[-\s]){0,3}auth(?:entication)?\b/i,
  /\bauth(?:entication)?\s+(?:layer\s+)?(?:of\s+its\s+own|is\s+absent|built[-\s]?in)\b/i,
  /\bunauthenticated\b/i,
];

/**
 * A sentence that tells a reader NOT to make the claim is not the claim.
 * `agents.md` writes "Do not call it unauthenticated." on purpose, and the
 * sieve used to exempt it with `(?!\.)` — by PUNCTUATION, which also waved
 * through "Topics is unauthenticated." Exempt on the correction instead, and
 * exempt one sentence, never a whole file.
 */
const CORRECTS_THE_CLAIM = /\b(?:do not|don't|never)\s+(?:call|say|describe|write|claim)\b/i;

/** Sentence-ish spans: a full stop, a line break or a tag boundary ends one. */
function claimSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n|<\/?[a-zA-Z][^>]*>/).filter((s) => s.trim().length > 0);
}

/** Sentences in `text` that deny the pairing layer, corrections excluded. */
function deniesAuth(text: string): string[] {
  return claimSentences(text).filter(
    (s) => !CORRECTS_THE_CLAIM.test(s) && DENIES_AUTH.some((shape) => shape.test(s)),
  );
}

/** Every text file the site ships, sources and public assets alike. */
function landingText(): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", "dist", "app", ".astro"]);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(astro|md|mdx|txt|ts|json)$/.test(entry)) out.push(relative(ROOT, full));
    }
  };
  walk(join(ROOT, "landing", "src"));
  walk(join(ROOT, "landing", "public"));
  return out;
}

describe("landing · what the site says about authentication", () => {
  it("the sieve catches the wordings the literal list let through", () => {
    // Without this the file could go green because the regexes stopped
    // matching, which is exactly what happened to the four literals it
    // replaced. The first two are the sentences that actually shipped.
    for (const claim of [
      "No accounts, no team roles, no authentication layer at all.",
      "Topics is unauthenticated.",
      "It has no auth of its own.",
      "There is zero authentication built in.",
      "It ships without any authentication.",
      "The app lacks authentication.",
    ]) {
      expect(deniesAuth(claim), `the sieve does not see: ${claim}`).toHaveLength(1);
    }
    // And it leaves alone the honest copy, including the line that warns an
    // agent off the claim and the sentences that say what IS there.
    for (const ok of [
      "**No accounts and no team roles. Do not call it unauthenticated.** This page used to.",
      "What exists is device pairing: any other device is approved once and carries a token you can revoke.",
      "No hosted service of any kind. No relay, no managed remote access.",
    ]) {
      expect(deniesAuth(ok), `the sieve wrongly flags: ${ok}`).toEqual([]);
    }
  });

  for (const doc of REWRITTEN) {
    it(`${doc} does not claim Topics has no authentication`, () => {
      expect(existsSync(join(ROOT, doc)), `${doc} moved: update this list`).toBe(true);
      expect(deniesAuth(read(doc)), `${doc} still denies the pairing layer that shipped`).toEqual([]);
    });

    it(`${doc} says a device authorization can be taken back`, () => {
      // The negative alone would be satisfied by deleting the sentence, which
      // trades one wrong answer for no answer. Revocation is the part that
      // makes the honest version honest: an approval you cannot withdraw is
      // worth less than the page would be implying.
      expect(read(doc), `${doc} describes pairing without saying it can be revoked`).toMatch(/\brevoc(?:able|ation)\b|\brevoked?\b/i);
    });
  }

  it("no other shipped landing text carries the claim", () => {
    // No exemption list any more. `/compare/claude-code-guis` was the last
    // entry on it, and an exemption list on a claim this one-sided is a way of
    // shipping the claim with a note attached.
    const offenders = landingText().flatMap((f) => deniesAuth(read(f)).map((s) => `${f}: ${s.trim()}`));
    expect(offenders).toEqual([]);
  });

  it("the sweep is looking at the pages, not at an empty set", () => {
    const files = landingText();
    expect(files.length).toBeGreaterThan(5);
    for (const doc of REWRITTEN) expect(files).toContain(doc);
    expect(files).toContain("landing/src/pages/compare/claude-code-guis.astro");
  });
});

describe("landing · install commands cannot rot", () => {
  for (const doc of AGENT_DOCS) {
    it(`${doc} writes no version into a release URL`, () => {
      for (const [i, line] of read(doc).split("\n").entries()) {
        if (!/github\.com\/armonia\/topics-app[^\s)"']*releases/.test(line)) continue;
        expect(line, `${doc}:${i + 1} pins a version into a release URL, which 404s at the next release`)
          .not.toMatch(/\d+\.\d+\.\d+/);
      }
    });

    it(`${doc} quotes no literal asset name`, () => {
      // `Topics_X.Y.Z_universal.dmg` as a shape is fine and is what the docs
      // now show; `Topics_2.2.11_universal.dmg` is a name that exists on
      // exactly one release page.
      expect(read(doc), `${doc} names a versioned asset that only one release has`)
        .not.toMatch(/Topics[-_]\d+\.\d+\.\d+/);
    });

    it(`${doc} prints no literal product version`, () => {
      // The series is 2.x and moves on every merge to main. Any 2.a.b written
      // in a document nobody rebuilds is a number that will be quoted back as
      // current long after it stops being current.
      expect(read(doc), `${doc} prints a version that ages without failing`).not.toMatch(/\b2\.\d+\.\d+\b/);
    });
  }

  it("the asset names the release workflow produces do carry the version", () => {
    // The reason the rules above exist, taken from the workflow rather than
    // asserted from memory: tauri-action bundles per target, and the macOS job
    // is the universal one whose .dmg is `Topics_<version>_universal.dmg`.
    // If the pipeline ever emitted version-free names, these tests would be
    // guarding against a problem that no longer exists and should be revisited.
    const wf = read(".github/workflows/tauri-release.yml");
    expect(wf).toMatch(/tauri-apps\/tauri-action/);
    expect(wf, "no universal macOS target: asset naming may have changed").toMatch(/universal-apple-darwin/);
  });
});
