/**
 * THE HALF OF A BROWSER THAT IS NOT IN THE TREE.
 *
 * A WebKit page does not run inside the process that opened it: WebContent, GPU
 * and Networking are XPC services started by launchd, so they carry ppid 1 and
 * no descendant walk will ever find them. On the T0 probe (CI, macOS, 16/09/2026)
 * ONE headless page with a WebGL loop weighed 0.057 GB of command tree against
 * 0.383 GB of those three services: measuring the tree alone understates it by
 * seven times, and STOPPING the tree alone left the page able to paint (the
 * frames only stopped because the driver stopped driving).
 *
 * WHERE THEY ARE FOUND. `launchctl print pid/<app pid>` lists the services of an
 * app's own launchd domain with their pids; the probe confirmed the three
 * Playwright ones appear there. The listing also carries services that are NOT
 * the app's work (`ThemeWidgetControlViewService`, `SafariPlatformSupport.Helper`)
 * and stubs with pid 0.
 *
 * THE PATH GUARD IS THE POINT. A service is attributed only when its executable
 * lies under the install root of the app that owns the domain - for Playwright
 * `.../ms-playwright/webkit-<rev>/` - and never when it lives under `/System`.
 * Without it the system WebKit of Topics.app or of the user's Safari could be
 * attributed to an agent's tree and then SIGSTOPped, which is the browser of the
 * person sitting at the machine.
 */
import { captureWithDeadline } from "./bounded-capture";

/** One line of the `services = { ... }` block: `\t 2216 - com.apple.WebKit.WebContent.F3AD…`. */
export interface LaunchctlService {
  pid: number;
  label: string;
}

/** The services with a live pid. Stubs (pid 0) and everything outside the block are dropped. */
export function parseLaunchctlServices(text: string): LaunchctlService[] {
  const block = text.match(/\n\tservices = \{\n([\s\S]*?)\n\t\}/)?.[1] ?? "";
  const out: LaunchctlService[] = [];
  for (const line of block.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+\S+\s+(\S+)$/);
    if (!m || m[1] === "0") continue;
    out.push({ pid: +m[1]!, label: m[2]! });
  }
  return out;
}

/**
 * The install root an attributed service must live under: the directory that
 * holds the `.app` bundle. `/Users/x/Library/Caches/ms-playwright/webkit-2272/
 * Playwright.app/Contents/MacOS/Playwright` gives `…/webkit-2272/`, which is
 * exactly the private WebKit of that Playwright revision.
 */
export function installRootOf(appCommand: string): string | null {
  const argv0 = appCommand.trim().split(" ")[0] ?? "";
  const at = argv0.indexOf(".app/");
  if (at < 0) return null;
  const bundle = argv0.slice(0, at + ".app".length);
  const root = bundle.slice(0, bundle.lastIndexOf("/") + 1);
  return root.length > 1 ? root : null;
}

/** A service whose executable is not under the app's own install root is somebody else's. */
export function attributableServicePids(i: {
  services: readonly LaunchctlService[];
  /** argv of each service pid, from the same `ps` table the freeze reads. */
  commandOf: (pid: number) => string | undefined;
  installRoot: string;
}): number[] {
  const out: number[] = [];
  for (const s of i.services) {
    const cmd = i.commandOf(s.pid);
    if (!cmd) continue;
    const argv0 = cmd.trim().split(" ")[0] ?? "";
    if (argv0.startsWith("/System/")) continue;
    if (!argv0.startsWith(i.installRoot)) continue;
    out.push(s.pid);
  }
  return out;
}

export interface LaunchctlDeps {
  /** `launchctl print pid/<pid>`; empty string on any failure. */
  print: (pid: number) => Promise<string>;
  now?: () => number;
}

/** A pid domain is printed at most once a minute: the listing is stable and `launchctl` forks. */
const DOMAIN_TTL_MS = 60_000;

export interface XpcAttribution {
  servicePidsOf(appPid: number, appCommand: string, commandOf: (pid: number) => string | undefined): Promise<number[]>;
  _reset(): void;
}

export function createXpcAttribution(deps: LaunchctlDeps): XpcAttribution {
  const now = deps.now ?? Date.now;
  const cache = new Map<number, { at: number; services: LaunchctlService[] }>();
  return {
    async servicePidsOf(appPid, appCommand, commandOf) {
      const installRoot = installRootOf(appCommand);
      if (!installRoot) return [];
      let entry = cache.get(appPid);
      if (!entry || now() - entry.at > DOMAIN_TTL_MS) {
        const text = await deps.print(appPid).catch(() => "");
        entry = { at: now(), services: parseLaunchctlServices(text) };
        cache.set(appPid, entry);
      }
      return attributableServicePids({ services: entry.services, commandOf, installRoot });
    },
    _reset() { cache.clear(); },
  };
}

/**
 * `launchctl print pid/<pid>` with a DEADLINE on the answer, not just a signal at
 * it (`bounded-capture.ts`): under thrash a fork can hang, and this is awaited
 * inside the freezer's beat - the beat that holds the ten minute thaw cap.
 */
export async function printPidDomain(pid: number, timeoutMs = 2_000): Promise<string> {
  const capture = await captureWithDeadline(["/bin/launchctl", "print", `pid/${pid}`], timeoutMs);
  return capture !== null && capture.exitCode === 0 ? capture.text : "";
}

/** The argv of a process that looks like an `.app` executable, which is the only shape with a pid domain. */
export function looksLikeAppExecutable(command: string): boolean {
  return /\.app\/Contents\/MacOS\/[^/\s]+/.test(command.trim().split(" ")[0] ?? "");
}
