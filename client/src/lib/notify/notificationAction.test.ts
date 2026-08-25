/**
 * What the app does when a notification is acted on.
 *
 * @covers CMD-02
 */
import { describe, test, expect } from 'bun:test';
import { runNotificationAction, type NotificationActionDeps } from './notificationAction';
import { buildNotifyActions } from '../../../../shared/notify-actions';

function harness(over?: Partial<NotificationActionDeps>) {
  const sent: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const deps: NotificationActionDeps = {
    resolveProjectId: async () => 'proj-x',
    send: async (req) => { sent.push(req); return true; },
    openTask: (id) => { opened.push(id); },
    ...over,
  };
  return { deps, sent, opened };
}

/** L'id del tasto lo compone il contratto condiviso, non il test a mano. */
const ANSWER = buildNotifyActions({ kind: 'review-ready', question: { options: ['Landa su main'] } })[0].id;

describe('runNotificationAction', () => {
  test("rispondere è il reject che porta il testo — la chiamata della card", async () => {
    const { deps, sent, opened } = harness();
    expect(await runNotificationAction('t9', ANSWER, deps)).toBe('executed');
    expect(sent).toEqual([{
      method: 'POST',
      path: '/api/boards/proj-x/tasks/t9/review',
      body: { decision: 'reject', comment: 'Landa su main' },
    }]);
    // Eseguito = niente app in faccia: è il senso del tasto.
    expect(opened).toEqual([]);
  });

  test('approva e rimetti-in-coda passano dagli endpoint della board', async () => {
    const { deps, sent } = harness();
    expect(await runNotificationAction('t9', 'approve', deps)).toBe('executed');
    expect(await runNotificationAction('t9', 'requeue', deps)).toBe('executed');
    expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/boards/proj-x/tasks/t9/review',
      'PATCH /api/boards/proj-x/tasks/t9',
    ]);
    expect(sent[1].body).toEqual({ status: 'todo' });
  });

  test('server che rifiuta → si apre il task, il click non si perde', async () => {
    const { deps, opened } = harness({ send: async () => false });
    expect(await runNotificationAction('t9', 'approve', deps)).toBe('opened');
    expect(opened).toEqual(['t9']);
  });

  test('rete che esplode → stesso ripiego', async () => {
    const { deps, opened } = harness({ send: async () => { throw new Error('offline'); } });
    expect(await runNotificationAction('t9', 'approve', deps)).toBe('opened');
    expect(opened).toEqual(['t9']);
  });

  test('progetto non risolvibile → si apre il task invece di comporre una rotta rotta', async () => {
    const { deps, sent, opened } = harness({ resolveProjectId: async () => null });
    expect(await runNotificationAction('t9', 'approve', deps)).toBe('opened');
    expect(sent).toEqual([]);
    expect(opened).toEqual(['t9']);
    const boom = harness({ resolveProjectId: async () => { throw new Error('server giù'); } });
    expect(await runNotificationAction('t9', 'approve', boom.deps)).toBe('opened');
  });

  test("uno SCARTO non apre l'app: gli id che non sono nostri si ignorano", async () => {
    // macOS riusa `actionIdentifier` per il click sul corpo e per lo scarto
    // della notifica. Aprire il task su uno scarto sarebbe l'app che si
    // spalanca proprio quando hai detto di no.
    const { deps, sent, opened } = harness();
    for (const id of [
      'com.apple.UNNotificationDismissActionIdentifier',
      'com.apple.UNNotificationDefaultActionIdentifier',
      '',
      'answer:',
    ]) {
      expect(await runNotificationAction('t9', id, deps)).toBe('ignored');
    }
    expect(sent).toEqual([]);
    expect(opened).toEqual([]);
  });

  test('senza taskId non si fa niente', async () => {
    const { deps, sent, opened } = harness();
    expect(await runNotificationAction('', 'approve', deps)).toBe('ignored');
    expect(sent).toEqual([]);
    expect(opened).toEqual([]);
  });
});
