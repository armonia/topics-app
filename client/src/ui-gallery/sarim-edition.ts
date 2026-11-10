/** The SARIM edition of the preview (`sarim.html`): SARIM as the only organization. */
import { SARIM_WORLD } from '../ui/fixtures/sarim-org/world';
import { makeOrgEdition } from './sarim/edition';

export const SARIM_EDITION = makeOrgEdition(SARIM_WORLD, { id: 'sarim', storageKey: 'topics-sarim-preview' });
