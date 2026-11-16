import type { ContextLevel } from '../../../shared/context-thresholds';

/** Ink of a context level, from the shared thresholds: the same cut-offs the ring and the server use. */
export const contextLevelInk = (level: ContextLevel | null): string => (level === 'critical' ? 'text-red-500' : level === 'warn' ? 'text-amber-500' : '');
