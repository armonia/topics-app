/**
 * D20, visual proof: `check-design-system --base` (spec-flow 0.8.0) wants one
 * `visual-proof.json` entry per touched `.tsx`, with an image at each of
 * 375/768/1440/3440 px and a non-empty `reference`. Nothing wrote that file
 * yet, which is why the PR step still runs the `--changed ""` placeholder (see
 * `.github/workflows/ci.yml`). This module is the writer: it runs at delivery,
 * off the SAME review preview the card's thumbnail already captures, so no
 * agent ever authors the proof by hand.
 *
 * Format read from `node_modules/@armonia-io/spec-flow/dist/check-design-system.mjs`:
 * an array of `{ component, widths: { "375": file, ... }, reference }`, matched
 * by `component` === the touched file's repo-relative path, images resolved
 * relative to the `visual-proof.json` that holds them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export const PROOF_WIDTHS = [375, 768, 1440, 3440] as const;

interface DesignSystemConfig {
  uiRoots?: string[];
  uiExtensions?: string[];
  exclude?: string[];
  designFile?: string;
}

interface ProofEntry {
  component: string;
  widths: Record<string, string>;
  reference: string;
}

export interface VisualProofDeps {
  /** `git diff --name-only <baseRef>...HEAD` in `cwd`. Injected so tests never touch git. */
  diffNames(cwd: string, baseRef: string): string[];
  /** Same contract as `PreviewBrowser.screenshot`. */
  screenshot(url: string, outPath: string, opts: { width: number }): Promise<boolean>;
  log?(msg: string, err?: unknown): void;
}

function readConfig(cwd: string): DesignSystemConfig | null {
  try {
    const raw = JSON.parse(readFileSync(join(cwd, "spec-flow.completeness.json"), "utf8")) as { designSystem?: DesignSystemConfig };
    return raw.designSystem && typeof raw.designSystem === "object" ? raw.designSystem : null;
  } catch {
    return null;
  }
}

function touchedUiFiles(touched: string[], cfg: DesignSystemConfig): string[] {
  const exts = cfg.uiExtensions ?? [".tsx"];
  const roots = cfg.uiRoots ?? [];
  const exclude = (cfg.exclude ?? []).map((pattern) => new RegExp(pattern));
  return touched.filter((f) =>
    exts.some((ext) => f.endsWith(ext))
    && roots.some((root) => f === root || f.startsWith(`${root.replace(/\/$/, "")}/`))
    && !exclude.some((re) => re.test(f)));
}

/**
 * Where the proof lives: inside the `openspec/changes/<name>/` the same PR
 * already touches, when there is one — that is the home D20 expects. A card
 * with no openspec proposal (most of them: see CLAUDE.md on `openspec/`
 * being for larger changes) still needs a proof, so it falls back to a
 * generic, consumer-wide folder named after its own branch — never a
 * person's path, never hand-picked.
 */
function proofDirFor(touched: string[], branchSlug: string): string {
  const inChange = touched.find((f) => /^openspec\/changes\/[^/]+\//.test(f));
  const match = inChange?.match(/^(openspec\/changes\/[^/]+)\//);
  return match ? match[1]! : `openspec/changes/_visual-proof-auto/${branchSlug}`;
}

export function gitDiffNames(cwd: string, baseRef: string): string[] {
  try {
    return execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], { cwd, encoding: "utf8" })
      .split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Captures the four widths off `url` (best-effort, abandons the round rather
 * than write a half proof) and writes/updates the entries for every touched
 * `.tsx` under the consumer's declared UI roots. No-op, returns null, when
 * D20 isn't configured for this consumer or nothing UI was touched.
 */
export async function writeVisualProof(
  deps: VisualProofDeps,
  args: { cwd: string; baseRef: string; url: string; branchName: string | null },
): Promise<{ dir: string; written: string[] } | null> {
  const cfg = readConfig(args.cwd);
  if (!cfg) return null;

  const touched = deps.diffNames(args.cwd, args.baseRef);
  const uiFiles = touchedUiFiles(touched, cfg);
  if (!uiFiles.length) return null;

  const branchSlug = (args.branchName ?? "worktree").replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "") || "worktree";
  const dirRel = proofDirFor(touched, branchSlug);
  const dirAbs = join(args.cwd, dirRel);
  try {
    mkdirSync(dirAbs, { recursive: true });
  } catch (err) {
    deps.log?.(`[visual-proof] mkdir ${dirRel} failed`, err);
    return null;
  }

  // One shared capture of the review preview for all four widths: it is the
  // same SPA page for every touched component, so there is nothing
  // per-component to photograph differently — capturing N times per file
  // would just repeat the same pixels.
  const widths: Record<string, string> = {};
  for (const width of PROOF_WIDTHS) {
    const name = `review-${width}.png`;
    // eslint-disable-next-line no-await-in-loop -- one browser, sequential by design (see preview-browser.ts)
    const ok = await deps.screenshot(args.url, join(dirAbs, name), { width });
    if (!ok) {
      deps.log?.(`[visual-proof] screenshot at ${width}px failed: abandoning this round rather than write a half proof`);
      return null;
    }
    widths[String(width)] = name;
  }

  const proofPath = join(dirAbs, "visual-proof.json");
  let entries: ProofEntry[] = [];
  if (existsSync(proofPath)) {
    try {
      const parsed = JSON.parse(readFileSync(proofPath, "utf8"));
      if (Array.isArray(parsed)) entries = parsed;
    } catch (err) {
      deps.log?.(`[visual-proof] ${proofPath} unreadable, starting fresh`, err);
    }
  }
  const reference = cfg.designFile ?? "DESIGN.md";
  const kept = entries.filter((e) => !uiFiles.includes(e.component));
  const fresh: ProofEntry[] = uiFiles.map((component) => ({ component, widths, reference }));
  writeFileSync(proofPath, `${JSON.stringify([...kept, ...fresh], null, 2)}\n`);

  return { dir: dirRel, written: uiFiles };
}
