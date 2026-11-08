/**
 * Did the whole update land, or only the part that was not running?
 *
 * On Windows the NSIS installer cannot overwrite a file that is IN USE: it skips
 * it and still exits 0. On 2026-08-27, updating 2.2.173 to 2.2.176 with the app
 * open, `pty-bridge.exe` stayed at the previous build while the registry and
 * `app.exe` both reported the new version. The shell compares the fingerprint of
 * the binaries sitting beside it with the ones the build shipped
 * (desktop-tauri src/sidecar_integrity.rs); this module carries that verdict to
 * the UI. The only place that says "you are on 2.2.176" today is the version
 * popover, so that is where "but not all of it" belongs.
 *
 * Outside the native shell (web) there is nothing to verify: `null`.
 */
import { useEffect, useState } from 'react';
import { isTauri } from './shell/index';
import { tauriInvoke } from './shell/tauri';

export interface SidecarStatus {
  /** Sidecar base name, as declared in `bundle.externalBin`. */
  name: string;
  /** `ok` | `stale` (bytes of the previous build) | `missing`. */
  state: string;
}

export interface SidecarReport {
  /** False only when something is provably wrong. */
  ok: boolean;
  /** False when the build recorded no fingerprints: nothing is claimed. */
  checked: boolean;
  /** The sidecars that do not match, for the message. */
  bad: string[];
  items: SidecarStatus[];
}

/**
 * Ask the shell. `null` on web, and `null` when the command is not there either
 * (a shell older than the client, or a webview without that permission): a check
 * that cannot run is not a fault to display.
 */
async function fetchSidecarIntegrity(): Promise<SidecarReport | null> {
  if (!isTauri) return null;
  try {
    return await tauriInvoke<SidecarReport>('sidecar_integrity');
  } catch {
    return null;
  }
}

/**
 * The report, asked once on mount. The shell computes it once per launch and
 * caches it, so reopening the popover never re-reads hundreds of MB.
 */
export function useSidecarIntegrity(): SidecarReport | null {
  const [report, setReport] = useState<SidecarReport | null>(null);
  useEffect(() => {
    let alive = true;
    fetchSidecarIntegrity().then((r) => { if (alive) setReport(r); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return report;
}

/** Show the warning? Only a verdict that was actually checked, and is negative. */
export function shouldWarnAboutSidecars(report: SidecarReport | null): boolean {
  return !!report && report.checked && !report.ok && report.bad.length > 0;
}
