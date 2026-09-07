/**
 * THE ONE PIECE OF AN AGENT'S WORK THE PRIORITY GOVERNOR COULD NOT COVER.
 *
 * KANBAN-78 demotes everything Topics runs for an agent, at spawn time, and
 * that is enough for a process born for one owner. The headless Chromium is
 * not one of those: there is ONE for the whole server (single-flight in
 * `ensureBrowser`), the agents drive it through their browser tools, and the
 * browser panes of whoever uses the app drive the very same process. Measured
 * on 2026-09-07 01:30: it sat at nice 0 with two renderers at 45 % and 18 %
 * CPU while load was 11.7 on twelve cores and every other agent process was
 * at nice 15-20, as the governor wants.
 *
 * `nice` is the wrong knob here, because on macOS a process cannot lower its
 * own nice value again without root: a demotion would still be there when a
 * person opens a pane. The QoS band can be toggled both ways by anybody
 * (`taskpolicy -b` / `-B`), so it is toggled - on every event that can change
 * WHO is using the browser, and only when the verdict actually moves.
 *
 * This module is the state and the transition; the rule is
 * `browserShouldBeBackground` and the toggle is `setBackgroundTree`, both in
 * `low-priority.ts`. Everything is injected, so the whole thing is testable
 * without a Chromium. @covers KANBAN-78
 */
import { spawn } from "child_process";
import { existsSync } from "fs";
import { browserShouldBeBackground, type AgentOwnerTest, type BrowserContextOwner } from "./low-priority";

export interface BrowserQosDeps {
  /** Every live context of the shared browser, with what is known of its owner. */
  listOwners: () => BrowserContextOwner[];
  /** The agent/person criterion, shared with the CLI governor. */
  ownerTest: AgentOwnerTest;
  /** The browser process, or null while there is none. */
  browserPid: () => Promise<number | null>;
  /** The toggle on the whole process tree; returns the pids it touched. */
  apply: (pid: number, on: boolean) => Promise<number[]>;
  log?: (line: string) => void;
}

export interface BrowserQosGovernor {
  /** Recompute and, only if the verdict moved, toggle the band. Never throws. */
  refresh(reason: string): void;
  /** The process the band belonged to is gone: decide from scratch next time. */
  reset(): void;
  /** Resolves when the in-flight toggle, if any, is done (tests). */
  settled(): Promise<void>;
}

export function createBrowserQosGovernor(deps: BrowserQosDeps): BrowserQosGovernor {
  const log = deps.log ?? ((line: string) => console.log(line));
  /** What the browser is set to right now; null = unknown/never set. */
  let band: boolean | null = null;
  /** Serialized: two verdicts in the same tick must not race on one tree. */
  let work: Promise<void> = Promise.resolve();

  return {
    refresh(reason) {
      const wanted = browserShouldBeBackground(deps.listOwners(), deps.ownerTest);
      if (wanted === band) return;
      band = wanted;
      work = work.then(async () => {
        const pid = await deps.browserPid();
        // No process to move: leave the band unknown so the next event retries
        // instead of believing a toggle that never happened.
        if (!pid) { band = null; return; }
        const touched = await deps.apply(pid, wanted);
        // One line per TRANSITION - this runs on every context create/destroy.
        log(`[BrowserService] Chromium QoS: ${wanted ? "background" : "foreground"} (${reason}; pid ${pid} + ${Math.max(0, touched.length - 1)} child process(es))`);
      }).catch((err: any) => {
        band = null;
        console.warn(`[BrowserService] QoS toggle failed:`, err?.message ?? err);
      });
    },
    reset() { band = null; },
    settled() { return work; },
  };
}

const PGREP_BIN = "/usr/bin/pgrep";

/**
 * WHICH PROCESS IS THE BROWSER. Playwright's `Browser` object does not say
 * (only `BrowserServer` and Electron expose a `process()`), so the pid is read
 * back from the process table through the mark this server already puts in the
 * command line for the orphan sweep - `--topics-browser=agent:<our pid>`,
 * unique to this server and absent from Chromium's helper processes (verified
 * 2026-09-07 on a live headless shell: exactly one match).
 *
 * `mark` must arrive WITHOUT its leading dashes: `pgrep -f --topics-browser=…`
 * reads them as options and matches nothing, which is how the first run of the
 * probe found no browser at all.
 */
export function markedBrowserPid(mark: string, ownPid: number = process.pid): Promise<number | null> {
  return new Promise((resolve) => {
    if (!existsSync(PGREP_BIN)) return resolve(null);
    try {
      let out = "";
      const p = spawn(PGREP_BIN, ["-f", mark], { stdio: ["ignore", "pipe", "ignore"] });
      p.stdout?.on("data", (chunk) => { out += String(chunk); });
      p.on("error", () => resolve(null));
      p.on("close", () => {
        const pids = out.split("\n").map((l) => Number(l.trim()))
          .filter((n) => Number.isInteger(n) && n > 0 && n !== ownPid);
        resolve(pids[0] ?? null);
      });
    } catch { resolve(null); }
  });
}
