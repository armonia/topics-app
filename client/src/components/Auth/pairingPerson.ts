export interface PairingPerson {
  id: string;
  name: string;
  owner: boolean;
}

/** `screen`: a monitor that shows the load page and nothing else, asked for by name (`server/lib/screen-scope.ts`). */
export type PairingIdentity = { personId: string } | { personName: string } | { mine: true } | { screen: true };

export function guestPairingPeople(people: readonly PairingPerson[]): PairingPerson[] {
  return people.filter((person) => !person.owner);
}

export function pairingApprovalBody(requestId: string, identity: PairingIdentity): Record<string, string> {
  if ('personId' in identity) return { requestId, personId: identity.personId };
  if ('personName' in identity) return { requestId, personName: identity.personName };
  if ('screen' in identity) return { requestId, scope: 'screen' };
  return { requestId };
}
