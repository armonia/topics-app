/**
 * Il carve-out sulle BOZZE, fissato dai due lati.
 *
 * Il gesto «condividi questa chat» non si offre su una `draft:`: quella chat
 * non ha ancora una riga sul server, e nulla a valle rimedia — `POST
 * /api/auth/shares` valida il tipo di risorsa, il tipo di soggetto e il
 * confinamento del soggetto, ma non guarda MAI se la risorsa esiste. Una
 * concessione verso `draft:xyz` viene scritta e sopravvive all'id buttato.
 *
 * Prima esisteva solo la copertura E2E sulla PRESENZA del controllo (GUEST-07):
 * togliere la condizione sulle bozze non faceva fallire niente. Qui la
 * condizione ha il suo test, e il caso «topic vera» è il controllo positivo che
 * dimostra che il canale di osservazione funziona — senza, «è assente» passerebbe
 * anche con un componente che non rende mai nulla.
 *
 * Niente renderer e niente DOM: jsdom/happy-dom non sono dipendenze del progetto
 * (stessa scelta di lib/haptics.test.ts e lib/openTaskLink.test.ts).
 * `TopicShareAction` non usa hook e non tocca il documento, quindi è una funzione
 * pura di props: la si chiama e si guarda l'albero che restituisce.
 *
 * @covers GUEST-07
 */
import { describe, test, expect } from 'bun:test';

import type { Topic } from '../../types';
import { buildTopicSettingsUpdate, TopicShareAction } from './TopicSettingsModal';
import { ShareControl } from '../Share/ShareControl';

function makeTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: 'topic-abc123',
    name: 'Ordinary topic',
    slug: 'ordinary-topic',
    parentId: null,
    links: [],
    sessionKey: 'topic:abc123',
    color: '#5865f2',
    icon: 'MessageSquare',
    createdAt: '2026-09-04T11:00:00.000Z',
    updatedAt: '2026-09-04T11:00:00.000Z',
    archived: false,
    ...overrides,
  };
}

describe('TopicShareAction', () => {
  // CONTROLLO POSITIVO. Se questo si rompe, l'asserzione negativa sotto non
  // vale più niente: un componente che restituisce sempre `null` la farebbe
  // passare lo stesso.
  test('una topic vera offre il controllo di condivisione, sulla risorsa giusta', () => {
    const reso = TopicShareAction({ topicId: 'topic-abc123' });

    expect(reso).not.toBeNull();
    // Lo STESSO controllo delle schede, non un secondo pannello che dice la
    // stessa cosa in un altro modo.
    expect(reso?.type).toBe(ShareControl);
    expect(reso?.props).toMatchObject({ resourceType: 'topic', resourceId: 'topic-abc123' });
    // Il permalink arriva come FUNZIONE: comporlo legge `window.location`, e
    // questo test gira senza DOM proprio per poter provare la guardia sulle
    // bozze senza montare niente.
    expect(typeof (reso?.props as { deepLink?: unknown }).deepLink).toBe('function');
  });

  test('una BOZZA non lo offre: la concessione atterrerebbe su un id che sta per essere buttato', () => {
    expect(TopicShareAction({ topicId: 'draft:abc123' })).toBeNull();
  });

  // La soglia è il PREFISSO, non la parola: un id che comincia per «draft» ma
  // non è una bozza resta una topic vera e condivisibile.
  test('«draft» senza i due punti non è una bozza', () => {
    const reso = TopicShareAction({ topicId: 'drafty-1' });

    expect(reso).not.toBeNull();
    expect(reso?.props).toMatchObject({ resourceType: 'topic', resourceId: 'drafty-1' });
  });
});

describe('buildTopicSettingsUpdate', () => {
  const everySetting = {
    name: 'Renamed coordinator',
    color: '#f97316',
    projectPath: ' /a/project ',
    systemPrompt: 'Do unrelated work',
    promptLoaded: true,
    contextFiles: ['/a/project/CONTEXT.md'],
    provider: 'claude-code',
    muted: true,
    autonomy: 'yolo' as const,
  };

  test('global coordinator can only persist its presentation settings', () => {
    const update = buildTopicSettingsUpdate(makeTopic({
      isGlobalOrchestrator: true,
      projectPath: '/existing/project',
      provider: 'codex',
      systemPrompt: 'server-owned prompt',
      contextFiles: ['/existing/CONTEXT.md'],
      autonomyLevel: 'ask',
    }), everySetting);

    expect(update).toEqual({
      name: 'Renamed coordinator',
      color: '#f97316',
      muted: true,
    });
    expect(update).not.toHaveProperty('projectPath');
    expect(update).not.toHaveProperty('systemPrompt');
    expect(update).not.toHaveProperty('contextFiles');
    expect(update).not.toHaveProperty('provider');
    expect(update).not.toHaveProperty('autonomyLevel');
  });

  test('the coordinator omits the prompt and provider even once the single-topic read has landed', () => {
    const update = buildTopicSettingsUpdate(
      makeTopic({ isGlobalOrchestrator: true, provider: 'codex', systemPrompt: 'server-owned prompt' }),
      { ...everySetting, promptLoaded: true },
    );
    expect(update).toEqual({ name: 'Renamed coordinator', color: '#f97316', muted: true });
  });

  test('ordinary topics retain their normal operational settings payload', () => {
    expect(buildTopicSettingsUpdate(makeTopic(), everySetting)).toEqual({
      name: 'Renamed coordinator',
      color: '#f97316',
      muted: true,
      projectPath: '/a/project',
      systemPrompt: 'Do unrelated work',
      contextFiles: ['/a/project/CONTEXT.md'],
      provider: 'claude-code',
      autonomyLevel: 'yolo',
    });
  });

  // The list shape does not carry the prompt: until the single-topic read
  // lands, the PATCH must leave the column alone instead of erasing it.
  test('an ordinary topic whose prompt has not loaded yet sends no systemPrompt at all', () => {
    const update = buildTopicSettingsUpdate(makeTopic(), { ...everySetting, promptLoaded: false });
    expect(update).not.toHaveProperty('systemPrompt');
    expect(update).toMatchObject({ projectPath: '/a/project', provider: 'claude-code', autonomyLevel: 'yolo' });
  });
});
