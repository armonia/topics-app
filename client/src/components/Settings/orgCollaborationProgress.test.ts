/** @covers GUEST-18 */
import { describe, expect, test } from 'bun:test';
import { collaborationProgress } from './orgCollaborationProgress';

describe('organization collaboration checklist', () => {
  test('only grants for the selected organization or its people count', () => {
    expect(collaborationProgress({
      orgId: 'org-two',
      directoryPeople: [{ id: 'unrelated-person' }],
      members: [{ id: 'member-two' }],
      devices: [{ id: 'device-two', person: { id: 'member-two' } }],
      projects: [{
        shares: [{ subjectType: 'person', subjectId: 'unrelated-person' }],
        starts: [{ subjectType: 'org', subjectId: 'unrelated-org' }],
      }],
      now: 100,
    })).toEqual({ person: true, device: true, shared: false, start: false });
  });

  test('a pre-existing member progresses through share and live Agent Start without changing ownership', () => {
    expect(collaborationProgress({
      orgId: 'org-two',
      directoryPeople: [],
      members: [{ id: 'installation-owner', owner: true }, { id: 'member-two' }],
      devices: [{ id: 'device-two', person: { id: 'member-two' } }],
      projects: [{
        shares: [{ subjectType: 'person', subjectId: 'member-two' }],
        starts: [{ subjectType: 'person', subjectId: 'member-two', expiresAt: 200 }],
      }],
      now: 100,
    })).toEqual({ person: true, device: true, shared: true, start: true });
  });

  test('revoked devices and expired starts do not appear ready', () => {
    expect(collaborationProgress({
      orgId: 'org-two',
      directoryPeople: [],
      members: [{ id: 'member-two' }],
      devices: [{ id: 'device-two', person: { id: 'member-two' }, revokedAt: 90 }],
      projects: [{
        shares: [{ subjectType: 'device', subjectId: 'device-two' }],
        starts: [{ subjectType: 'person', subjectId: 'member-two', expiresAt: 99 }],
      }],
      now: 100,
    })).toEqual({ person: true, device: false, shared: false, start: false });
  });
});
