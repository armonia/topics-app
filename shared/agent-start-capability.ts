export type AgentStartSubjectType = "device" | "person" | "org";

/** The persisted capability fields shared by the API and its UI consumers. */
export interface AgentStartCapabilityContract {
  id: string;
  subjectType: AgentStartSubjectType;
  subjectId: string;
  projectId: string;
  machineId: string;
  machineName: string | null;
  repositoryKey: string;
  model: string;
  effort: string;
  maxDurationMinutes: number;
  maxAttempts: 1;
  fanout: 1;
  grantedByPersonId: string;
  grantedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}
