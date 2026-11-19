/**
 * Every area of the SARIM edition, in sidebar order. Areas never import each
 * other: they link by address (`paths.ts`) and read the same world through
 * `model/` and `client/src/ui/fixtures/sarim-org/`.
 */
import type { AreaModule } from '../app/kit';
import { SARIM_INBOX_AREA } from './screens/inbox';
import { SARIM_FLOWS_AREA } from './screens/flows';
import { SARIM_CONTRACTS_AREA } from './screens/contracts';
import { SARIM_DATA_AREA } from './screens/data';
import { SARIM_KNOWLEDGE_AREA } from './screens/knowledge';
import { SARIM_PROGRAMS_AREA } from './screens/programs';
import { SARIM_TEAM_AREA } from './screens/team';
import { SARIM_SETTINGS_AREA } from './screens/settings';
import { SARIM_CHAT_AREA } from './screens/chat';
import { SARIM_SEARCH_AREA } from './search';

export const SARIM_AREAS: AreaModule[] = [
  SARIM_INBOX_AREA, SARIM_FLOWS_AREA, SARIM_CONTRACTS_AREA, SARIM_DATA_AREA,
  SARIM_KNOWLEDGE_AREA, SARIM_PROGRAMS_AREA, SARIM_TEAM_AREA, SARIM_SETTINGS_AREA, SARIM_CHAT_AREA, SARIM_SEARCH_AREA,
];
