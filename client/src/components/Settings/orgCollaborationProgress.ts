type SubjectType = 'device' | 'person' | 'org';

interface PersonRow {
  id: string;
  owner?: boolean;
  blocked?: boolean;
}

interface DeviceRow {
  id?: string;
  revokedAt?: number | null;
  person?: { id: string } | null;
}

interface SubjectGrant {
  subjectType: SubjectType;
  subjectId: string;
  revokedAt?: number | null;
  expiresAt?: number | null;
}

interface ProjectAccess {
  shares: SubjectGrant[];
  starts: SubjectGrant[];
}

export interface CollaborationProgress {
  person: boolean;
  device: boolean;
  shared: boolean;
  start: boolean;
}

/** Derive the checklist from the people represented by the selected identity page. */
export function collaborationProgress(input: {
  orgId: string | null;
  directoryPeople: PersonRow[];
  members: PersonRow[];
  devices: DeviceRow[];
  projects: ProjectAccess[];
  now?: number;
}): CollaborationProgress {
  const now = input.now ?? Date.now();
  const people = input.orgId ? input.members : input.directoryPeople;
  const personIds = new Set(people.filter((person) => !person.owner && !person.blocked).map((person) => person.id));
  const deviceIds = new Set(input.devices
    .filter((device) => !device.revokedAt && !!device.person?.id && personIds.has(device.person.id))
    .map((device) => device.id)
    .filter((id): id is string => !!id));

  const belongsToSelection = (grant: SubjectGrant): boolean => {
    if (grant.revokedAt || grant.expiresAt && grant.expiresAt <= now) return false;
    if (grant.subjectType === 'org') return !!input.orgId && grant.subjectId === input.orgId;
    if (grant.subjectType === 'person') return personIds.has(grant.subjectId);
    return deviceIds.has(grant.subjectId);
  };

  return {
    person: personIds.size > 0,
    device: deviceIds.size > 0,
    shared: input.projects.some((project) => project.shares.some(belongsToSelection)),
    start: input.projects.some((project) => project.starts.some(belongsToSelection)),
  };
}
