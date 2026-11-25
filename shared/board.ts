/**
 * The board contract: ONE declaration, read from both ends of the wire.
 *
 * Until 29/07 these types existed twice (`server/services/tasks.ts` +
 * `server/services/review-checks.ts` + `server/services/dispatch-capacity.ts`
 * on one side, `client/src/lib/board.ts` on the other) and the client copy was
 * already behind: `BoardSettings` did not know `dispatchRetryCap` nor
 * `dispatchRetryBackoffS`, fields the server WRITES in the `board_settings`
 * row and sends back on every GET. The client received them and threw them
 * away, and a PATCH built from its type would have silently zeroed them.
 *
 * The list of statuses was written three times too (the client-side type, its
 * `TASK_STATUSES`, and the server's private `const STATUSES`). Here it is ONE:
 * the type DERIVES from the value, so adding a kanban column without updating
 * the validation no longer compiles.
 *
 * `shared/` is the only folder both TS projects can include without breaking
 * the composite boundary (TS6307): see `shared/ws-outbound.ts`.
 */

export * from './board-base';
export * from './board-parking';
export * from './board-queue-reason';
export * from './board-contract';
export * from './board-questions';

/**
 * The cap "by resources" and its three pure functions live next door
 * (`dispatch-pressure.ts`) and come back out from here: every reader of the cap
 * already imports this file, and a second import path for the same subject is
 * how two halves of one contract start drifting.
 */
export * from './dispatch-pressure';
// The controller of that mode (budget, admission, freeze order) is a module of
// its own and comes out through the same door, for the same reason.
export * from './machine-budget';
