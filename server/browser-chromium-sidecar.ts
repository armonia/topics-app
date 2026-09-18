/**
 * Chromium sidecar — on-demand engine for the "Chromium" browser-pane mode.
 *
 * The default browser pane is the lightweight native WKWebView (macOS) child.
 * That engine cannot run Chrome extensions (no WebExtensions runtime, no
 * request interception). When a pane is switched to the "chromium" engine we
 * instead drive a REAL Chromium-family browser the user already has installed
 * (Chrome / Edge / Brave / Chromium / Dia …) over the DevTools Protocol, load
 * their extensions into it, and mirror it into the pane. Nothing Chromium is
 * bundled in the installer — this is why the switch is free at rest.
 *
 * Lifecycle is ref-counted and on-demand: the browser process is spawned when
 * the first chromium pane acquires it and reaped a grace window after the last
 * one releases, so an app with no chromium pane open holds zero Chromium
 * processes. Launch and CDP connection are dependency-injected so the state
 * machine is unit-testable without a real browser.
 */

import { browserMarkArg, parseProcSnapshot, userDataDirOf } from "./lib/browser-orphan-sweep";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAppDataDir } from "./lib/data-dir";

/** Opaque timer handle — normalises the DOM/Node `setTimeout` return-type union. */
type TimerHandle = ReturnType<typeof setTimeout>;

/** A Chromium-family browser found on disk that can host WebExtensions. */
export interface ChromiumEngine {
  /** Stable id, e.g. "chrome", "edge", "brave", "chromium", "dia", "arc". */
  id: string;
  /** Human label for the engine picker. */
  name: string;
  /** Absolute path to the launchable executable. */
  executablePath: string;
}

/** Per-platform candidates: id/name + the executable paths to probe, in order. */
interface Candidate {
  id: string;
  name: string;
  paths: string[];
}

function macCandidates(): Candidate[] {
  const app = (name: string, bin: string) =>
    `/Applications/${name}.app/Contents/MacOS/${bin}`;
  const userApp = (name: string, bin: string) =>
    join(homedir(), `Applications/${name}.app/Contents/MacOS/${bin}`);
  const mk = (id: string, name: string, appName: string, bin: string): Candidate => ({
    id,
    name,
    paths: [app(appName, bin), userApp(appName, bin)],
  });
  return [
    mk("chrome", "Google Chrome", "Google Chrome", "Google Chrome"),
    mk("edge", "Microsoft Edge", "Microsoft Edge", "Microsoft Edge"),
    mk("brave", "Brave", "Brave Browser", "Brave Browser"),
    mk("dia", "Dia", "Dia", "Dia"),
    mk("arc", "Arc", "Arc", "Arc"),
    mk("vivaldi", "Vivaldi", "Vivaldi", "Vivaldi"),
    mk("chromium", "Chromium", "Chromium", "Chromium"),
  ];
}

function windowsCandidates(): Candidate[] {
  const pf = process.env["PROGRAMFILES"] || "C:\\Program Files";
  const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const local = process.env["LOCALAPPDATA"] || join(homedir(), "AppData", "Local");
  const mk = (id: string, name: string, ...rel: string[]): Candidate => ({
    id,
    name,
    paths: [join(pf, ...rel), join(pf86, ...rel), join(local, ...rel)],
  });
  return [
    mk("chrome", "Google Chrome", "Google", "Chrome", "Application", "chrome.exe"),
    mk("edge", "Microsoft Edge", "Microsoft", "Edge", "Application", "msedge.exe"),
    mk("brave", "Brave", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    mk("vivaldi", "Vivaldi", "Vivaldi", "Application", "vivaldi.exe"),
    mk("chromium", "Chromium", "Chromium", "Application", "chrome.exe"),
  ];
}

function linuxCandidates(): Candidate[] {
  const bins = (id: string, name: string, ...names: string[]): Candidate => ({
    id,
    name,
    paths: names.flatMap((n) => [`/usr/bin/${n}`, `/usr/local/bin/${n}`, `/snap/bin/${n}`]),
  });
  return [
    bins("chrome", "Google Chrome", "google-chrome", "google-chrome-stable"),
    bins("edge", "Microsoft Edge", "microsoft-edge", "microsoft-edge-stable"),
    bins("brave", "Brave", "brave-browser", "brave"),
    bins("vivaldi", "Vivaldi", "vivaldi", "vivaldi-stable"),
    bins("chromium", "Chromium", "chromium", "chromium-browser"),
  ];
}

function candidatesForPlatform(platform: NodeJS.Platform): Candidate[] {
  if (platform === "darwin") return macCandidates();
  if (platform === "win32") return windowsCandidates();
  return linuxCandidates();
}

/**
 * Discover installed Chromium-family browsers that can host extensions.
 * Pure except for the injected `exists` probe (defaults to fs) — the first
 * existing path per candidate wins, duplicates are dropped by executable path.
 */
export function discoverChromiumEngines(opts: {
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
} = {}): ChromiumEngine[] {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  const found: ChromiumEngine[] = [];
  const seen = new Set<string>();
  for (const c of candidatesForPlatform(platform)) {
    const hit = c.paths.find((p) => exists(p));
    if (hit && !seen.has(hit)) {
      seen.add(hit);
      found.push({ id: c.id, name: c.name, executablePath: hit });
    }
  }
  return found;
}

/** Pick the preferred engine: honour `preferId`, else first discovered. */
export function pickChromiumEngine(
  engines: ChromiumEngine[],
  preferId?: string,
): ChromiumEngine | null {
  if (engines.length === 0) return null;
  if (preferId) {
    const match = engines.find((e) => e.id === preferId);
    if (match) return match;
  }
  return engines[0]!;
}

/** A live Chromium process the sidecar owns, plus how to reach it over CDP. */
export interface SidecarHandle {
  /** ws:// DevTools endpoint (browser-level) for CDP / playwright connectOverCDP. */
  cdpEndpoint: string;
  /** Which engine backs this handle. */
  engine: ChromiumEngine;
}

/** How the sidecar starts a browser and finds its CDP endpoint. Injected for tests. */
export interface SidecarLauncher {
  /**
   * Spawn `engine` with remote debugging on `port` + `userDataDir`, loading the
   * given unpacked extension dirs, and resolve once the CDP endpoint is live.
   * Returns the endpoint + a kill handle.
   */
  launch(args: {
    engine: ChromiumEngine;
    port: number;
    userDataDir: string;
    loadExtensions: string[];
  }): Promise<{ cdpEndpoint: string; kill: () => void }>;
}

export interface ChromiumSidecarOptions {
  discover?: () => ChromiumEngine[];
  launcher?: SidecarLauncher;
  preferEngineId?: string;
  /** CDP remote-debugging port. Default 19333 (distinct from the agent 19222). */
  port?: number;
  userDataDir?: string;
  /** Unpacked extension dirs to load into the sidecar (the user's ported set).
   *  May be a thunk, evaluated at LAUNCH time (not construction) — so a costly
   *  on-disk discovery only runs when a chromium pane is actually opened. */
  loadExtensions?: string[] | (() => string[]);
  /** Delay before reaping the process after the last release. Default 8000ms. */
  idleGraceMs?: number;
  /** Injectable timers for deterministic tests. */
  setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (t: TimerHandle) => void;
}

/**
 * Ref-counted, single-flight, idle-reaped owner of one Chromium sidecar process.
 * `acquire()` guarantees a live handle; `release()` schedules teardown when the
 * count hits zero.
 */
export function createChromiumSidecar(opts: ChromiumSidecarOptions = {}) {
  const discover = opts.discover ?? (() => discoverChromiumEngines());
  const launcher = opts.launcher ?? defaultLauncher();
  const port = opts.port ?? 19333;
  // App data root, not a hardcoded `~/.openclaw`: on an install that never had
  // the legacy root this profile is the difference between Topics owning one
  // home and silently creating a second one (card 211605ee).
  const userDataDir =
    opts.userDataDir ?? join(resolveAppDataDir(), "chromium-sidecar");
  const loadExtensionsOpt = opts.loadExtensions ?? [];
  const resolveLoadExtensions = (): string[] =>
    typeof loadExtensionsOpt === "function" ? loadExtensionsOpt() : loadExtensionsOpt;
  const idleGraceMs = opts.idleGraceMs ?? 8000;
  const setTimeoutFn = (opts.setTimeoutFn ?? setTimeout) as (
    fn: () => void,
    ms: number,
  ) => TimerHandle;
  const clearTimeoutFn = (opts.clearTimeoutFn ?? clearTimeout) as (t: TimerHandle) => void;

  let refCount = 0;
  let handle: SidecarHandle | null = null;
  let kill: (() => void) | null = null;
  let launching: Promise<SidecarHandle> | null = null;
  let idleTimer: TimerHandle | null = null;

  function cancelIdleReap() {
    if (idleTimer) {
      clearTimeoutFn(idleTimer);
      idleTimer = null;
    }
  }

  async function ensureLaunched(): Promise<SidecarHandle> {
    if (handle) return handle;
    // Single-flight: concurrent acquires share one launch instead of spawning
    // N browsers (only the last would be tracked → the rest leak).
    if (launching) return launching;
    launching = (async () => {
      const engines = discover();
      const engine = pickChromiumEngine(engines, opts.preferEngineId);
      if (!engine) {
        throw new Error(
          "No Chromium-family browser found. Install Chrome, Edge, Brave, or Chromium to use the Chromium engine.",
        );
      }
      const started = await launcher.launch({ engine, port, userDataDir, loadExtensions: resolveLoadExtensions() });
      handle = { cdpEndpoint: started.cdpEndpoint, engine };
      kill = started.kill;
      return handle;
    })();
    try {
      return await launching;
    } finally {
      launching = null;
    }
  }

  function teardown() {
    cancelIdleReap();
    try {
      kill?.();
    } finally {
      kill = null;
      handle = null;
    }
  }

  return {
    /** Reserve the sidecar; launches on first use. */
    async acquire(): Promise<SidecarHandle> {
      cancelIdleReap();
      refCount++;
      try {
        return await ensureLaunched();
      } catch (err) {
        // A failed cold start must not leave a phantom reservation.
        refCount = Math.max(0, refCount - 1);
        throw err;
      }
    },

    /** Drop a reservation; reaps the process a grace window after the last one. */
    release(): void {
      refCount = Math.max(0, refCount - 1);
      if (refCount === 0 && handle) {
        cancelIdleReap();
        idleTimer = setTimeoutFn(() => {
          if (refCount === 0) teardown();
        }, idleGraceMs);
      }
    },

    /** Reap immediately (server shutdown). */
    dispose(): void {
      refCount = 0;
      teardown();
    },

    status() {
      return {
        running: handle !== null,
        refCount,
        cdpEndpoint: handle?.cdpEndpoint ?? null,
        engine: handle?.engine ?? null,
      };
    },
  };
}

/**
 * Default launcher: spawn the browser with remote debugging + a dedicated
 * profile, then poll `http://127.0.0.1:<port>/json/version` for the browser
 * WebSocket endpoint. Imported lazily so unit tests that inject a launcher
 * never touch child_process.
 */
function defaultLauncher(): SidecarLauncher {
  return {
    async launch({ engine, port, userDataDir, loadExtensions }) {
      const { spawn } = await import("node:child_process");
      const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        // Portachiavi FINTO, e non e' un dettaglio di igiene: senza, Chromium
        // chiede al portachiavi VERO di macOS, e ogni avvio fa comparire il
        // dialogo di autenticazione del sistema. Segnalato da Attilio il 12/08
        // («mi escono miliardi di finestre Google Chrome for Testing di
        // autenticazione»): erano due alberi orfani, uno di 22 ore e uno di 15,
        // ognuno col suo dialogo. Il browser che Playwright avvia per le pane lo
        // passa gia' (`--use-mock-keychain` e' nei suoi default) ed e' il motivo
        // per cui quello del server non ha mai chiesto niente: il sidecar era
        // l'unico a farlo.
        "--use-mock-keychain",
        // Il marchio, gemello di quello dell'agente in browser-service.ts: se il
        // server muore senza passare da gracefulShutdown, questo Chromium resta
        // vivo con ppid 1 e il prossimo avvio lo riconosce da qui. Conta anche
        // per un'altra ragione: il profilo del sidecar è FISSO, quindi un
        // residuo che lo tiene aperto fa fallire il lancio successivo.
        browserMarkArg("sidecar", process.pid),
      ];
      if (loadExtensions.length > 0) {
        args.push(`--load-extension=${loadExtensions.join(",")}`);
      }
      const child = spawn(engine.executablePath, args, { stdio: "ignore" });
      const kill = () => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      };
      try {
        const cdpEndpoint = await waitForCdpEndpoint(port);
        return { cdpEndpoint, kill };
      } catch (err) {
        // `child.kill()` ALONE IS NOT ENOUGH HERE, and the difference showed.
        //
        // Chromium forks its helpers (renderer, GPU, utility, zygote) and those
        // are not children of this process: killing the top one leaves them
        // alive with ppid 1, and the sidecar's profile is FIXED, so the leftover
        // holding it open makes the NEXT launch fail too. The mark comment above
        // already says this for the "server died dirty" case; this is the same
        // fault for a failed launch, which is far more frequent (see below).
        //
        // MEASURED on 2026-09-18 while measuring the extension boot cost: ten
        // orphaned `Chrome for Testing` with ppid 1, two of them alive 18
        // minutes after a kill that succeeded on the top process.
        //
        // AND THIS BRANCH IS NOT RARE: `waitForCdpEndpoint` waits 10 s, but
        // booting with this machine's 42 extensions takes 288 (already 28,8 s
        // at five). On the default configuration of this Mac the sidecar launch
        // always ends here, and every attempt used to leave one more tree. The
        // `--user-data-dir` the children carry is what lets us collect them.
        killByUserDataDir(userDataDir);
        kill();
        throw err;
      }
    },
  };
}

/**
 * Kills every process declaring this profile: the top one and its helpers.
 *
 * Chromium helpers do not carry the mark (Chromium does not forward switches it
 * does not know) but they do carry their browser's `--user-data-dir`: it is the
 * same key `planBootSweep` rests on, used here on a profile we know is ours
 * because we just created it.
 *
 * Never throws: this is cleanup on a path that is already failing, and an error
 * here would bury the real one the caller is about to propagate.
 *
 * Returns how many it signalled, which is what the test reads.
 */
export function killByUserDataDir(
  userDataDir: string,
  deps: { ps?: PsReader; kill?: (pid: number) => void } = {},
): number {
  const ps = deps.ps ?? defaultPsReader;
  const kill = deps.kill ?? ((pid: number) => process.kill(pid, "SIGKILL"));
  let killed = 0;
  try {
    const out = ps();
    if (!out) return 0;
    for (const row of parseProcSnapshot(out)) {
      if (row.pid === process.pid) continue;
      if (userDataDirOf(row.command) !== userDataDir) continue;
      try {
        kill(row.pid);
        killed++;
      } catch {
        /* already gone, or not ours */
      }
    }
  } catch {
    /* no ps, no cleanup: the launch fails anyway, just dirtier */
  }
  return killed;
}

/** The process snapshot, injectable: tests never call `ps`. */
export type PsReader = () => string | null;

// `require` and not a top-of-file import: this module deliberately avoids
// `child_process` at module level, so the unit tests that inject a launcher
// never load it (the comment on `defaultLauncher` says so).
const defaultPsReader: PsReader = () => {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  } catch {
    return null;
  }
};

/** Poll the DevTools version endpoint until it yields a browser ws:// URL. */
async function waitForCdpEndpoint(port: number, timeoutMs = 10000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const json = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(
    `Chromium sidecar did not expose a CDP endpoint on port ${port} within ${timeoutMs}ms` +
      (lastErr ? ` (last error: ${String(lastErr)})` : ""),
  );
}
