/**
 * Every area of the preview. The container matches the address against the
 * places of all of them (static segments first), and search asks each one.
 */
import type { AreaModule } from './kit';
import { WORK_AREA } from './screens/work';
import { FLOW_BUILD_AREA } from './screens/flow-build';
import { FLOW_RUN_AREA } from './screens/flow-run';
import { TEAM_AREA } from './screens/team';
import { SETTINGS_AREA } from './screens/settings';
import { DATA_AREA } from './screens/data-more';
import { KNOWLEDGE_AREA } from './screens/knowledge-more';
import { VIEWS_AREA } from './screens/views-more';
import { PROGRAMS_AREA } from './screens/programs';
import { ORGS_AREA } from './screens/orgs';

export const AREAS: AreaModule[] = [WORK_AREA, FLOW_BUILD_AREA, FLOW_RUN_AREA, TEAM_AREA, SETTINGS_AREA, DATA_AREA, KNOWLEDGE_AREA, VIEWS_AREA, PROGRAMS_AREA, ORGS_AREA];
