/**
 * useTaskModelCatalog - the ONE list of models a task can be dispatched on.
 *
 * Three surfaces used to answer this question on their own: the composer, the
 * task drawer and the board settings picker each seeded a `useState` from
 * `getProvidersSnapshotState()` and hand-rolled a `subscribeProvidersSnapshot`
 * effect. Three copies of the same derivation is three chances to drift, and
 * one of them was lazy (the composer only subscribed when its menu opened), so
 * the same board could show two different catalogs at the same moment.
 *
 * The catalog is `availableTaskModels(snapshot)`: only runtimes that can
 * actually EXECUTE a task, never an API chat connection. That filter is the
 * shared module's job and stays there. This hook is only the plumbing.
 *
 * Cost is unchanged: `useProvidersSnapshot` observes the shared store, which
 * owns the single HTTP fetch and the single WS subscription regardless of how
 * many components mount. A provider going down or coming up arrives as a
 * `providers:snapshot` push and re-renders every consumer at once.
 */
import { useMemo } from 'react';
import { useProvidersSnapshot } from './useProvidersSnapshot';
import { availableTaskModels } from '../../../shared/task-coding-models';

export function useTaskModelCatalog(): string[] {
  const { snapshot } = useProvidersSnapshot();
  return useMemo(() => availableTaskModels(snapshot), [snapshot]);
}
