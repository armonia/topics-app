/**
 * When a tool-call row's body shows itself, and when it stays.
 *
 * WHY THIS IS ITS OWN FILE. The rule used to live entirely inside one
 * `useEffect` in `ToolCallRow.tsx`, and nothing could reach it: the component
 * pulls in the store, the i18n context and a dozen card renderers, and this
 * project has no DOM in unit tests (no jsdom, no happy-dom — see
 * `ThreadRuns.test.tsx`). So the one part of the row that is a *decision*
 * rather than markup had no test at all, while the requirement it satisfies
 * (CHAT-TOOL-03) was already named in the source. The same cut was made, for
 * the same reason, in `routes/clearPolicy.ts` and `routes/subagentProcesses.ts`:
 * the decision moves to where a test can reach it, the component keeps the
 * plumbing.
 *
 * WHAT THE DECISION IS FOR. An agent's turn is a burst of tool calls, most of
 * them finishing in tens of milliseconds. Opening a panel for each one turns
 * the transcript into a strobe light: the page jumps, and the thing you were
 * reading moves under your eyes. Two thresholds keep that from happening, and
 * they fail in opposite directions:
 *
 *  - open too eagerly and instant tools flash open and closed;
 *  - close too eagerly and a 500 ms tool opens a panel you never get to read,
 *    which is the same flash wearing a different hat.
 *
 * Neither failure throws. Both are only visible to a person watching the
 * screen, which is exactly the kind of regression that survives a green suite.
 */

/**
 * Running must persist this long before the body auto-opens, so instant tools
 * (a sub-250 ms Read) never flash a panel open and closed.
 */
export const AUTO_OPEN_DELAY_MS = 250;

/**
 * Once auto-opened, the body stays visible at least this long even if the tool
 * finishes earlier, so short tools remain readable.
 */
export const AUTO_OPEN_MIN_DWELL_MS = 1500;

/** What the row's auto-open effect should schedule right now. */
export type AutoOpenSchedule =
  | { action: "open"; delayMs: number }
  | { action: "close"; delayMs: number }
  | null;

/**
 * The timer the auto-open effect should arm for the current state.
 *
 * `null` means "arm nothing", which is also the state an instant tool lands
 * in: it goes from running to finished before the `open` timer fires, React
 * runs the effect's cleanup, and the row never opened. That cancellation is
 * the anti-flash rule — this function's job is to make sure the only thing
 * pending at that moment IS a cancellable timer, never an already-applied
 * open.
 *
 * @param isRunning whether the tool is still running
 * @param autoOpen  whether the body is currently auto-opened
 * @param openedAt  epoch ms at which it auto-opened (meaningless when closed)
 * @param now       epoch ms; a parameter so a test can pin it
 */
export function autoOpenSchedule(
  isRunning: boolean,
  autoOpen: boolean,
  openedAt: number,
  now: number,
): AutoOpenSchedule {
  if (isRunning) return { action: "open", delayMs: AUTO_OPEN_DELAY_MS };
  if (!autoOpen) return null;
  // The residual, not the full dwell: a tool that ran for two seconds has
  // already paid it, and re-arming the whole 1.5 s would keep finished rows
  // expanded long after the turn ended.
  return { action: "close", delayMs: Math.max(0, AUTO_OPEN_MIN_DWELL_MS - (now - openedAt)) };
}

/** The inputs that can open a row's body, in the order they are considered. */
export interface DisclosureInputs {
  /** The user has clicked the row at least once. */
  userToggled: boolean;
  /** The open/closed state the user's clicks produced. */
  open: boolean;
  /** Sub-agent rows expand by default: their action log IS the signal. */
  isSubAgent: boolean;
  /** The row is asking the user something; the form is its whole reason to exist. */
  isHumanTurn: boolean;
  /** The anti-flash automatism above. */
  autoOpen: boolean;
}

/**
 * Whether the body is shown.
 *
 * The one rule worth stating out loud: **an explicit toggle always wins.**
 * Once someone has clicked the row, the automatism stops deciding for them —
 * a panel that reopens itself after you closed it reads as a broken control,
 * and a panel that closes itself while you are reading it is worse.
 */
export function bodyIsOpen(i: DisclosureInputs): boolean {
  if (i.userToggled) return i.open;
  return i.open || i.isSubAgent || i.isHumanTurn || i.autoOpen;
}
