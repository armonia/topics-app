/**
 * Barrel for the pane-store middleware layer. These are module-level
 * side-effects that subscribe to the store at app boot — they are NOT
 * React hooks and do NOT need a component to register.
 *
 * Callers invoke each `init*()` exactly once during bootstrap.
 */
export { initLocalPersistence, PANE_STORE_LOCAL_KEY, hydrateFromLocalSnapshot } from './persistLocal';
export { initServerSync, PANE_STORE_REMOTE_KEY, flushPaneStoreNow } from './syncServer';
export { initWSSync, __getLastAppliedServerSeq } from './syncWS';
export type { WSFrame } from './syncWS';
export { initCrossTabSync, getTabId } from './syncCrossTab';
export {
  rememberLocalAck,
  isSelfEcho,
  __getPendingAcks,
  __getLastEmittedServerSeq,
} from './selfEcho';
export {
  recordAction,
  subscribe as subscribeMutationLog,
  getRing,
  clearRing,
  RING_BUFFER_SIZE,
} from './mutationLog';
