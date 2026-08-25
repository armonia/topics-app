/**
 * @covers MISSION-01
 */
import { describe, expect, test } from 'bun:test';
import { MISSIONS, missionPrompt } from './missions';
import { pickMissionSession } from './missionTarget';
import type { Topic } from '@/types';

describe('le missioni', () => {
  test('ogni preset dice come si sa che è finita — è ciò che lo distingue da un prompt', () => {
    for (const m of MISSIONS) {
      expect(m.doneWhen.trim().length).toBeGreaterThan(0);
      expect(m.bar.join(' ').trim().length).toBeGreaterThan(0);
    }
  });

  test('la barra finisce NEL testo che arriva alla sessione, non solo nel menu', () => {
    for (const m of MISSIONS) {
      const text = missionPrompt(m, 'topics-app');
      expect(text).toContain('COME SI SA CHE È FINITA');
      for (const line of m.bar) expect(text).toContain(line);
      expect(text).toContain(m.name);
      expect(text).toContain('topics-app');
    }
  });

  test('gli id sono unici: il menu ci fa la key e l\'e2e ci punta', () => {
    const ids = MISSIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

const PROJ = '/Users/x/Projects/topics-app';

function topic(over: Partial<Topic> & { id: string }): Topic {
  return {
    name: over.id, slug: over.id, parentId: null, links: [],
    sessionKey: `sk-${over.id}`, color: '', icon: '', createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z', archived: false, projectPath: PROJ,
    ...over,
  } as Topic;
}

describe('a quale sessione va una missione', () => {
  const groups = (activePaneId: string, paneIds: string[]) => [{ id: 'g1', paneIds, activePaneId }];

  test('la chat a fuoco vince', () => {
    const picked = pickMissionSession({
      projectPath: PROJ,
      topics: { a: topic({ id: 'a' }), b: topic({ id: 'b' }) },
      panes: [{ id: 'p-a', type: 'chat', topicId: 'a' }, { id: 'p-b', type: 'chat', topicId: 'b' }],
      groups: groups('p-b', ['p-a', 'p-b']),
      focusedGroupId: 'g1',
    });
    expect(picked).toBe('b');
  });

  test('MAI una sessione d\'agente della board: dirottarla sporcherebbe la card che sta lavorando', () => {
    const picked = pickMissionSession({
      projectPath: PROJ,
      topics: {
        agent: topic({ id: 'agent', mcpPolicy: 'bridge-only' }),
        umana: topic({ id: 'umana' }),
      },
      panes: [{ id: 'p-agent', type: 'chat', topicId: 'agent' }, { id: 'p-umana', type: 'chat', topicId: 'umana' }],
      groups: groups('p-agent', ['p-agent', 'p-umana']),
      focusedGroupId: 'g1',
    });
    expect(picked).toBe('umana');
  });

  test('niente chat aperte: la chat del progetto toccata più di recente', () => {
    const picked = pickMissionSession({
      projectPath: PROJ,
      topics: {
        vecchia: topic({ id: 'vecchia', updatedAt: '2026-08-01T00:00:00Z' }),
        recente: topic({ id: 'recente', updatedAt: '2026-08-10T00:00:00Z' }),
        altrove: topic({ id: 'altrove', updatedAt: '2026-08-11T00:00:00Z', projectPath: '/altro' }),
        archiviata: topic({ id: 'archiviata', updatedAt: '2026-08-11T00:00:00Z', archived: true }),
      },
      panes: [{ id: 'p-kanban', type: 'kanban' }],
      groups: groups('p-kanban', ['p-kanban']),
      focusedGroupId: 'g1',
    });
    expect(picked).toBe('recente');
  });

  test('nessun bersaglio → null, e chi chiama lo dice invece di inventarsi una sessione', () => {
    const picked = pickMissionSession({
      projectPath: PROJ,
      topics: { altrove: topic({ id: 'altrove', projectPath: '/altro' }) },
      panes: [],
      groups: [],
      focusedGroupId: null,
    });
    expect(picked).toBeNull();
  });
});
