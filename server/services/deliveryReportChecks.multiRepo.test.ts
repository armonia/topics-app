import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { extractClaims, checkReport } from "./deliveryReportChecks";
import { probeForRoot } from "./deliveryReportProbe";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const ROOT = join(import.meta.dir, "..", "..");
type DeliveryReportFixture = Array<{ title: string; reports: string[] }>;
const DELIVERY_REPORT_FIXTURE: DeliveryReportFixture = JSON.parse(
  readFileSync(join(ROOT, "tests/fixtures/delivery-reports-multi-repo.json"), "utf8"),
);

function initializeGitMarkerRoot(root: string): void {
  mkdirSync(join(root, ".git"), { recursive: true });
}

function writeIndependentFixture(root: string, file: string): string {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), "fixture commit\n");
  return "abcdef0123456789abcdef0123456789abcdef01";
}

function createIndependentOverflowRoots(
  home: string,
  count: number,
  targetIndex: number,
  targetName: string,
): { roots: string[]; sha: string } {
  // These tests isolate root selection; real Git process behavior has its own probe tests above.
  const source = join(home, "overflow-source");
  initializeGitMarkerRoot(source);
  writeIndependentFixture(source, "source.txt");
  const target = join(home, targetName);
  initializeGitMarkerRoot(target);
  const sha = writeIndependentFixture(target, "proof.txt");
  const roots: string[] = [];
  for (let index = 0; index < count; index++) {
    if (index === targetIndex) {
      roots.push(target);
    } else {
      const linkedRepo = join(home, `repo-${index}`);
      mkdirSync(linkedRepo, { recursive: true });
      writeFileSync(join(linkedRepo, ".git"), `gitdir: ${join(source, ".git")}\n`);
      roots.push(linkedRepo);
    }
  }
  return { roots, sha };
}

function useFastGit(scratch: string, shaRoot?: string, sha?: string): () => void {
  const bin = join(scratch, "git-bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "git");
  writeFileSync(shim, [
    "#!/bin/sh",
    'root=$(pwd -P)',
    'if [ "$1" = "-C" ]; then',
    "  root=$2",
    "  shift 2",
    "fi",
    'if [ -e "$root/.git" ] && [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then',
    '  printf "%s\\n" "$root"',
    "  exit 0",
    "fi",
    'if [ -e "$root/.git" ] && [ "$1" = "cat-file" ] && [ "$2" = "-e" ]; then',
    '  if [ "$root" = "${FAST_GIT_SHA_ROOT:-}" ] && [ "$3" = "${FAST_GIT_SHA:-}^{commit}" ]; then exit 0; fi',
    "  exit 1",
    "fi",
    'exec /usr/bin/git "$@"',
    "",
  ].join("\n"));
  chmodSync(shim, 0o755);
  const previous = {
    PATH: process.env.PATH,
    FAST_GIT_SHA_ROOT: process.env.FAST_GIT_SHA_ROOT,
    FAST_GIT_SHA: process.env.FAST_GIT_SHA,
  };
  process.env.PATH = `${bin}:${previous.PATH ?? ""}`;
  if (shaRoot && sha) {
    process.env.FAST_GIT_SHA_ROOT = realpathSync(shaRoot);
    process.env.FAST_GIT_SHA = sha;
  } else {
    delete process.env.FAST_GIT_SHA_ROOT;
    delete process.env.FAST_GIT_SHA;
  }
  return () => {
    if (previous.PATH === undefined) delete process.env.PATH;
    else process.env.PATH = previous.PATH;
    if (previous.FAST_GIT_SHA_ROOT === undefined) delete process.env.FAST_GIT_SHA_ROOT;
    else process.env.FAST_GIT_SHA_ROOT = previous.FAST_GIT_SHA_ROOT;
    if (previous.FAST_GIT_SHA === undefined) delete process.env.FAST_GIT_SHA;
    else process.env.FAST_GIT_SHA = previous.FAST_GIT_SHA;
  };
}

describe("delivery SHA caps have independent regression fixtures", () => {
  test.serial("oltre 48 repo citati, lo SHA nel trentunesimo resta verificabile", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "delivery-sha-cap-"));
    const cardRoot = join(scratch, "card");
    initializeGitMarkerRoot(cardRoot);
    writeIndependentFixture(cardRoot, "card.txt");
    try {
      const fixture = createIndependentOverflowRoots(scratch, 49, 30, "repo-30");
      const roots = fixture.roots.map((root) => realpathSync(root));
      const { sha } = fixture;
      const restoreGit = useFastGit(scratch, roots[30], sha);
      try {
        const report = `Commit ${sha}.`;
        const probe = await probeForRoot(cardRoot).prepare!([report], { homeDirectory: scratch, knownRoots: roots });
        const codes = checkReport(report, probe).map((finding) => finding.code);
        expect(probe.shaExists(sha), JSON.stringify({ searched: probe.shaSearchLocations?.(sha), unverifiable: probe.shaSearchUnverifiableLocations?.(sha) })).toBe(true);
        expect(probe.shaSearchUnverifiableLocations?.(sha), JSON.stringify({ searched: probe.shaSearchLocations?.(sha), unverifiable: probe.shaSearchUnverifiableLocations?.(sha) })).toEqual([]);
        expect(codes).not.toContain("sha-missing");
        expect(codes).not.toContain("sha-unverifiable");
      } finally {
        restoreGit();
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test.serial("oltre 48 repo Git, uno SHA inventato resta mancante", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "delivery-sha-missing-cap-"));
    const cardRoot = join(scratch, "card");
    initializeGitMarkerRoot(cardRoot);
    writeIndependentFixture(cardRoot, "card.txt");
    try {
      const { roots: rawRoots } = createIndependentOverflowRoots(scratch, 49, 48, "unused-target");
      const roots = rawRoots.map((root) => realpathSync(root));
      const restoreGit = useFastGit(scratch);
      try {
        const report = "Fatto (commit 0000000deadbee1).";
        const probe = await probeForRoot(cardRoot).prepare!([report], { homeDirectory: scratch, knownRoots: roots });
        const codes = checkReport(report, probe).map((finding) => finding.code);
        expect(probe.shaExists("0000000deadbee1")).toBe(false);
        expect(codes).toContain("sha-missing");
        expect(codes).not.toContain("sha-unverifiable");
      } finally {
        restoreGit();
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test.serial("il nome del repo porta in priorita' il cinquantaduesimo repo citato", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "delivery-sha-name-"));
    const cardRoot = join(scratch, "card");
    initializeGitMarkerRoot(cardRoot);
    writeIndependentFixture(cardRoot, "card.txt");
    try {
      const repoName = "openclaw-delegate-router";
      const fixture = createIndependentOverflowRoots(scratch, 52, 51, repoName);
      const roots = fixture.roots.map((root) => realpathSync(root));
      const { sha } = fixture;
      const restoreGit = useFastGit(scratch, roots[51], sha);
      try {
        const report = `Commit ${sha} del repo ${repoName}.`;
        const probe = await probeForRoot(cardRoot).prepare!([report], { homeDirectory: scratch, knownRoots: roots });
        expect(probe.shaExists(sha)).toBe(true);
        expect(probe.shaSearchLocations?.(sha)).toContain(`~/${repoName}`);
      } finally {
        restoreGit();
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test.serial("un percorso esplicito a una radice non Git resta non verificabile", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "delivery-sha-path-nongit-"));
    const cardRoot = join(scratch, "card");
    const plainRoot = join(scratch, "Songs");
    initializeGitMarkerRoot(cardRoot);
    writeIndependentFixture(cardRoot, "card.txt");
    mkdirSync(plainRoot, { recursive: true });
    try {
      const restoreGit = useFastGit(scratch);
      try {
        const report = `Commit 0000000deadbee1 in ${join(plainRoot, "src", "proof.ts")}.`;
        const probe = await probeForRoot(cardRoot).prepare!([report], { homeDirectory: scratch, knownRoots: [plainRoot] });
        const codes = checkReport(report, probe).map((finding) => finding.code);
        expect(codes).toContain("sha-unverifiable");
        expect(codes).not.toContain("sha-missing");
      } finally {
        restoreGit();
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("delivery SHA claims span the repositories named by the reports", () => {
  let home: string;
  let roots: Record<"card" | "jarvis" | "openclaw" | "topics" | "delegate", string>;
  let commitByReportedSha: Map<string, string>;

  function gitInRepo(root: string, ...args: string[]): string {
    return execFileSync("git", args, { env: gitEnv(), cwd: root, encoding: "utf8" }).trim();
  }

  function initializeRepo(root: string): void {
    mkdirSync(root, { recursive: true });
    gitInRepo(root, "init", "-b", "main");
    gitInRepo(root, "config", "user.name", "Synthetic fixture");
    gitInRepo(root, "config", "user.email", "synthetic@example.invalid");
  }

  function commitFixture(root: string, file: string): string {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "fixture commit\n");
    gitInRepo(root, "add", "-A");
    gitInRepo(root, "commit", "-m", `fixture ${file}`);
    return gitInRepo(root, "rev-parse", "HEAD");
  }

  const mapReportedShas = (report: string): string => {
    const alternatives = [...commitByReportedSha.keys()].sort((a, b) => b.length - a.length).join("|");
    return report.replace(new RegExp(`\\b(${alternatives})\\b`, "g"), (sha) => commitByReportedSha.get(sha)!);
  };

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "delivery-multi-repo-"));
    roots = {
      card: join(home, "Projects", "card-worktree"),
      jarvis: join(home, ".claude", "jarvis"),
      openclaw: join(home, ".openclaw"),
      topics: join(home, "Projects", "topics-app"),
      delegate: join(home, "Projects", "openclaw-delegate-router"),
    };
    for (const root of Object.values(roots)) initializeRepo(root);
    commitFixture(roots.card, "proof.txt");
    const sourceBySha: Record<string, keyof typeof roots> = {
      "7b4778a": "jarvis",
      "67a943e": "jarvis",
      "47818b0": "jarvis",
      "24fbf86": "jarvis",
      "a100b56": "openclaw",
      "1910b03": "openclaw",
      "22e8b05": "openclaw",
      "04d125e1b6": "topics",
      "5952c74": "delegate",
    };
    const commitByRepo = new Map(
      [...new Set(Object.values(sourceBySha))].map((repo) => [repo, commitFixture(roots[repo], "claims/proof.txt")]),
    );
    commitByReportedSha = new Map(Object.entries(sourceBySha).map(([sha, repo]) => [sha, commitByRepo.get(repo)!]));
    expect(commitByReportedSha.size).toBe(9);
  });

  afterAll(() => rmSync(home, { recursive: true, force: true }));

  let isolatedCardIndex = 0;
  function freshCardRoot(): string {
    const root = join(home, `isolated-card-${isolatedCardIndex++}`);
    initializeRepo(root);
    commitFixture(root, "card.txt");
    return root;
  }

  test.serial("the seven privacy-safe excerpts resolve their distinct synthetic commit claims", async () => {
    expect(DELIVERY_REPORT_FIXTURE).toHaveLength(7);
    const rawShaOccurrences = DELIVERY_REPORT_FIXTURE
      .flatMap((card) => card.reports)
      .flatMap((report) => report.match(/\b[0-9a-f]{7,40}\b/gi) ?? []);
    expect(rawShaOccurrences).toHaveLength(12);
    let prepareCalls = 0;
    let shaClaimsSeen = 0;
    let findings: ReturnType<typeof checkReport>[] = [];
    const prepareCard = (reports: readonly string[]) => {
      prepareCalls++;
      return probeForRoot(freshCardRoot()).prepare!(reports, {
        homeDirectory: home,
        knownRoots: Object.values(roots),
      });
    };
    for (const card of DELIVERY_REPORT_FIXTURE) {
      const reports = card.reports.map(mapReportedShas);
      const shaClaims = reports.flatMap((report) => extractClaims(report).filter((claim) => claim.kind === "sha"));
      shaClaimsSeen += shaClaims.length;
      const probe = await prepareCard(reports);
      for (const claim of shaClaims) {
        expect(probe.shaExists(claim.value), `commit ${claim.value} was not resolved for ${card.title}; searched=${JSON.stringify(probe.shaSearchLocations?.(claim.value))}; unverifiable=${JSON.stringify(probe.shaSearchUnverifiableLocations?.(claim.value))}`).toBe(true);
        expect(probe.shaSearchLocations?.(claim.value)?.length).toBeGreaterThan(0);
      }
      findings = [...findings, ...reports.map((report) => checkReport(report, probe))];
    }
    expect(prepareCalls).toBe(7);
    expect(shaClaimsSeen).toBe(7);
    expect(findings.flat().filter((finding) => finding.code === "sha-missing")).toEqual([]);

    const serialized = JSON.stringify(DELIVERY_REPORT_FIXTURE);
    expect(serialized).not.toContain("@");
    expect(serialized).not.toMatch(/\b(?:Attilio|Anna)\b/i);
  });

  test.serial("i nomi di cartelle non Git non rendono incerto uno SHA", async () => {
    const nonGitNames = ["attilio", "Songs", "edm-contratto", "foto-reference", "odoo-local", "voice-booking-agent"];
    const nonGitRoots = nonGitNames.map((name) => join(home, "Projects", name));
    for (const root of nonGitRoots) mkdirSync(root, { recursive: true });
    const realSha = commitFixture(roots.delegate, "n1-proof.txt");

    for (let index = 0; index < nonGitNames.length; index++) {
      const name = nonGitNames[index]!;
      const context = { homeDirectory: home, knownRoots: [...nonGitRoots, roots.delegate] };
      const realReport = `Fatto per ${name} (commit ${realSha}).`;
      const realProbe = await probeForRoot(freshCardRoot()).prepare!([realReport], context);
      const realCodes = checkReport(realReport, realProbe).map((finding) => finding.code);
      expect(realCodes, JSON.stringify({ name, searched: realProbe.shaSearchLocations?.(realSha), unverifiable: realProbe.shaSearchUnverifiableLocations?.(realSha) })).not.toContain("sha-unverifiable");
      expect(realCodes).not.toContain("sha-missing");

      const inventedReport = `Fatto per ${name} (commit 0000000deadbee1).`;
      const inventedProbe = await probeForRoot(freshCardRoot()).prepare!([inventedReport], context);
      const inventedCodes = checkReport(inventedReport, inventedProbe).map((finding) => finding.code);
      expect(inventedCodes).toContain("sha-missing");
      expect(inventedCodes).not.toContain("sha-unverifiable");
    }
  });

  test.serial("cinquanta percorsi e menzioni non repo non disarmano lo SHA", async () => {
    const directories = Array.from({ length: 50 }, (_, index) => join(home, "paths", `p-${index}`));
    for (const directory of directories) mkdirSync(directory, { recursive: true });
    const mentions = [...directories.map((directory) => join(directory, "missing.ts")), join(roots.card, ".git", "hooks", "pre-push")];
    if (existsSync("/private/var/root")) mentions.push("/private/var/root");
    const report = `Fatto (commit 0000000deadbee1). ${mentions.join(" ")}`;
    const probe = await probeForRoot(freshCardRoot()).prepare!([report], { homeDirectory: home, knownRoots: Object.values(roots) });
    const codes = checkReport(report, probe).map((finding) => finding.code);
    expect(codes).toContain("sha-missing");
    expect(codes).not.toContain("sha-unverifiable");
  });

  test.serial("oltre 64 repo citati l'omissione e' esplicita e non spegne gli altri SHA", async () => {
    const citedRoots = Array.from({ length: 70 }, (_, index) => join(home, "overflow", `repo-${index}`));
    for (const root of citedRoots) mkdirSync(join(root, ".git"), { recursive: true });
    const omittedSha = "0000000deadbee1";
    const unrelatedSha = "0000000deadbee2";
    const reports = [
      `Commit ${omittedSha}. Repo citati: ${citedRoots.map((root) => join(root, ".git", "hooks", "pre-commit")).join(" ")}`,
      `Commit ${unrelatedSha}.`,
    ];
    const probe = await probeForRoot(freshCardRoot()).prepare!(reports, { homeDirectory: home });
    const omittedCodes = checkReport(reports[0]!, probe).map((finding) => finding.code);
    const unrelatedCodes = checkReport(reports[1]!, probe).map((finding) => finding.code);

    expect(omittedCodes).toContain("sha-unverifiable");
    expect(omittedCodes).not.toContain("sha-missing");
    expect(probe.shaSearchUnverifiableLocations?.(omittedSha)?.length).toBeGreaterThan(0);
    expect(unrelatedCodes).toContain("sha-missing");
  });

  test.serial("il repo citato resta prioritario oltre 48 altri candidati", async () => {
    const directories = Array.from({ length: 50 }, (_, index) => join(home, "many-paths", `p-${index}`));
    for (const directory of directories) mkdirSync(directory, { recursive: true });
    const citedRoot = join(home, "cited-after-many-paths");
    initializeRepo(citedRoot);
    const sha = commitFixture(citedRoot, "proof.txt");
    const paths = [...directories.map((directory) => join(directory, "missing.ts")), join(citedRoot, "proof.txt")];
    const report = `Commit ${sha} in ${paths.join(" ")}.`;
    const probe = await probeForRoot(freshCardRoot()).prepare!([report], { homeDirectory: home });
    expect(probe.shaExists(sha)).toBe(true);
    expect(probe.shaSearchUnverifiableLocations?.(sha)).toEqual([]);
  });

  test.serial("a home-relative report path discovers its synthetic repository", async () => {
    const root = join(home, "tools", "usage-hub");
    initializeRepo(root);
    const sha = commitFixture(root, "src/queue.mjs");
    const report = `Test aggiornato (commit ${sha}) in tools/usage-hub/src/queue.mjs.`;
    const probe = await probeForRoot(freshCardRoot()).prepare!([report], { homeDirectory: home });
    expect(probe.shaExists(sha)).toBe(true);
    expect(probe.shaSearchLocations?.(sha)).toContain("~/tools/usage-hub");
  });

  test.serial("an absolute report path outside the home discovers its synthetic repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "delivery-absolute-only-"));
    initializeRepo(root);
    try {
      const sha = commitFixture(root, "proof.txt");
      const report = `Test aggiornato (commit ${sha}) in ${join(root, "proof.txt")}.`;
      const probe = await probeForRoot(freshCardRoot()).prepare!([report], { homeDirectory: home });
      expect(probe.shaExists(sha)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.serial("a nested registered repository is searched separately from its parent", async () => {
    const parent = join(home, "Projects", "nested-parent");
    const nested = join(parent, "nested-project");
    initializeRepo(parent);
    initializeRepo(nested);
    const sha = commitFixture(nested, "proof.txt");
    const report = `Commit ${sha} in ${join(parent, "README.md")}.`;
    const probe = await probeForRoot(freshCardRoot()).prepare!([report], {
      homeDirectory: home,
      knownRoots: [nested],
    });
    expect(probe.shaExists(sha)).toBe(true);
  });

  test.serial("a repo nested under a known root is found from its reported path", async () => {
    const parent = join(home, ".claude", "jarvis");
    const nested = join(parent, "private");
    initializeRepo(parent);
    initializeRepo(nested);
    const sha = commitFixture(nested, "proof.txt");
    const report = `Commit ${sha} (jarvis/private).`;
    const probe = await probeForRoot(freshCardRoot()).prepare!([report], {
      homeDirectory: home,
      knownRoots: [parent],
    });

    expect(probe.shaExists(sha)).toBe(true);
    expect(probe.shaSearchLocations?.(sha)).toContain(`~/${relative(home, nested)}`);
  });

  test.serial("an absolute path through a known root discovers its nested repository", async () => {
    const parent = join(home, "absolute", ".claude", "jarvis");
    const nested = join(parent, "private");
    initializeRepo(parent);
    initializeRepo(nested);
    const sha = commitFixture(nested, "proof.txt");
    const report = `Commit ${sha} in ${join(nested, "proof.txt")}.`;
    const probe = await probeForRoot(freshCardRoot()).prepare!([report], {
      homeDirectory: home,
      knownRoots: [parent],
    });

    expect(probe.shaExists(sha)).toBe(true);
    expect(probe.shaSearchLocations?.(sha)).toContain(`~/${relative(home, nested)}`);
  });

  test.serial("run, cron, card and task identifiers are ignored, while explicit commit and sha claims stay", () => {
    const shas = (report: string) => extractClaims(report).filter((claim) => claim.kind === "sha").map((claim) => (claim as { value: string }).value);
    expect(shas("run 5b137a57; cron 4295465f; card 1234abc; task 04d125e1b6; id=5952c74")).toEqual([]);
    expect(shas("run commit 5b137a57; sha 4295465f; commit 04d125e1b6")).toEqual([
      "5b137a57",
      "4295465f",
      "04d125e1b6",
    ]);
  });

  test.serial("an invented sha is still accused and the finding names every repository searched", async () => {
    const sha = "0000000deadbee1";
    const report = `Fatto (commit ${sha}).`;
    const cardRoot = freshCardRoot();
    const probe = await probeForRoot(cardRoot).prepare!([report], {
      homeDirectory: home,
      knownRoots: [roots.jarvis, roots.openclaw, roots.topics, roots.delegate],
    });
    const finding = checkReport(report, probe).find((item) => item.code === "sha-missing");
    expect(finding).toBeDefined();
    expect(finding?.detail).toContain(`~/${relative(home, cardRoot)}`);
    expect(finding?.detail).toContain("~/.claude/jarvis");
    expect(finding?.detail).toContain("~/.openclaw");
    expect(finding?.detail).toContain("~/Projects/topics-app");
    expect(finding?.detail).toContain("~/Projects/openclaw-delegate-router");
  });
});
