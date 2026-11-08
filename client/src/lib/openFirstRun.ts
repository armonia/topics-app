export const OPEN_FIRST_RUN_EVENT = 'topics:open-first-run';

export function openFirstRun(): void {
  window.dispatchEvent(new Event(OPEN_FIRST_RUN_EVENT));
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
