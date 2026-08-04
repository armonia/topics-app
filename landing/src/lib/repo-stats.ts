/**
 * The proof numbers on the home page, read from the repository at build time.
 *
 * Stars (0) and downloads (54) are the wrong proof for a project this young and
 * putting them on the page would be an own goal. What is true and checkable is
 * the rate of work: commits, how many landed this week, how many releases have
 * actually shipped. Anyone can verify all of it against the public repo, which
 * is the only kind of number worth printing.
 *
 * Computed with `git` rather than typed in, so the page cannot drift from the
 * repository the way a hand-written "2,668 commits" does the day after it is
 * written. FALLBACK is what a build without git history gets — a shallow clone,
 * a tarball, a CI checkout with `fetch-depth: 1`. It is deliberately stale-safe:
 * the numbers are last-known-good and the page says "as of" with the date they
 * were taken, so a stale build under-claims rather than lies.
 */
import { execFileSync } from 'node:child_process';

export interface RepoStats {
  commits: number;
  commitsLast7: number;
  /** ISO date of the first commit. */
  since: string;
  releases: number;
  version: string;
  /** True when the numbers came from git rather than from FALLBACK. */
  live: boolean;
}

/** Last measured 5 August 2026. Releases come from the GitHub API, not git. */
const FALLBACK: RepoStats = {
  commits: 2680,
  commitsLast7: 426,
  since: '2026-02-11',
  releases: 78,
  version: '2.2.11',
  live: false,
};

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: new URL('../../..', import.meta.url).pathname,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

let cached: RepoStats | null = null;

export function repoStats(): RepoStats {
  if (cached) return cached;
  try {
    const commits = Number(git(['rev-list', '--count', 'HEAD']));
    const commitsLast7 = Number(git(['rev-list', '--count', '--since=7 days ago', 'HEAD']));
    const since = git(['log', '--reverse', '--format=%as', '--max-parents=0']).split('\n')[0];
    // A shallow clone answers all three without erroring and answers them
    // wrong, so the result is only trusted when it looks like a full history.
    if (!Number.isFinite(commits) || commits < 100 || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      cached = FALLBACK;
      return cached;
    }
    cached = { ...FALLBACK, commits, commitsLast7, since, live: true };
  } catch {
    cached = FALLBACK;
  }
  return cached;
}

/** "11 February 2026" — the format the rest of the site dates things in. */
export function longDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
