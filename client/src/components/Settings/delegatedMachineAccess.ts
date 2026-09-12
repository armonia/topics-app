export type DelegatedRequestState = 'pending' | 'approved' | 'active' | 'denied' | 'expired' | 'revoked' | 'failed';

export interface DelegatedMachineRequest {
  id: string;
  purpose?: 'catalog' | 'authorization';
  capabilityId?: string;
  machineId?: string;
  code?: string;
  state: DelegatedRequestState;
  expiresAt?: number | null;
  repositoryKey?: string;
  repositoryName?: string;
  subjectName?: string;
  originName?: string;
  requestedBy?: string;
  model?: string;
  effort?: string;
  maxDurationMinutes?: number;
  authorizationId?: string;
  localProjectId?: string;
  localPersonId?: string;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export function createDelegatedRequest(machineId: string, capabilityId: string): [string, RequestInit] {
  return ['/api/machines/delegated-requests', json({ purpose: 'authorization', machineId, capabilityId })];
}

export function createCatalogRequest(machineId: string, projectId: string): [string, RequestInit] {
  return ['/api/machines/delegated-requests', json({ purpose: 'catalog', machineId, projectId })];
}

export function listDelegatedRequests(): [string, RequestInit] {
  return ['/api/machines/delegated-requests', { credentials: 'same-origin' }];
}

export function getDelegatedRequest(requestId: string): [string, RequestInit] {
  return [`/api/machines/delegated-requests/${encodeURIComponent(requestId)}`, { credentials: 'same-origin' }];
}

export function reissueDelegatedRequest(requestId: string): [string, RequestInit] {
  return [`/api/machines/delegated-requests/${encodeURIComponent(requestId)}/reissue`, json({})];
}

export function revokeDelegatedRequest(requestId: string): [string, RequestInit] {
  return [`/api/machines/delegated-requests/${encodeURIComponent(requestId)}`, {
    method: 'DELETE', credentials: 'same-origin',
  }];
}

export function listLocalDelegatedRequests(): [string, RequestInit] {
  return ['/api/nodes/delegated-requests', { credentials: 'same-origin' }];
}

export function approveLocalDelegatedRequest(
  requestId: string,
  projectId: string,
  localPersonId: string,
): [string, RequestInit] {
  return [`/api/nodes/delegated-requests/${encodeURIComponent(requestId)}/approve`, json({ projectId, localPersonId })];
}

export function denyLocalDelegatedRequest(requestId: string): [string, RequestInit] {
  return [`/api/nodes/delegated-requests/${encodeURIComponent(requestId)}/deny`, json({})];
}

export function revokeLocalDelegatedAuthorization(requestId: string): [string, RequestInit] {
  return [`/api/nodes/delegated-requests/${encodeURIComponent(requestId)}`, {
    method: 'DELETE', credentials: 'same-origin',
  }];
}

/** A credential is deliberately not part of either browser shape. Keep the
 * parser narrow so an accidental server regression cannot leak it into state. */
export function delegatedRequest(raw: unknown): DelegatedMachineRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id : typeof row.requestId === 'string' ? row.requestId : '';
  const purpose = row.purpose === 'catalog' ? 'catalog' : 'authorization';
  const capabilityId = typeof row.capabilityId === 'string' ? row.capabilityId : undefined;
  if (!id || (purpose === 'authorization' && !capabilityId) || typeof row.state !== 'string') return null;
  const allowed: DelegatedRequestState[] = ['pending', 'approved', 'active', 'denied', 'expired', 'revoked', 'failed'];
  if (!allowed.includes(row.state as DelegatedRequestState)) return null;
  const text = (key: string) => typeof row[key] === 'string' ? row[key] as string : undefined;
  return {
    id,
    purpose,
    ...(capabilityId ? { capabilityId } : {}),
    state: row.state as DelegatedRequestState,
    machineId: text('machineId'),
    code: text('code'),
    repositoryKey: text('repositoryKey'),
    repositoryName: text('repositoryName'),
    subjectName: text('subjectName'),
    originName: text('originName'),
    requestedBy: text('requestedBy'),
    model: text('model'),
    effort: text('effort'),
    expiresAt: typeof row.expiresAt === 'number' ? row.expiresAt : null,
    maxDurationMinutes: typeof row.maxDurationMinutes === 'number' ? row.maxDurationMinutes : undefined,
    ...(text('authorizationId') ? { authorizationId: text('authorizationId') } : {}),
    ...(text('localProjectId') ? { localProjectId: text('localProjectId') } : {}),
    ...(text('localPersonId') ? { localPersonId: text('localPersonId') } : {}),
  };
}

export function delegatedRequests(raw: unknown): DelegatedMachineRequest[] {
  const rows = raw && typeof raw === 'object' && Array.isArray((raw as { requests?: unknown }).requests)
    ? (raw as { requests: unknown[] }).requests
    : [];
  return rows.map(delegatedRequest).filter((row): row is DelegatedMachineRequest => row !== null);
}

export function delegatedRequestStatus(raw: unknown, prior: DelegatedMachineRequest): DelegatedMachineRequest {
  const request = raw && typeof raw === 'object' ? (raw as { request?: unknown }).request : null;
  return delegatedRequest(request && typeof request === 'object'
    ? { ...(request as Record<string, unknown>), purpose: prior.purpose, capabilityId: prior.capabilityId }
    : null) ?? prior;
}
