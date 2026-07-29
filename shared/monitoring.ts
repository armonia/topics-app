/**
 * Le forme che le superfici di monitoraggio mostrano di un agente vivo:
 * la sessione, il feed di attività, il journal.
 *
 * Erano dichiarate due volte — `server/routes/agents.ts`,
 * `server/activity-monitor.ts`, `server/journal-collector.ts` da una parte e
 * `client/src/hooks/useAgents.ts`, `useActivity.ts`, `useJournal.ts`
 * dall'altra — copie per ora identiche, cioè destinate a divergere alla prima
 * modifica su un solo lato. Qui c'è una dichiarazione sola.
 */

/** Una sessione agente viva, come la elenca `GET /api/agents/sessions`. */
export interface AgentSession {
  key: string;
  kind: 'main' | 'group' | 'cron' | 'hook' | 'node' | 'subagent' | 'other';
  channel: string;
  displayName: string;
  status: 'active' | 'idle' | 'completed' | 'error';
  model?: string;
  updatedAt: number;
  sessionId?: string;
  totalTokens?: number;
  contextTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  abortedLastRun?: boolean;
  lastMessage?: string;
  topicId?: string;
  topicName?: string;
}

export type ActivityCategory =
  | 'tool:exec'
  | 'tool:browser'
  | 'tool:read'
  | 'tool:write'
  | 'tool:edit'
  | 'tool:search'
  | 'tool:message'
  | 'memory'
  | 'channel'
  | 'cron'
  | 'heartbeat'
  | 'session'
  | 'error'
  | 'system';

export interface ActivityEvent {
  id: string;
  timestamp: string;
  category: ActivityCategory;
  level: 'debug' | 'info' | 'warn' | 'error';
  title: string;
  detail?: string;
  subsystem?: string;
  sessionKey?: string;
  raw?: string;
}

export interface JournalEvent {
  id: string;
  timestamp: string;
  sessionKey: string;
  type: 'tool_call' | 'message' | 'session_start' | 'session_end' | 'error';
  summary: string;
  detail?: string;
}
