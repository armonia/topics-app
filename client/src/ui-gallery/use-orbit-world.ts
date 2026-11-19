/**
 * Chooses SARIM as the world of the entry. Imported first by the entries that
 * run on SARIM (`main.tsx`, `app-main.tsx`, `sarim-main.tsx`): an ES module runs
 * before the ones imported after it, so the copy and the screens that read the
 * world while they load already find it. The Consorzio entry does the same
 * with its own world (`consorzio-main.tsx`), and never loads this file.
 */
import { SARIM_WORLD } from '../ui/fixtures/sarim-org/world';
import { setWorld } from './sarim/world';

setWorld(SARIM_WORLD);
