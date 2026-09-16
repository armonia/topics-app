/**
 * THE ONE FREEZER OF THIS PROCESS, and the three questions everybody else asks
 * it.
 *
 * Same shape as `setActiveBudgetGovernor`: the freezer is wired in `server.ts`,
 * and the modules that need to know about it - the stall detector, the
 * StaleStream sweeper, the PTY idle park, the kill path of a stopped session -
 * are libraries that cannot import the entry point and must not grow a
 * dependency on a service they only interrogate.
 *
 * `null` in tests and in a headless harness, where the honest answer to all
 * three is "nothing is frozen".
 */
import type { SwapFreezeView } from "../../shared/swap-freeze";

interface FreezerFacade {
  views(): SwapFreezeView[];
  isHold(sessionKey: string): boolean;
  frozenMsSince(sessionKey: string, since: number): number;
  release(sessionKey: string): Promise<void>;
}

let active: FreezerFacade | null = null;
/** Views injected by the e2e test route, so the frost can be driven without swap. */
let injected: SwapFreezeView[] = [];
let broadcast: ((views: SwapFreezeView[]) => void) | null = null;

export function setActiveSwapFreezer(freezer: FreezerFacade | null): void {
  active = freezer;
}

/** A command of this session is stopped by us right now. */
export function isSwapFreezeHold(sessionKey: string): boolean {
  try { return active?.isHold(sessionKey) ?? false; } catch { return false; }
}

/** How much of the time since `since` this session spent with a command stopped by us. */
export function swapFrozenMsSince(sessionKey: string, since: number): number {
  try { return active?.frozenMsSince(sessionKey, since) ?? 0; } catch { return 0; }
}

/** Continue this session's trees: the stop path calls it before its SIGTERM. */
export async function releaseSwapFreeze(sessionKey: string): Promise<void> {
  try { await active?.release(sessionKey); } catch { /* a thaw that fails must not stop a kill */ }
}

/** What the client draws: the real freezes plus anything a test route injected. */
export function swapFreezeViews(): SwapFreezeView[] {
  let live: SwapFreezeView[] = [];
  try { live = active?.views() ?? []; } catch { live = []; }
  return [...live, ...injected];
}

/** Wire the WS broadcast once; every change goes out as the whole list. */
export function setSwapFreezeBroadcast(fn: ((views: SwapFreezeView[]) => void) | null): void {
  broadcast = fn;
}

export function announceSwapFreeze(): void {
  try { broadcast?.(swapFreezeViews()); } catch { /* a socket that cannot be written is not the freezer's problem */ }
}

/** Test server only (`routes/e2e.ts`): drive the frost through the real frame. */
export function setInjectedSwapFreezeViews(views: SwapFreezeView[]): void {
  injected = views;
  announceSwapFreeze();
}
