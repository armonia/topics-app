import { describe, test, expect, afterAll } from 'bun:test';
import { boardApi, type BoardProjectRef } from './board';

/**
 * A PROJECT CREATED BEFORE THE INDEX DOES NOT BECOME THE INDEX.
 *
 * With the first fetch failed `projects` stays `null`, and every recovery path
 * looks at exactly that `null`. `addBoardProject` wrote `[p]`: from then on the
 * index was that one project for the life of the document, and the picker
 * offered no other. The project must wait for the answer and join it.
 *
 * Fresh module instance (query in the specifier): the state is global and
 * another file in the same process may already have loaded it.
 *
 * @covers KANBAN-02
 */
const realProjects = boardApi.projects;
afterAll(() => { boardApi.projects = realProjects; });

const ref = (projectId: string): BoardProjectRef => ({ projectId, name: projectId, path: `/p/${projectId}` });

describe('addBoardProject before the index arrives', () => {
  test('the created project joins the server list instead of replacing it', async () => {
    let calls = 0;
    boardApi.projects = (async () => {
      calls++;
      if (calls === 1) throw new Error('server down');
      return { projects: [ref('alfa'), ref('beta')], newProjectDir: null };
    }) as typeof boardApi.projects;
    const store = await import(`./boardProjectsStore?recovery=${Math.random()}`) as typeof import('./boardProjectsStore');
    const unsub = store.subscribeBoardProjects(() => {});
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(store.getBoardProjects()).toBeNull();

    store.addBoardProject(ref('fresh'));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(store.getBoardProjects()?.map((p) => p.projectId)).toEqual(['alfa', 'beta', 'fresh']);
    unsub();
  });
});
