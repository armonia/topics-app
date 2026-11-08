import type { CliAgentPresence } from '@/lib/api';

export interface AgentSetupRow {
  id: string;
  name: string;
  installed: boolean;
  path: string | null;
  install: string;
}

export function agentSetupRows(agents: CliAgentPresence[]): AgentSetupRow[] {
  return agents.map(({ id, name, installed, path, install }) => ({ id, name, installed, path, install }));
}
