/**
 * `describeNativeNotifications` — la frase che il pannello Impostazioni mostra
 * al posto della vecchia promessa.
 *
 * Prima c'era scritto, sempre e comunque, "Toast in-window + native macOS
 * notification when an agent finishes". Su una build non firmata da Apple è
 * falso: macOS 26 nega l'autorizzazione senza nemmeno chiedere, l'app non
 * compare in Impostazioni di sistema → Notifiche, e la catena cade in silenzio
 * in tre punti diversi (fuori dal bundle / non autorizzati / nessun carrier di
 * ripiego). Da fuori è indistinguibile da "non c'era niente da notificare".
 *
 * Questi test inchiodano che ognuno dei tre punti ha una frase SUA, e che
 * nessuno di essi finisce per dire che va tutto bene.
 */
import { describe, test, expect } from 'bun:test';
import { describeNativeNotifications } from './notificationStatus';
import type { NativeNotificationStatus } from './shell/app';

const mac = (over: Partial<NativeNotificationStatus> = {}): NativeNotificationStatus => ({
  platform: 'macos',
  bundled: true,
  authorized: false,
  authState: 'pending',
  helper: null,
  logPath: '/Users/x/Library/Logs/topics-notifications.log',
  ...over,
});

describe('describeNativeNotifications', () => {
  test('autorizzati → i banner arrivano, e non c’è niente da fare', () => {
    const v = describeNativeNotifications(mac({ authorized: true, authState: 'granted' }));
    expect(v.health).toBe('ok');
    expect(v.hint).toBe(null);
  });

  test('non autorizzati ma col carrier → degradato, NON "ok"', () => {
    const v = describeNativeNotifications(mac({ helper: '/opt/homebrew/bin/terminal-notifier' }));
    expect(v.health).toBe('degraded');
    expect(v.headline).toContain('terminal-notifier');
    // Deve spiegare PERCHÉ Topics non compare in Impostazioni di sistema:
    // è la domanda che uno si fa guardando il banner col nome sbagliato.
    expect(v.hint).toContain('Impostazioni di sistema');
  });

  test('né autorizzati né carrier → rotto, ed è il caso che era invisibile', () => {
    const v = describeNativeNotifications(mac());
    expect(v.health).toBe('broken');
    expect(v.headline).toContain('NON arrivano');
    // Il toast in finestra resta: va detto, o sembra che non funzioni nulla.
    expect(v.hint).toContain('toast in finestra');
  });

  test('negato esplicitamente → indica il pannello di sistema, non la firma', () => {
    const v = describeNativeNotifications(mac({ authState: 'denied' }));
    expect(v.health).toBe('broken');
    expect(v.hint).toContain('negate');
  });

  test('fuori dal bundle → lo dice, e chiarisce che riguarda solo lo sviluppo', () => {
    const v = describeNativeNotifications(mac({ bundled: false }));
    expect(v.health).toBe('broken');
    expect(v.hint).toContain('sviluppo');
  });

  test('nessuno stato (web/PWA) → non è questa catena', () => {
    const v = describeNativeNotifications(null);
    expect(v.health).toBe('unknown');
    expect(v.headline).toContain('browser');
  });

  test('windows/linux → nessuna diagnosi inventata', () => {
    for (const platform of ['windows', 'linux'] as const) {
      const v = describeNativeNotifications(mac({ platform }));
      expect(v.health).toBe('unknown');
      expect(v.hint).toBe(null);
    }
  });

  test('nessuno stato dichiara "ok" senza essere autorizzato', () => {
    const nonAutorizzati: NativeNotificationStatus[] = [
      mac(),
      mac({ helper: '/usr/local/bin/terminal-notifier' }),
      mac({ authState: 'denied' }),
      mac({ bundled: false }),
      mac({ platform: 'windows' }),
    ];
    for (const s of nonAutorizzati) {
      expect(describeNativeNotifications(s).health).not.toBe('ok');
    }
  });
});
