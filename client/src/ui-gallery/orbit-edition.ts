/** The ORBIT edition of the preview (`orbit.html`): ORBIT as the only organization. */
import { ORBIT_WORLD } from '../ui/fixtures/orbit-org/world';
import { makeOrgEdition } from './orbit/edition';

export const ORBIT_EDITION = makeOrgEdition(ORBIT_WORLD, { id: 'orbit', storageKey: 'topics-orbit-preview' });
