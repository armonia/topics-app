/**
 * Una voce sola per evento — la regola che impedisce il doppione dal giorno in
 * cui un dispositivo si iscrive davvero al push.
 *
 * @covers CMD-02
 */
import { describe, expect, test } from 'bun:test';
import { inPageBannerAllowed, PUSH_COVERED_EVENTS, type NotifyEventKind } from './pushVoice';

describe('inPageBannerAllowed', () => {
  test('senza iscrizione la pagina parla per tutto: è l\'unica voce che esiste', () => {
    const every: NotifyEventKind[] = ['task:review-ready', 'task:parked', 'message:new', 'session:state'];
    for (const e of every) expect(inPageBannerAllowed(false, e)).toBe(true);
  });

  test('con iscrizione la pagina tace sugli eventi che il push annuncia', () => {
    expect(inPageBannerAllowed(true, 'task:review-ready')).toBe(false);
    expect(inPageBannerAllowed(true, 'task:parked')).toBe(false);
    // Gemello lato server di `stream:end`: stesso fatto per l'utente, quindi
    // due banner direbbero due volte la stessa cosa.
    expect(inPageBannerAllowed(true, 'message:new')).toBe(false);
  });

  test('un evento che il push NON manda continua a passare dalla pagina', () => {
    // `session:state` sono i segnali dei terminali: silenziarli «tanto c\'è il
    // push» li perderebbe senza che nessuno lo dica.
    expect(PUSH_COVERED_EVENTS.has('session:state')).toBe(false);
    expect(inPageBannerAllowed(true, 'session:state')).toBe(true);
  });
});
