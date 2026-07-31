/**
 * Barrel for the pane-store middleware layer. These are module-level
 * side-effects that subscribe to the store at app boot — they are NOT
 * React hooks and do NOT need a component to register.
 *
 * Callers invoke each `init*()` exactly once during bootstrap.
 *
 * It must NOT re-export `./mutationLog`. That module is dev-only and
 * `scripts/assert-dev-overlay-stripped.sh` forbids its symbols (`recordAction`,
 * `state/pane/middleware/mutationLog`) from appearing in the production bundle.
 * While the barrel re-exported them, the contract held only because Rollup
 * tree-shook an unconsumed re-export — a guarantee from the OPTIMISER, not from
 * the structure. One `import * as mw from './middleware'` anywhere, or a change
 * in minification, and the shipped bundle would have carried the dev overlay
 * with nobody having touched mutationLog.ts. Import it directly where it is
 * genuinely needed (its own test does).
 *
 * Il barrel espone SOLO quello che qualcuno importa da qui (App.tsx e
 * bootstrap.ts): le chiavi di storage, i getter `__*` da test e i helper di
 * self-echo si importano dal loro modulo, che è già quello che fanno tutti i
 * chiamanti veri. Ri-esportarli "per simmetria" li faceva sembrare parte
 * dell'interfaccia del layer quando nessuno li prendeva da qui.
 */
export { initLocalPersistence, hydrateFromLocalSnapshot, flushLocalPaneStoreNow } from './persistLocal';
export { initServerSync, flushPaneStoreNow } from './syncServer';
export { initWSSync } from './syncWS';
export type { WSFrame } from './syncWS';
export { initCrossTabSync } from './syncCrossTab';
