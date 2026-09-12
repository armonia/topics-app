/** @covers GUEST-18 */
import { describe, expect, test } from 'bun:test';
import { guestPairingPeople, pairingApprovalBody } from './pairingPerson';

describe('pairing identity choice', () => {
  test('an existing person keeps their identity and creates no duplicate', () => {
    expect(pairingApprovalBody('request-one', { personId: 'person-one' }))
      .toEqual({ requestId: 'request-one', personId: 'person-one' });
  });

  test('the someone-else picker never offers an installation owner', () => {
    expect(guestPairingPeople([
      { id: 'owner-one', name: 'Owner', owner: true },
      { id: 'person-one', name: 'Collaborator', owner: false },
    ])).toEqual([{ id: 'person-one', name: 'Collaborator', owner: false }]);
  });
});
