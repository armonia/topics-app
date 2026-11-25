/**
 * The channel bridge's activity for the last 7 days, read once per mount from
 * `/api/agent-channels/activity`: counts per agent and channel, and the
 * newest turns behind them (title, state). Shared by the overview list and
 * the agent page so both read the same numbers.
 */
import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/shell/net';

/** Counts per agent and channel. Turns carry no cost or timing, so none is here. */
export interface ActivityRow { agent: string; channel: string; handled: number; failed: number; quota: number; merged: number; lastError: string | null }

export interface ActivityTurn {
  agent: string; channel: string; chat: string | null; title: string | null;
  state: 'working' | 'failed' | 'done'; created: number; error: string | null;
}

export interface AgentActivity { rows: ActivityRow[]; turns: ActivityTurn[] }

const EMPTY: AgentActivity = { rows: [], turns: [] };

export function useAgentActivity(): AgentActivity {
  const [activity, setActivity] = useState<AgentActivity>(EMPTY);
  useEffect(() => {
    let alive = true;
    void apiFetch('/api/agent-channels/activity', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: Partial<AgentActivity> | null) => { if (alive && body) setActivity({ rows: body.rows ?? [], turns: body.turns ?? [] }); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return activity;
}
