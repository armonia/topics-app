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
 *   1. RATIO: the bytes of EVERY folder beside the database (agents, media,
 *      workspace and backups included: the card measures the whole data
 *      folder) must stay within `TOPICS_DISK_RATIO_CAP` times the database's
 *      own size (default 3). A ratio scales with usage, so it stays meaningful
 *      whether the database is 10 MB or 10 GB.
 *   2. PER-FOLDER CAP: an individual folder can be capped in bytes with
 *      `TOPICS_DISK_CAP_<NAME>`, `<NAME>` being the folder's name uppercased
 *      with every non-alphanumeric character turned into `_` (e.g.
 *      `chromium-sidecar` becomes `TOPICS_DISK_CAP_CHROMIUM_SIDECAR`). The
 *      folders that grew without a ceiling have a DEFAULT cap
 *      (`DEFAULT_FOLDER_CAPS`); the variable overrides it, and `0` is a real
 *      cap of zero bytes.
 *
 * GROWTH: the caller may pass the previous measurement of each folder; the
 * result then carries bytes per day, so a folder climbing toward its cap shows
 * up before it crosses it.
 *
 * ZERO PERSONAL PATHS: this module never sees a path, only folder names and
 * byte counts the caller already measured.
 */

export interface DiskBudgetFolder {
  /** The folder's own name (e.g. `logs`, `chromium-sidecar`), not a path. */
  name: string;
  bytes: number;
}

/** A past measurement of a folder, used to compute growth per day. */
export interface DiskBudgetSample {
  /** Epoch milliseconds of the measurement. */
  at: number;
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
  /** Bytes per day since the previous sample, or null with no usable sample. */
  growthPerDay: number | null;
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

const GIB = 1024 ** 3;

/**
 * Default ceilings for the folders that grew unbounded (2026-11-19 audit).
 * Generic sizes, not tied to any one machine; an operator moves them with
 * `TOPICS_DISK_CAP_<NAME>`.
 */
const DEFAULT_FOLDER_CAPS: Readonly<Record<string, number>> = {
  agents: 10 * GIB,
  media: 5 * GIB,
  backups: 2 * GIB,
  "db-backups": 2 * GIB,
};

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
    const rawText = env[`TOPICS_DISK_CAP_${envSuffix(name)}`];
    const raw = rawText === undefined || rawText === "" ? Number.NaN : Number(rawText);
    if (Number.isFinite(raw) && raw >= 0) folderCaps[name] = raw;
    else if (DEFAULT_FOLDER_CAPS[name] !== undefined) folderCaps[name] = DEFAULT_FOLDER_CAPS[name];
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
  previous: Readonly<Record<string, DiskBudgetSample>> = {},
  now: number = Date.now(),
): DiskBudgetResult {
  const outsideBytes = folders.reduce((sum, f) => sum + f.bytes, 0);
  const ratio = dbBytes > 0 ? outsideBytes / dbBytes : 0;
  const ratioOverCap = dbBytes > 0 && ratio > config.ratioCap;
  const folderVerdicts: DiskBudgetFolderVerdict[] = folders.map((f) => {
    const capBytes = config.folderCaps[f.name] ?? null;
    const prev = previous[f.name];
    const days = prev ? (now - prev.at) / 86_400_000 : 0;
    const growthPerDay = prev && days >= 1 / 24 ? (f.bytes - prev.bytes) / days : null;
    return { ...f, capBytes, overCap: capBytes !== null && f.bytes > capBytes, growthPerDay };
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
