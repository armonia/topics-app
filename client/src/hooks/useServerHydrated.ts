/**
 * One implementation, owned by the middleware that flips the flag
 * (`state/pane/middleware/serverHydrated.ts`): the subscription contract and
 * the design notes live next to the listeners. Callers keep importing the
 * hook from `hooks/`, like every other hook. Two copies existed until
 * 2026-09-04, and the one in the middleware, unused, is what `check:deadcode`
 * reported.
 */
export { useServerHydrated } from '../state/pane/middleware/serverHydrated';
