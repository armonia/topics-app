import { describe, expect, test } from 'bun:test';
import { pickPlanComment } from './planPanel';
import type { TaskComment } from '../../lib/board';

const PIANO = '```question\nIl piano: tre passi, poi la barra.\n- Approva il piano\n- Rifai\n```';

const c = (over: Partial<TaskComment> & { id: string }): TaskComment => ({
  author: 'claude',
  content: PIANO,
  createdAt: '2026-08-14T10:00:00Z',
  kind: 'comment',
  media: null,
  mentions: null,
  ...over,
} as TaskComment);

const task = (over: Partial<{ planFirst: boolean; planCommentId: string | null; status: string }> = {}) => ({
  planFirst: true,
  planCommentId: null,
  status: 'in_progress',
  ...over,
});

describe('pickPlanComment', () => {
  test('senza `planFirst` non c\'è nessun piano da mostrare', () => {
    expect(pickPlanComment(task({ planFirst: false }), [c({ id: 'a' })])).toBeNull();
  });

  test('il PUNTATORE vince, anche se dopo è arrivata una rettifica', () => {
    const piano = c({ id: 'vero' });
    const dopo = c({ id: 'rettifica' });
    const got = pickPlanComment(task({ planCommentId: 'vero' }), [piano, dopo]);
    expect(got?.id).toBe('vero');
  });

  test('senza puntatore, su una card VIVA, si ripesca l\'ultimo che offre l\'approvazione', () => {
    const vecchio = c({ id: 'vecchio' });
    const nuovo = c({ id: 'nuovo' });
    const chiacchiera = c({ id: 'chiacchiera', content: 'niente domande qui' });
    expect(pickPlanComment(task(), [vecchio, nuovo, chiacchiera])?.id).toBe('nuovo');
  });

  test('senza puntatore, su una card DONE, il pannello non esiste', () => {
    // È il difetto segnalato: «un task mostra un piano di due righe che non
    // serve a niente». Su una card chiusa il piano è storia, e la storia sta
    // nel thread senza fingere di essere una decisione da prendere.
    expect(pickPlanComment(task({ status: 'done' }), [c({ id: 'a' })])).toBeNull();
    expect(pickPlanComment(task({ status: 'archived' }), [c({ id: 'a' })])).toBeNull();
  });

  test('col PUNTATORE il pannello resta anche su una card done: quel piano è suo per nome', () => {
    // Il confine vale per la RICADUTA, non per il fatto dichiarato dal server:
    // un piano puntato è la consegna di quella card, e sparire sarebbe perdere
    // un pezzo di consegna appena la card si chiude.
    const got = pickPlanComment(task({ status: 'done', planCommentId: 'p' }), [c({ id: 'p' })]);
    expect(got?.id).toBe('p');
  });

  test('un commento di sistema o dell\'umano non è mai un piano', () => {
    expect(pickPlanComment(task(), [c({ id: 'a', author: 'system' }), c({ id: 'b', author: 'user' })])).toBeNull();
  });
});
