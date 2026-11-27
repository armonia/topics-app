import { existsSync, readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { BloatException } from "./bloat-exceptions";

export interface Baseline {
  $schema: string;
  _comment: string[];
  /** v1 only. v2 reads the date from git, see `recordedOn`. */
  updated?: string;
  tolerance_pct: number;
  max_lines: number;
  min_clone_lines: number;
  duplicated_lines: number;
  clone_groups: number;
  /** path -> line count, for every file over `max_lines` on the day recorded. */
  files: Record<string, number>;
  /**
   * path -> why its size was recorded. Free text, never read by the gate. On
   * disk it lives INSIDE the file's entry (`{ "lines": n, "why": [...] }`), not
   * in a map of its own: two branches writing their first note into an empty
   * map insert at the same spot, which is a conflict.
   */
  notes: Record<string, string[]>;
  /** Ceiling on offenders; only falls, except through a live exception. */
  max_over_files?: number;
  /** path -> written reason and expiry, see ./bloat-exceptions. */
  exceptions: Record<string, BloatException>;
}

/** A `files` entry on disk: the bare count, or the count with its reason. */
export type BaselineEntry = number | { lines: number; why: string[] };

export function loadBaseline(path: string): Baseline | null {
  if (!existsSync(path)) return null;
  try {
    return parseBaseline(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`[check-bloat] baseline unreadable at ${path} (${String(err)})`);
    process.exit(2);
  }
}

/** The baseline as committed on `ref`, or null when git or the ref is not there. */
export function loadBaselineAtRef(root: string, baselinePath: string, ref: string): Baseline | null {
  const rel = relative(root, baselinePath).split(sep).join("/");
  const r = spawnSync("git", ["-C", root, "show", `${ref}:${rel}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  try {
    return parseBaseline(r.stdout);
  } catch {
    return null;
  }
}

function parseBaseline(text: string): Baseline {
  {
    const raw = JSON.parse(text) as Omit<Baseline, "files" | "notes" | "exceptions"> & {
      exceptions?: Record<string, BloatException>;
      files: Record<string, BaselineEntry>;
    };
    const files: Record<string, number> = {};
    const notes: Record<string, string[]> = {};
    for (const [file, entry] of Object.entries(raw.files ?? {})) {
      if (typeof entry === "number") {
        files[file] = entry;
      } else {
        files[file] = entry.lines;
        notes[file] = entry.why;
      }
    }
    return { ...raw, files, notes, exceptions: raw.exceptions ?? {} };
  }
}
