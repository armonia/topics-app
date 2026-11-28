interface StaleChecksDeps {
  addComment(args: { taskId: string; author: string; content: string; kind: "service" }): unknown;
}

/**
 * One service comment per pair of shas: a card held by `landIntent` whose
 * bar never measured the commit it actually delivers is not left mute
 * (card 0a3fed8f, 28/11: `a467677d` sat 47 minutes, `968b6717` 33, neither
 * one saying why). Called again on the SAME pair does nothing. The sweep
 * that calls this runs every few seconds while the card is pending.
 */
export function createStaleChecksNoter(deps: StaleChecksDeps) {
  const staleChecksNoted = new Map<string, string>();
  return function noteStaleChecks(taskId: string, checksCommit: string | null, deliveryCommit: string): void {
    const pair = `${checksCommit ?? "null"}->${deliveryCommit}`;
    if (staleChecksNoted.get(taskId) === pair) return;
    staleChecksNoted.set(taskId, pair);
    const checksSha = checksCommit ? `\`${checksCommit.slice(0, 8)}\`` : "nessun commit";
    try {
      deps.addComment({
        taskId, author: "system", kind: "service",
        content: `L'approvazione aspetta ancora un verdetto sul commit che consegna: la barra ha misurato ${checksSha}, ` + // allow-italian: board notes are written in Italian like every other service comment
          `la consegna è ora su \`${deliveryCommit.slice(0, 8)}\`. Resta in review finché i due coincidono.`,
      });
    } catch { /* a trace, not a gate */ }
  };
}
