/**
 * The action facade: WHAT a working subject is doing, for the loader.
 *
 * Kept out of `signals.ts` so the store module stays under its size ceiling and
 * does not import the action store: this module reads both, `signals.ts` reads
 * neither of the hooks here. Callers import the hooks from this module.
 */
import { useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { AgentAction } from '../../../shared/agent-action';
import { useTopics, useTerminalSessions } from '../contexts/TopicsContext';
import { rollupAction, subjectActionFrom, useAgentActionStore, type ActionEntry } from './agentActions';
import { useTaskTopicId } from './taskSessions';
import { useTopicAtWork } from './childWork';
import {
  terminalBelongsToProject,
  useProjectAwaitingInput,
  useProjectLoading,
  useSignalsStore,
  useTerminalBackgroundTasks,
  useTerminalLoading,
  useTopicAwaitingInput,
  useTopicBackgroundTasks,
  useTopicLoading,
} from './signals';

// The loading hooks of `signals.ts` say WHETHER a subject works; these say which action
// it is doing, so the loader plays the right movement. Each returns undefined
// exactly when its loading twin says the subject does not work, so a caller
// can read either and never see a glyph with no action or an action with no
// glyph. The live action comes from `agentActions` (dwell-steadied); the
// precedence (wait, live, phase, background job) is `subjectActionFrom`.

/** The action of a chat, or undefined when it does not work. */
export function useTopicAction(topicId: string | undefined): AgentAction | undefined {
  // At work by the same rule as its tab: a turn, its left-running work, or its agents.
  const { atWork, agents } = useTopicAtWork(topicId);
  const turnOpen = useTopicLoading(topicId);
  const waiting = useTopicAwaitingInput(topicId);
  const tasks = useTopicBackgroundTasks(topicId);
  const live = useAgentActionStore((s) => (topicId ? s.actions.get(topicId)?.action : undefined));
  const fromPhase = useSignalsStore((s) => (topicId ? s.sessionActivity.get(topicId)?.action : undefined));
  // No turn open and agents at work under it: they are what moves, whatever else it waits on.
  if (agents > 0 && !turnOpen && !waiting) return 'delegate';
  return subjectActionFrom({ inProgress: atWork, turnOpen, waiting, live, fromPhase, tasks });
}

/**
 * The action of a terminal, or undefined when it does not work. A terminal
 * busy on pty output alone (a plain shell, or a Claude Code session whose
 * phase is not known yet) is running a command.
 */
export function useTerminalAction(sessionId: string | undefined): AgentAction | undefined {
  const inProgress = useTerminalLoading(sessionId);
  const tasks = useTerminalBackgroundTasks(sessionId);
  const live = useAgentActionStore((s) => (sessionId ? s.actions.get(sessionId)?.action : undefined));
  const { phaseActive, ptyOnly } = useSignalsStore(useShallow((s) => ({
    phaseActive: !!sessionId && s.claudePhaseActiveTermIds.has(sessionId),
    ptyOnly: !!sessionId && s.terminalBusyIds.has(sessionId)
      && !s.claudePhaseActiveTermIds.has(sessionId) && !s.claudePhaseRestingTermIds.has(sessionId),
  })));
  if (ptyOnly && !live) return 'run';
  return subjectActionFrom({ inProgress, turnOpen: phaseActive, waiting: false, live, tasks });
}

/**
 * The action of a project folder: the rollup of its working children (the
 * same child walk as `useProjectLoading`). A child waiting for the person makes
 * it `wait`; otherwise the child that changed action most recently speaks.
 */
export function useProjectAction(projectPath: string | undefined): AgentAction | undefined {
  const loading = useProjectLoading(projectPath);
  const waiting = useProjectAwaitingInput(projectPath);
  const topics = useTopics();
  const terminalSessions = useTerminalSessions();
  const { live, hydrated, phaseActive } = useSignalsStore(useShallow((s) => ({
    live: s.liveStreamTopics,
    hydrated: s.hydratedStreamTopics,
    phaseActive: s.claudePhaseActiveTermIds,
  })));
  // The working children's keys, joined: a string, so the selector below only
  // changes identity when the set of children does.
  const childKeys = useMemo(() => {
    if (!projectPath || !loading || waiting) return '';
    const keys: string[] = [];
    for (const t of Object.values(topics)) {
      if (t.projectPath === projectPath && (live.has(t.id) || hydrated.has(t.id))) keys.push(t.id);
    }
    for (const ts of terminalSessions) {
      if (ts.type === 'shell' || !ts.cwd || !terminalBelongsToProject(ts.cwd, projectPath)) continue;
      if (phaseActive.has(ts.id)) keys.push(ts.id);
    }
    return keys.join('\n');
  }, [projectPath, loading, waiting, topics, terminalSessions, live, hydrated, phaseActive]);
  // A primitive out of the action store: a folder redraws when ITS rollup
  // changes, not on every action change of every subject in the app.
  const rolled = useAgentActionStore(useCallback((s: { actions: ReadonlyMap<string, ActionEntry> }) => {
    if (!childKeys) return undefined;
    const children: ActionEntry[] = [];
    for (const key of childKeys.split('\n')) {
      const e = s.actions.get(key);
      if (e) children.push(e);
    }
    return rollupAction(children);
  }, [childKeys]));
  if (!projectPath || !loading) return undefined;
  if (waiting) return 'wait';
  return rolled ?? 'think';
}

/**
 * The action of a board card: the one of the chat its agent works in
 * (`assignedTopicId`, read through the task index). undefined for a card no
 * agent works on right now.
 */
export function useTaskAction(taskId: string | undefined): AgentAction | undefined {
  return useTopicAction(useTaskTopicId(taskId));
}

/**
 * The action the tray shows: the most recent among every subject at work
 * (an open chat turn, a Claude Code terminal in an active phase). undefined
 * when nothing works.
 */
export function useDominantAction(): AgentAction | undefined {
  const actions = useAgentActionStore((s) => s.actions);
  const { live, hydrated, phaseActive } = useSignalsStore(useShallow((s) => ({
    live: s.liveStreamTopics,
    hydrated: s.hydratedStreamTopics,
    phaseActive: s.claudePhaseActiveTermIds,
  })));
  return useMemo(() => {
    const working: ActionEntry[] = [];
    for (const [key, e] of actions) {
      if (live.has(key) || hydrated.has(key) || phaseActive.has(key)) working.push(e);
    }
    return rollupAction(working, { waitWins: false });
  }, [actions, live, hydrated, phaseActive]);
}
