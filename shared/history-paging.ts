/**
 * How a chat's history is paged when a pane opens: the TAIL first, the rest
 * only when nobody is looking at the list.
 *
 * THE DEFECT THIS CLOSES, measured on the desktop's own state on 2026-09-05:
 * after a reload the chat sat behind its skeleton for 500-1200 ms - up to the
 * curtain's hard cap - because the curtain waited for the WHOLE history
 * (`POST /api/history/<key>` with `limit: 0`), and a whole history weighs 200 KB
 * to 2.6 MB per chat and lands in 0.7-1.7 s. The local copy could not stand in
 * for it: it held a different number of messages than the answer, so revealing
 * on the copy and then applying the history would grow the list in plain sight -
 * the layout shift PERF-01 forbids.
 *
 * THE SHAPE. The first request asks for the last `HISTORY_FIRST_PAGE` messages
 * only; the local copy holds the SAME tail, so the first frame drawn from the
 * cache IS the first page and the server's answer confirms it without adding or
 * removing a row; the curtain lifts once that page is painted. The messages
 * before the page are fetched and merged ONLY while the pane is hidden (a tab
 * behind another, a window in the background), or when the person asks for them
 * from the top of the list, or when a reader that needs the whole thread asks
 * (`client/src/state/historyCompleteness.ts`). Never under a reader's eyes: a
 * prepend re-indexes the rows a virtual list has on screen, and the one way
 * Virtuoso offers to hide that (`firstItemIndex`) was measured at CLS 0.60 on a
 * gesture whose contract is zero (branch `experiment/chat-tail-first-virtuoso-
 * prepend`). A chat shorter than a page makes one request, exactly as before.
 *
 * Shared because three parties must agree on the number: the client that asks
 * (`useChat.loadHistory`), the local copy that has to hold the SAME tail
 * (`cacheMessages`), and the e2e that seeds "more than a page" to exercise the
 * second request (`tests/e2e/chat-tail-first.spec.ts`).
 */

/**
 * Messages in the first page. Forty: more than a screen of any chat on any
 * viewport, so the reveal never shows an empty top; a few tens of KB of lean
 * rows even on agentic turns, so the page answers in the time the curtain's
 * floor already grants (80 ms).
 */
export const HISTORY_FIRST_PAGE = 40;

/**
 * The `limit` that means "no cap, the whole thread" to `/api/history` (see
 * `server/routes/history.ts`, `wantsAll`). The paths that must hold the whole
 * thread - a branch switch, a delete, the reload after an edit - keep sending
 * it; combined with `before`, it asks for everything BEFORE one message.
 */
export const HISTORY_FETCH_ALL = 0;
