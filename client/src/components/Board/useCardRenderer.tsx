/**
 * How a column draws one of its cards: the board's props mapped onto `Card`.
 * Shared by the status column (`Column`) and the merged one (`MergedColumn`),
 * so the two cannot drift apart. The card component is injected rather than
 * imported: `Card.tsx` uses this hook, and a value import back would be a cycle.
 */
import { useCallback, useMemo, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import type { BoardSettings, BoardTask, TaskStatus } from '../../lib/board';
import type { TaskSessionState } from '../../lib/taskSession';
import { estimatesByProject } from '../../../../shared/task-countdown';
import type { BoardDensity } from './boardGeometry';
import type { LiveUsage, OpenTask } from './constants';
import type { Card } from './Card';

export interface CardRenderInput {
  onOpen: OpenTask;
  showProject: boolean;
  onRefetch: () => void;
  onOpenTopic?: (topicId: string) => void;
  cardError: { taskId: string; message: string } | null;
  onCardError: (taskId: string, message: string | null) => void;
  resolveSession?: (assignedTopicId: string | null | undefined) => TaskSessionState;
  paneBoardId: string;
  paneSettings: BoardSettings | null;
  tasksById: Map<string, BoardTask>;
  projectPathById: Map<string, string>;
  liveById: Map<string, LiveUsage>;
  awaitingHuman: Set<string>;
  justMoved: Map<string, TaskStatus>;
  justCreated: Set<string>;
  archived?: boolean;
  density?: BoardDensity;
  /** The cards cannot be picked up: the merged column has no status to drag between. */
  dragDisabled?: boolean;
}

export function useCardRenderer(
  { onOpen, showProject, onRefetch, onOpenTopic, cardError, onCardError, resolveSession, paneBoardId, paneSettings, tasksById, projectPathById, liveById, awaitingHuman, justMoved, justCreated, archived, density, dragDisabled }: CardRenderInput,
  CardComponent: ComponentType<ComponentProps<typeof Card>>,
): (t: BoardTask) => ReactNode {
  const estimateByProject = useMemo(() => estimatesByProject(tasksById.values()), [tasksById]);
  return useCallback((t: BoardTask) => (
    <CardComponent
      key={t.id} task={t} onOpen={onOpen} showProject={showProject} onRefetch={onRefetch} onOpenTopic={onOpenTopic}
      error={cardError?.taskId === t.id ? cardError.message : null}
      onError={onCardError}
      sessionState={resolveSession?.(t.assignedTopicId) ?? 'unknown'}
      paneBoardId={paneBoardId}
      paneSettings={paneSettings}
      parentTitle={t.parentTaskId ? tasksById.get(t.parentTaskId)?.text : undefined}
      projectPath={projectPathById.get(t.projectId)}
      live={liveById.get(t.id)}
      estimate={estimateByProject.get(t.projectId) ?? null}
      // The live event OR the thread: the first dies with the process, the
      // second does not, and an unanswered question survives a restart.
      awaiting={awaitingHuman.has(t.id) || !!t.awaitingAnswer}
      justMovedTo={justMoved.get(t.id)}
      justCreated={justCreated.has(t.id)}
      archived={archived}
      density={density}
      dragDisabled={dragDisabled}
    />
  ), [CardComponent, onOpen, showProject, onRefetch, onOpenTopic, cardError, onCardError, resolveSession, paneBoardId, paneSettings, tasksById, projectPathById, liveById, estimateByProject, awaitingHuman, justMoved, justCreated, archived, density, dragDisabled]);
}
