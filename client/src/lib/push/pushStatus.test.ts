/**
 * Lo stato detto per intero.
 *
 * Il punto della card: «non iscritto», «negato dal sistema» e «su iPhone serve
 * la PWA installata» producono lo stesso silenzio, e finora si vedevano uguali.
 * Qui si misura che sono TRE stati distinti, con tre rimedi distinti, e che
 * l'interruttore compare solo dove premerlo fa qualcosa.
 *
 * @covers CMD-02
 *
 * Partial, with a sharp boundary. CMD-02 has eleven scenarios: the first four
 * are STATES (unsupported, denied, default with no subscription, already
 * subscribed) and they are here; the environment sensing that produces them is
 * in `environment.test.ts`. The remaining seven are the subscribe/unsubscribe
 * FLOWS — VAPID key exchange, registering with the server, unsubscribing —
 * which live in the hook and are not proven yet.
 */
import { describe, expect, test } from 'bun:test';
import { describePushState, type PushEnvironment } from './pushStatus';

const base: PushEnvironment = {
  capable: true,
  permission: 'default',
  subscribed: false,
  nativeShell: false,
  iosNeedsInstall: false,
};

describe('describePushState', () => {
  test('non iscritto: si può attivare, e si dice cosa manca', () => {
    const v = describePushState(base);
    expect(v.health).toBe('off');
    expect(v.reason).toBe('not-subscribed');
    expect(v.canSubscribe).toBe(true);
  });

  test('permesso concesso ma nessuna registrazione — il caso più insidioso', () => {
    // Il browser non chiederà più niente: l'utente crede di aver detto sì e non
    // capisce perché tace. Lo stato deve dire che manca la REGISTRAZIONE.
    const v = describePushState({ ...base, permission: 'granted' });
    expect(v.health).toBe('off');
    expect(v.canSubscribe).toBe(true);
    expect(v.hint).toContain('registrazione');
  });

  test('iscritto', () => {
    const v = describePushState({ ...base, permission: 'granted', subscribed: true });
    expect(v.health).toBe('on');
    expect(v.reason).toBe('subscribed');
    expect(v.canSubscribe).toBe(false);
  });

  test('negato dal sistema: nessun interruttore, e si dice DOVE si rimedia', () => {
    const v = describePushState({ ...base, permission: 'denied' });
    expect(v.health).toBe('blocked');
    expect(v.reason).toBe('denied');
    // Un interruttore premibile qui prometterebbe una cosa che il sistema ha
    // già deciso di non concedere.
    expect(v.canSubscribe).toBe(false);
    expect(v.headline).toContain('Negato dal sistema');
    expect(v.hint.length).toBeGreaterThan(0);
  });

  test('iPhone senza PWA installata NON è «non supportato»: ha un rimedio', () => {
    // `capable: false` è la fotografia vera di quel caso (PushManager non
    // esiste), ed è proprio per questo che il ramo va provato PRIMA.
    const v = describePushState({ ...base, capable: false, permission: 'unsupported', iosNeedsInstall: true });
    expect(v.reason).toBe('ios-needs-install');
    expect(v.hint).toContain('Home');
    expect(v.canSubscribe).toBe(false);
  });

  test('guscio desktop: il push non c\'entra, e lo dice invece di fingere un errore', () => {
    const v = describePushState({ ...base, nativeShell: true, permission: 'unsupported', capable: false });
    expect(v.reason).toBe('native-shell');
    expect(v.canSubscribe).toBe(false);
  });

  test('browser senza push: nessun rimedio, e nessuna riga che ne inventi uno', () => {
    const v = describePushState({ ...base, capable: false });
    expect(v.reason).toBe('unsupported');
    expect(v.hint).toBe('');
    expect(v.canSubscribe).toBe(false);
  });
});
