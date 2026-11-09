/**
 * The SCREEN scope: what a device paired as a screen may reach.
 *
 * The PC's monitor shows the load screen (`/schermo/<id>`) from a browser that
 * stays logged in for as long as the PC is on. That browser holds a cookie, and
 * a PC is where no secret should sit: if the cookie were an owner's, anyone at
 * the PC would be the owner of the Mac's Topics, terminals included.
 *
 * So the owner pairs it as a screen, explicitly, and the gate lets that device
 * read exactly two things, both the data the page draws: the machine's readout
 * and the live sessions' consumption. No chat, no task, no socket, no write.
 * An allowlist of two routes and one verb, not a list of forbidden ones over a
 * permissive default (`isGuestAllowedPath` makes the same argument for a
 * guest). A new route is shut to a screen until somebody names it here.
 */

/** The page's slow data: the machine's processes, its sleep countdown, the hub's gauges (`routes/screen.ts`). */
export const SCREEN_DATA_PATH = "/api/system/screen-data";
/** The page's live data: the sessions and what each costs, read every few seconds (`routes/screen.ts`). */
export const SCREEN_SESSIONS_PATH = "/api/system/screen-sessions";

const ALLOWED = new Set([SCREEN_DATA_PATH, SCREEN_SESSIONS_PATH]);

export function isScreenAllowedRequest(pathname: string, method: string): boolean {
  const m = method.toUpperCase();
  return (m === "GET" || m === "HEAD") && ALLOWED.has(pathname);
}
