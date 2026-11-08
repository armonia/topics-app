/**
 * The model selector of a CARD (scope `task`): the composer, the drawer and the
 * board default. It only translates the stored task value (`provider:model`,
 * a bare model, the legacy `topics:<model>`, `null` = Automatic) to and from
 * the selection `ModelSelector` works with; everything else is the one
 * selector. The value written stays `provider:model` (MP-TASK-06).
 */
import { useMemo } from 'react';
import { useProvidersSnapshot } from '../../../hooks/useProvidersSnapshot';
import { taskModelValue } from '../../../../../shared/task-coding-models';
import type { ProvidersSnapshot } from '../../../types';
import { ModelSelector, type ModelSelectorProps } from './ModelSelector';
import { taskMenuSelection } from './useModelCatalog';

interface TaskModelSelectorProps extends Omit<ModelSelectorProps, 'scope' | 'value' | 'routingTarget' | 'onSelect' | 'snapshot'> {
  /** The stored task value, `null` = Automatic. */
  value: string | null;
  /** The board default a card on Automatic runs with: what the band judges. */
  boardValue?: string | null;
  onSelect: (value: string | null) => void;
  snapshot?: ProvidersSnapshot | null;
}

export function TaskModelSelector({ value, boardValue, onSelect, snapshot: override, ...rest }: TaskModelSelectorProps) {
  const { snapshot: live } = useProvidersSnapshot();
  const snapshot = override ?? live;
  const selection = useMemo(() => taskMenuSelection(value, snapshot), [value, snapshot]);
  const routingTarget = useMemo(
    () => (value === null && boardValue && boardValue !== 'auto' ? taskMenuSelection(boardValue, snapshot) : undefined),
    [value, boardValue, snapshot],
  );
  return (
    <ModelSelector
      {...rest}
      scope="task"
      snapshot={override}
      value={selection}
      routingTarget={routingTarget}
      onSelect={(next) => onSelect(next.provider ? taskModelValue(next.provider, next.model) : null)}
    />
  );
}
