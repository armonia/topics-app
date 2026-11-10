/** The agents registry read from `/api/agent-config` (server/routes/agent-config.ts). */
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/shell/net';

export interface Chat { channel: string; chat: string; account: string; active: boolean; mention: boolean; senders: string[]; denied: string[]; hasSystem: boolean; system: string; routed: boolean; twoAgents: boolean }
export interface Job { id: string; name: string; paused: boolean; kind: string; schedule: string; rawSchedule: { kind: string; expr?: string; minutes?: number; at?: string; tz?: string } | null; model: string | null; deliver: string | null }
export interface Agent {
  id: 'main' | 'gtm'; name: string; workspace: string; persona: Record<string, string>;
  accounts: { channel: string; account: string; token: string }[]; chats: Chat[]; jobs: Job[];
  model: { engine: string | null; perChannel: Record<string, Record<string, string>> };
}
export interface Registry { agents: Agent[]; issues: { agent: string | null; text: string }[]; health: { ok: boolean; text: string } | null }

export function useAgentRegistry() {
  const [reg, setReg] = useState<Registry | null>(null);
  const load = useCallback(() => {
    void apiFetch('/api/agent-config', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((b) => b && setReg(b)).catch(() => {});
  }, []);
  useEffect(load, [load]);
  return { reg, load };
}

