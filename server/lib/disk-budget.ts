/**
 * PURE EVALUATION of the data folder against the live database: no fs, no
 * `du`, no `process.env` read at module scope — everything comes in as an
 * argument, so a test drives it with numbers that never touch a real disk.
 * `scripts/disk-budget-check.ts` is the impure half that measures the real
 * folders and feeds them here.
 *
 * THE PROBLEM THIS CATCHES: on 2026-11-19 `~/.topics` measured 15.3 GB
 * against a 0.76 GB live database — twenty times over, against a budget of
 * three. Nothing enforced a ceiling, so a folder could grow without anyone
 * noticing until the disk itself ran out.
 *
 * TWO INDEPENDENT CHECKS, both configurable by environment and both with a
 * default that works with no configuration at all:
 *
 *   1. RATIO — total bytes outside the database must stay within
 *      `TOPICS_DISK_RATIO_CAP` times the database's own size (default 3).
 *      A ratio scales with usage, so it stays meaningful whether the
 *      database is 10 MB or 10 GB.
 *   2. PER-FOLDER CAP — an individual folder (logs, a cache, a sidecar
 *      download) can be capped in bytes with `TOPICS_DISK_CAP_<NAME>`,
 *      `<NAME>` being the folder's name uppercased with every non-alphanumeric
 *      character turned into `_` (e.g. `chromium-sidecar` →
 *      `TOPICS_DISK_CAP_CHROMIUM_SIDECAR`). Unset means no cap for that folder:
 *      the ratio check still watches it as part of the total.
 *
 * ZERO PERSONAL PATHS: this module never sees a path, only folder names and
 * byte counts the caller already measured.
 */

export interface DiskBudgetFolder {
  /** The folder's own name (e.g. `logs`, `chromium-sidecar`), not a path. */
  name: string;
  bytes: number;
}

export interface DiskBudgetConfig {
  /** Total-outside-database / database-size must stay at or under this. */
  ratioCap: number;
  /** Folder name → byte cap, only for folders that have one configured. */
  folderCaps: Record<string, number>;
}

export interface DiskBudgetFolderVerdict extends DiskBudgetFolder {
  capBytes: number | null;
  overCap: boolean;
}

export interface DiskBudgetResult {
  dbBytes: number;
  outsideBytes: number;
  ratio: number;
  ratioCap: number;
  ratioOverCap: boolean;
  folders: DiskBudgetFolderVerdict[];
  /** True only when both the ratio and every folder cap are respected. */
  ok: boolean;
}

const DEFAULT_RATIO_CAP = 3;

/** `logs` → `LOGS`, `chromium-sidecar` → `CHROMIUM_SIDECAR`, `ui state` → `UI_STATE`. */
function envSuffix(folderName: string): string {
  return folderName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Reads the two env-configurable pieces of the budget. Never reads
 * `process.env` itself: the caller passes whichever map it wants, so a test
 * injects one and the real script passes `process.env`.
 */
export function diskBudgetConfig(
  env: NodeJS.ProcessEnv = process.env,
  folderNames: readonly string[] = [],
): DiskBudgetConfig {
  const rawRatio = Number(env.TOPICS_DISK_RATIO_CAP);
  const ratioCap = Number.isFinite(rawRatio) && rawRatio > 0 ? rawRatio : DEFAULT_RATIO_CAP;
  const folderCaps: Record<string, number> = {};
  for (const name of folderNames) {
    const raw = Number(env[`TOPICS_DISK_CAP_${envSuffix(name)}`]);
    if (Number.isFinite(raw) && raw >= 0) folderCaps[name] = raw;
  }
  return { ratioCap, folderCaps };
}

/**
 * The evaluation itself. `dbBytes` of zero is treated as "no database yet":
 * the ratio check is skipped (division by zero would otherwise read as an
 * infinite, always-red ratio on a brand-new install) and only the per-folder
 * caps apply.
 */
export function evaluateDiskBudget(
  dbBytes: number,
  folders: readonly DiskBudgetFolder[],
  config: DiskBudgetConfig,
): DiskBudgetResult {
  const outsideBytes = folders.reduce((sum, f) => sum + f.bytes, 0);
  const ratio = dbBytes > 0 ? outsideBytes / dbBytes : 0;
  const ratioOverCap = dbBytes > 0 && ratio > config.ratioCap;
  const folderVerdicts: DiskBudgetFolderVerdict[] = folders.map((f) => {
    const capBytes = config.folderCaps[f.name] ?? null;
    return { ...f, capBytes, overCap: capBytes !== null && f.bytes > capBytes };
  });
  const ok = !ratioOverCap && folderVerdicts.every((f) => !f.overCap);
  return {
    dbBytes,
    outsideBytes,
    ratio,
    ratioCap: config.ratioCap,
    ratioOverCap,
    folders: folderVerdicts,
    ok,
  };
}
