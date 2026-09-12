export interface PairingPerson {
  id: string;
  name: string;
  owner: boolean;
}

export type PairingIdentity = { personId: string } | { personName: string } | { mine: true };

export function guestPairingPeople(people: readonly PairingPerson[]): PairingPerson[] {
  return people.filter((person) => !person.owner);
}

export function pairingApprovalBody(requestId: string, identity: PairingIdentity): Record<string, string> {
  if ('personId' in identity) return { requestId, personId: identity.personId };
  if ('personName' in identity) return { requestId, personName: identity.personName };
  return { requestId };
}
