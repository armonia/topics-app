/**
 * What the readers did to the connections, on top of their seed
 * (`fixtures/team.ts`): the slice `connections`. The test of a robot reads it,
 * so a robot passes only while its connection is on.
 */
import { CONNECTIONS, type ConnectionSeed } from '../../../../ui/fixtures/team';
import { halleyPasswordSavedAt, type Vault } from '../../store/vault';

export type ConnectionStateId = ConnectionSeed['state'];

export interface ConnectionsSlice {
  /** The state a reader left a connection in. */
  states: Record<string, { state: ConnectionStateId; at: string; by: string }>;
  /** Failed attempts to reconnect, by connection: the portal accepts the second one. */
  attempts: Record<string, number>;
}

export const CONNECTIONS_INITIAL: ConnectionsSlice = { states: {}, attempts: {} };

export const connectionOf = (id: string): ConnectionSeed | undefined => CONNECTIONS.find((c) => c.id === id);

/**
 * Halley's connection is in error from 05/11 (Halley changed the robot's password) until a new password is in the
 * vault, whichever screen saved it; what a reader did here afterwards (disconnect, reconnect) still wins.
 */
export function connectionState(seed: ConnectionSeed, slice: ConnectionsSlice, vault: Vault): ConnectionStateId {
  const own = slice.states[seed.id]?.state;
  if (own) return own;
  return seed.id === 'halley' && halleyPasswordSavedAt(vault) ? 'connected' : seed.state;
}
