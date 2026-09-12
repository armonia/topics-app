export interface AgentStartGrantInput {
  projectId: string;
  subjectType: 'device' | 'person' | 'org';
  subjectId: string;
  machineId: string;
  model: string;
  effort: string;
  maxDurationMinutes: number;
}

export interface AgentStartCapabilityLifetime {
  revokedAt?: number | null;
  expiresAt?: number | null;
}

export function liveAgentStartCapabilities<T extends AgentStartCapabilityLifetime>(
  capabilities: readonly T[],
  now = Date.now(),
): T[] {
  return capabilities.filter((capability) => !capability.revokedAt && (!capability.expiresAt || capability.expiresAt > now));
}

export function preferredAgentStartModel(
  models: ReadonlyArray<{ id: string }>,
  projectModel?: string | null,
): string {
  return projectModel && models.some((model) => model.id === projectModel) ? projectModel : '';
}

export function grantAgentStartRequest(input: AgentStartGrantInput): [string, RequestInit] {
  return ['/api/auth/agent-start-capabilities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(input),
  }];
}

export function revokeAgentStartRequest(projectId: string, capabilityId: string): [string, RequestInit] {
  const query = new URLSearchParams({ projectId, capabilityId });
  return [`/api/auth/agent-start-capabilities?${query.toString()}`, {
    method: 'DELETE', credentials: 'same-origin',
  }];
}
