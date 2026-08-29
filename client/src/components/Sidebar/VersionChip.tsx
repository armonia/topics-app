/**
 * VersionChip - the number at the bottom right of the sidebar, and everything
 * it has to admit about itself.
 *
 * THREE NUMBERS LIVE ON A DEVELOPMENT MACHINE, all of them true at once: the
 * installed native shell (what the updater replaces), the client bundle in
 * `public/` (what the screen is running), and the repo `package.json` (what
 * `/api/version` reads). Measured: 2.2.179, 2.2.211, 2.2.214. The chip shows
 * the last one, so the person reads 2.2.214, believes they are current, and the
 * updater toast offering an update looks like a bug. It is not: the shell
 * really is thirty-five versions back.
 *
 * The chip KEEPS following the client, because that is the "the deploy landed"
 * signal it exists for. What changes is that it stops being the only fact on
 * screen: a badge beside it names the shell version when the two disagree, and
 * says "dev" when this is a development install, where the shell is precisely
 * the piece that does not arrive on its own.
 *
 * It lives in its own file so the divergence can be MOUNTED in a unit test.
 * `SidebarStatusBar` pulls in the perf metrics, the system status, the shell
 * bridge and a dozen stores: it does not mount, and "the number stopped saying
 * it" is a one-line change.
 */
import { useT } from '../../hooks/useT';
import { SIDEBAR_ACTIVE, SIDEBAR_HOVER } from '../../lib/selectionStyles';
import { PALLINO_ATTESA, SEGNALE_ATTESA } from './chromeSignals';
import { shellGap, versionBadgeText } from './shellGap';
import type { BundleDrift } from './bundleDrift';

export function VersionChip({
  appVersion,
  shellVersion,
  drift,
  devInstall,
  hmrAge,
  desktop,
  popoverOpen,
  onOpen,
}: {
  /** The client bundle version actually running (what a deploy moves). */
  appVersion: string;
  /** The native shell binary version, read through the shell bridge. */
  shellVersion?: string;
  /** Bundle in `public/` older than the repo (see bundleDrift.ts). */
  drift?: BundleDrift | null;
  /** The server hot-delivers the bundle (`topics-dev.json` / `devReload`). */
  devInstall?: boolean;
  /** "Last code change" under the Vite dev server, already formatted. */
  hmrAge?: string;
  /** False in a browser: there is no native shell to disagree with. */
  desktop?: boolean;
  popoverOpen?: boolean;
  onOpen: (anchor: HTMLButtonElement) => void;
}) {
  const tr = useT();
  const gap = shellGap(appVersion, shellVersion, { desktop });
  const badge = versionBadgeText(gap, !!devInstall, hmrAge);

  // The badge's tooltip carries the sentences the badge cannot hold. Both can
  // be true at the same time, so they stack rather than compete.
  const badgeTitle = [
    devInstall ? tr('statusBar.devInstallTitle') : null,
    hmrAge ? tr('statusBar.devBuildTitle') + tr('statusBar.lastCodeUpdateAgo', { t: hmrAge }) : null,
    gap ? tr('statusBar.shellGapTitle', { client: gap.client, shell: gap.shell }) : null,
  ].filter(Boolean).join('\n');

  if (!appVersion) return null;

  return (
    <>
      <button
        data-version-anchor
        onClick={(e) => onOpen(e.currentTarget)}
        className={`tap-expand-y text-app-text-muted hover:text-app-text-secondary ${SIDEBAR_HOVER} rounded px-1 py-1 -mx-0.5 transition-colors ${popoverOpen ? `${SIDEBAR_ACTIVE} text-app-text-secondary` : ''}`}
        title={drift
          ? tr('version.driftTitle', { bundle: drift.bundle, repo: drift.repo })
          : tr('statusBar.versionTitle')}
      >
        v{appVersion}
        {/* A stale bundle gets a mark, not a banner: the number is read
            many times a day and the drift is rare, so it costs one dot
            next to it and the full sentence in the popover, which is
            where a version question is already answered. */}
        {drift && (
          <span
            data-testid="version-drift-dot"
            className={`inline-block align-middle ml-1 w-1.5 h-1.5 rounded-full ${PALLINO_ATTESA}`}
          />
        )}
      </button>
      {/* ONE badge for the two facts, not two chips. The bottom bar has around
          200px for seven things, and splitting the dev state from the build age
          is what tipped it past the sidebar width the last time. */}
      {badge && (
        <span
          data-testid="version-install-badge"
          className={`px-1 rounded bg-amber-500/15 ${SEGNALE_ATTESA} font-medium text-[10px] leading-tight tabular-nums`}
          title={badgeTitle}
        >
          {badge}
        </span>
      )}
    </>
  );
}
