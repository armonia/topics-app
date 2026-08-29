/**
 * shellGap - "the version you read is not the version the updater updates".
 *
 * The status-bar chip shows the CLIENT number, and it is right to: a client-only
 * hot deploy has to be readable the moment it lands (the note at the chip in
 * `SidebarStatusBar.tsx` records what happened when the shell number overwrote
 * it: a freshly delivered client read as the OLD number, so a landed deploy
 * looked like a no-op).
 *
 * What the chip never said is that the native shell - the thing the updater
 * actually replaces - is a DIFFERENT number. Measured on the machine that
 * builds the app: installed shell 2.2.179, bundle in `public/` 2.2.211, repo
 * `package.json` 2.2.214. The person reads 2.2.214, concludes they are current,
 * and the updater toast offering "a new version" reads as a bug in the toast.
 * The toast is right; the number beside it was the incomplete fact.
 *
 * So the chip keeps the client number AND names the shell one whenever the two
 * disagree. Same shape as `bundleDrift`: a comparison, no direction, and a
 * missing fact is not a divergence.
 */

export interface ShellGap {
  /** The client bundle version the chip shows. */
  client: string;
  /** The native shell binary version, the one an update replaces. */
  shell: string;
}

/**
 * Whether the native shell disagrees with the client, given both facts.
 *
 * `desktop` false means there is no shell at all (web / mobile browser): the
 * question does not exist there and a `false` answer is not a "no divergence",
 * it is "not applicable".
 */
export function shellGap(
  clientVersion: string | undefined,
  shellVersion: string | undefined,
  opts: { desktop?: boolean } = {},
): ShellGap | null {
  if (opts.desktop === false) return null;

  const client = (clientVersion ?? '').trim();
  const shell = (shellVersion ?? '').trim();

  // A missing fact is not a divergence. `0.0.0` is a shrug, not a version (see
  // the BAKED_VERSION note in server/routes/status.ts).
  if (!client || !shell) return null;
  if (client === '0.0.0' || shell === '0.0.0') return null;

  return client === shell ? null : { client, shell };
}

/**
 * The badge that rides next to the number, as plain text.
 *
 * Two facts, one badge, because the sidebar bottom bar has about 200px for
 * seven things and a second chip is what tipped it past the width last time.
 * They also belong together: on a dev install the shell is exactly the piece
 * that does NOT arrive on its own, so "dev" is the reason the second number is
 * old.
 *
 *   dev install, shell behind -> "dev . v2.2.179"
 *   shell behind only         -> "v2.2.179"
 *   dev install only          -> "dev"
 *
 * `hmrAge` is the "last code change" the Vite dev server tracks; it rides
 * inside the badge instead of costing a chip of its own, and only under the dev
 * server, where there is no packaged shell to disagree with.
 *
 * Returns null when there is nothing true to say, and the chip stays one number
 * wide - which is the normal case for an installed app.
 */
export function versionBadgeText(
  gap: ShellGap | null,
  devInstall: boolean,
  hmrAge?: string,
): string | null {
  const parts: string[] = [];
  if (devInstall) {
    parts.push('dev');
    if (hmrAge) parts.push(hmrAge);
  }
  if (gap) parts.push(`v${gap.shell}`);
  return parts.length ? parts.join(' \u00b7 ') : null;
}
