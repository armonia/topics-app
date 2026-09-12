/** @covers GUEST-13 @covers GUEST-18 */
import { describe, expect, test } from 'bun:test';
import {
  grantAgentStartRequest,
  liveAgentStartCapabilities,
  preferredAgentStartModel,
  revokeAgentStartRequest,
} from './agentStartPolicy';

describe('owner Agent Start policy requests', () => {
  test('the grant is separate from content access and fixes the execution policy', () => {
    const [url, init] = grantAgentStartRequest({
      projectId: 'project-one', subjectType: 'person', subjectId: 'person-one',
      machineId: 'node-one', model: 'model-one', effort: 'medium', maxDurationMinutes: 30,
    });
    expect(url).toBe('/api/auth/agent-start-capabilities');
    expect(JSON.parse(String(init.body))).toEqual({
      projectId: 'project-one', subjectType: 'person', subjectId: 'person-one',
      machineId: 'node-one', model: 'model-one', effort: 'medium', maxDurationMinutes: 30,
    });
    expect(String(init.body)).not.toContain('level');
  });

  test('revocation identifies both project and capability', () => {
    const [url, init] = revokeAgentStartRequest('project one', 'cap one');
    expect(url).toBe('/api/auth/agent-start-capabilities?projectId=project+one&capabilityId=cap+one');
    expect(init.method).toBe('DELETE');
  });

  test('expired and revoked capabilities disappear from the owner surface', () => {
    const live = { id: 'live', expiresAt: 101, revokedAt: null };
    expect(liveAgentStartCapabilities([
      live,
      { id: 'expired', expiresAt: 100, revokedAt: null },
      { id: 'revoked', expiresAt: 200, revokedAt: 99 },
    ], 100)).toEqual([live]);
  });

  test('project choice wins, otherwise model selection stays explicit', () => {
    const models = [{ id: 'expensive-model' }, { id: 'project-model' }];
    expect(preferredAgentStartModel(models, 'project-model')).toBe('project-model');
    expect(preferredAgentStartModel(models, 'offline-model')).toBe('');
    expect(preferredAgentStartModel(models, null)).toBe('');
  });
});
