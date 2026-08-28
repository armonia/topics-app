/**
 * THE HEARTBEAT THAT SAYS "I AM WAITING ON PURPOSE".
 *
 * Half of this mechanism lives in `scripts/start-prod.sh`, and it has to: the
 * script gives the server its own cap plus a minute and then sends SIGTERM, so
 * a server deferring a restart to protect a turn would be killed exactly while
 * protecting it. That is the same death as before with a politer log line.
 *
 * A heartbeat and not a flag, because the script must tell "waiting right now"
 * apart from "died while waiting and left the file behind". The file carries
 * the instant of the last loop; the reader looks at how old it is. The
 * staleness threshold is written in the script, which cannot import this
 * module: 30 seconds, against a loop that touches the file twice a second.
 *
 * Writing can only fail when the Topics home is not writable, and in that case
 * the deferral degrades into the old behaviour instead of blowing up the
 * restart. A gate must never be able to break the thing it protects.
 */

import { writeFileSync, rmSync } from "fs";
import { join } from "path";
import { topicsHome } from "../services/daemon-state";

export const RELOAD_DEFERRED_FILE = "reload-deferred";

/** Publish that this loop is still deliberately deferring the restart. */
export function touchReloadDeferred(): void {
  try {
    writeFileSync(join(topicsHome(), RELOAD_DEFERRED_FILE), String(Date.now()));
  } catch { /* home not writable: fall back to the previous behaviour */ }
}

/** The wait is over, one way or another: stop holding the script back. */
export function clearReloadDeferred(): void {
  try { rmSync(join(topicsHome(), RELOAD_DEFERRED_FILE), { force: true }); } catch { /* already gone */ }
}
