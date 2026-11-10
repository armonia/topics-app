/** The Consorzio edition of the preview (`consorzio.html`): the Consorzio di Nocera as the only organization. */
import { NOCERA_WORLD } from '../ui/fixtures/nocera-org/world';
import { makeOrgEdition } from './orbit/edition';

export const CONSORZIO_EDITION = makeOrgEdition(NOCERA_WORLD, { id: 'consorzio', storageKey: 'topics-consorzio-preview' });
