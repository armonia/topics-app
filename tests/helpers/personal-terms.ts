/**
 * The shared rule for which declared terms count as personal data.
 *
 * WHY A PLAIN MODULE. `filterTerms` used to live inside
 * `tests/unit/no-personal-data-tracked.test.ts`, and importing it from there
 * REGISTERED that file's tests as a side effect: every importer re-ran its
 * whole tracked-tree scan (about 3 redundant scans per run of
 * `scripts/check-security.test.ts`). A test file is not a library; this one is.
 */

const ACCOUNT_OF_SERVICE = new Set([
  "runner", "ubuntu", "root", "admin", "build", "builder", "jenkins",
  "circleci", "travis", "vsts", "vagrant", "docker", "codespace", "gitpod",
  "github-actions", "actions", "nobody", "user", "test",
]);

/** Lowercase, dedup, length threshold and service accounts: the rule in one place. */
export function filterTerms(raw: string[]): string[] {
  return [...new Set(raw.map((t) => t.trim().toLowerCase()))]
    .filter((t) => t.length >= 4 && !ACCOUNT_OF_SERVICE.has(t));
}
