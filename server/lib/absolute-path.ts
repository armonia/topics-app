/**
 * Is this an absolute filesystem path on the machine that runs the server?
 *
 * The project routes used to ask `p.startsWith("/")`, which is the answer for
 * macOS and Linux only. On Windows every real folder starts with a drive letter
 * (`C:\Users\...`, `E:\repo`) or is a UNC share, so a Windows install refused
 * every project it was asked to register and could never hold one. Found on
 * 2026-10-26 while turning the Windows PC into a node, which needs exactly one
 * registered project per repository it runs cards for.
 *
 * `C:repo` (drive-relative) is not absolute and stays refused, as `path.win32`
 * says. The platform is a parameter so the Windows answer is testable anywhere.
 */
import { posix, win32 } from "node:path";

export function isAbsoluteServerPath(p: unknown, platform: NodeJS.Platform = process.platform): p is string {
  if (typeof p !== "string" || p.length === 0) return false;
  return platform === "win32" ? win32.isAbsolute(p) : posix.isAbsolute(p);
}
