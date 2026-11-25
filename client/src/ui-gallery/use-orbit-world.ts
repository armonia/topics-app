/**
 * Chooses ORBIT as the world of the entry. Imported first by the entries that
 * run on ORBIT (`main.tsx`, `app-main.tsx`, `orbit-main.tsx`): an ES module runs
 * before the ones imported after it, so the copy and the screens that read the
 * world while they load already find it. The Consorzio entry does the same
 * with its own world (`consorzio-main.tsx`), and never loads this file.
 */
import { ORBIT_WORLD } from '../ui/fixtures/orbit-org/world';
import { setWorld } from './orbit/world';

setWorld(ORBIT_WORLD);
