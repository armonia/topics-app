export const OPEN_FIRST_RUN_EVENT = 'topics:open-first-run';

export function openFirstRun(): void {
  window.dispatchEvent(new Event(OPEN_FIRST_RUN_EVENT));
}
