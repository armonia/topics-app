/**
 * Every area of the ORBIT edition, in sidebar order. Areas never import each
 * other: they link by address (`paths.ts`) and read the same world through
 * `model/` and `client/src/ui/fixtures/orbit-org/`.
 */
import type { AreaModule } from '../app/kit';
import { ORBIT_INBOX_AREA } from './screens/inbox';
import { ORBIT_FLOWS_AREA } from './screens/flows';
import { ORBIT_CONTRACTS_AREA } from './screens/contracts';
import { ORBIT_DATA_AREA } from './screens/data';
import { ORBIT_KNOWLEDGE_AREA } from './screens/knowledge';
import { ORBIT_PROGRAMS_AREA } from './screens/programs';
import { ORBIT_TEAM_AREA } from './screens/team';
import { ORBIT_SETTINGS_AREA } from './screens/settings';
import { ORBIT_CHAT_AREA } from './screens/chat';
import { ORBIT_SEARCH_AREA } from './search';

export const ORBIT_AREAS: AreaModule[] = [
  ORBIT_INBOX_AREA, ORBIT_FLOWS_AREA, ORBIT_CONTRACTS_AREA, ORBIT_DATA_AREA,
  ORBIT_KNOWLEDGE_AREA, ORBIT_PROGRAMS_AREA, ORBIT_TEAM_AREA, ORBIT_SETTINGS_AREA, ORBIT_CHAT_AREA, ORBIT_SEARCH_AREA,
];
