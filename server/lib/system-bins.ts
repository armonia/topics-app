/**
 * System tools by their full path. macOS keeps some of them in /usr/sbin, and
 * launchd and the app start the server with no /usr/sbin in its PATH: called by
 * name they work from a terminal and fail in production, silently. Measured on
 * 16/10/2026: the bridge panel, the folder of every Terminal tab and the owner
 * check on the browser's debugging port all got no answer from `lsof`.
 *
 * Only `node:fs` here: the browser sidecar keeps `child_process` out of its
 * module level, and imports this.
 */
import { existsSync } from "node:fs";

export const LSOF = Bun.which("lsof") ?? (existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof");
