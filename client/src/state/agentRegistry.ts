/** The agents registry read from `/api/agent-config` (server/routes/agent-config.ts). */
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/shell/net';
import type { RegistryIssue } from '../../../shared/agents-health';

export interface Chat {
  channel: string; chat: string; account: string; active: boolean; mention: boolean; senders: string[]; denied: string[];
  hasSystem: boolean; system: string; routed: boolean; twoAgents: boolean;
  category?: string; followedBy: string[];
}
export interface Job { id: string; name: string; paused: boolean; kind: string; schedule: string; rawSchedule: { kind: string; expr?: string; minutes?: number; at?: string; tz?: string } | null; model: string | null; deliver: string | null }
export interface Agent {
  id: string; name: string; job: string; workspace: string; persona: Record<string, string>;
  accounts: { channel: string; account: string; token: string }[]; chats: Chat[]; jobs: Job[];
  model: { engine: string | null; perChannel: Record<string, Record<string, string>> };
}
export interface AgentRoute { channel: string; chat: string; agent: string }
export interface Registry { agents: Agent[]; issues: RegistryIssue[]; health: { ok: boolean; text: string } | null; routes: AgentRoute[] }

export function useAgentRegistry() {
  const [reg, setReg] = useState<Registry | null>(null);
  const load = useCallback(() => {
    void apiFetch('/api/agent-config', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((b) => b && setReg(b)).catch(() => {});
  }, []);
  useEffect(load, [load]);
  return { reg, load };
}

