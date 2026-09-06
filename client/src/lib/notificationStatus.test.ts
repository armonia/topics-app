/**
 * `describeNativeNotifications` — la frase che il pannello Impostazioni mostra
 * al posto della vecchia promessa.
 *
 * Prima c'era scritto, sempre e comunque, "Toast in-window + native macOS
 * notification when an agent finishes". Può essere falso: la catena cade in
 * silenzio in tre punti diversi (fuori dal bundle / non autorizzati / nessun
 * carrier di ripiego), e da fuori è indistinguibile da "non c'era niente da
 * notificare".
 *
 * Questi test inchiodano che ognuno dei tre punti ha una frase SUA, e — la
 * parte che conta di più — che `health` risponde a UNA domanda sola: **i banner
 * arrivano?** Non «siamo autorizzati». Un canale che consegna non prende
 * un'icona d'allarme solo perché consegna per vie traverse.
 *
 *
 * `notificationPermissionAction` (at the end) is the decision behind the
 * button under the verdict: what pressing it does, and when it is not drawn.
 *
 * @covers CMD-02
 * @covers NOTIF-PERM-01
 */
import { describe, test, expect } from 'bun:test';
import { describeNativeNotifications, notificationPermissionAction } from './notificationStatus';
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

  // Questo caso diceva «degradato, NON ok», e la motivazione era: non siamo
  // autorizzati, quindi qualcosa non va. Era la domanda sbagliata. I banner
  // ARRIVANO — li consegna il carrier — e un'icona ambra permanente su un
  // canale che funziona insegna solo a ignorare le icone ambra. Il dettaglio
  // resta, ma come spiegazione: nel testo, non nel tono.
  test('non autorizzati ma col carrier → «ok»: i banner arrivano davvero', () => {
    const v = describeNativeNotifications(mac({ helper: '/opt/homebrew/bin/terminal-notifier' }));
    expect(v.health).toBe('ok');
    expect(v.headline).toContain('arrivano');
    expect(v.headline).not.toContain('NON arrivano');
    // Il perché va detto lo stesso: spiega il nome sbagliato sul banner e
    // l'assenza di Topics dal pannello di sistema. Ma sta nell'hint.
    expect(v.hint).toContain('terminal-notifier');
    expect(v.hint).toContain('Impostazioni di sistema');
  });

  test('né autorizzati né carrier → rotto, ed è il caso che era invisibile', () => {
    const v = describeNativeNotifications(mac());
    expect(v.health).toBe('broken');
    expect(v.headline).toContain('NON arrivano');
    // Il toast in finestra resta: va detto, o sembra che non funzioni nulla.
    expect(v.hint).toContain('toast in finestra');
  });

  test('negato esplicitamente → indica il pannello di sistema', () => {
    const v = describeNativeNotifications(mac({ authState: 'denied' }));
    expect(v.health).toBe('broken');
    expect(v.hint).toContain('negate');
    expect(v.hint).toContain('Impostazioni di sistema');
  });

  // Il ramo che il pannello sbagliava davvero. `notDetermined` significa che
  // macOS non ha MAI deciso: l'app in Impostazioni di sistema → Notifiche non
  // compare proprio (`defaults read com.apple.ncprefs apps` non ne ha traccia),
  // quindi mandarci l'utente è un consiglio impossibile da seguire.
  test('non ancora deciso → NON manda in un pannello dove l’app non c’è', () => {
    for (const authState of ['notDetermined', 'pending'] as const) {
      const v = describeNativeNotifications(mac({ authState }));
      expect(v.health).toBe('broken');
      expect(v.hint).not.toContain('Impostazioni di sistema');
      expect(v.hint).not.toContain('negate');
      expect(v.hint).toContain('toast in finestra');
    }
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

  // Il contrario del test di prima («nessuno dichiara ok senza autorizzazione»),
  // e per una ragione: l'autorizzazione non è la domanda. La domanda è se esiste
  // una via d'uscita. Senza nessuna, «ok» non si dice mai.
  test('nessuno stato SENZA una via d’uscita dichiara «ok»', () => {
    const senzaConsegna: NativeNotificationStatus[] = [
      mac(),
      mac({ authState: 'notDetermined' }),
      mac({ authState: 'denied' }),
      mac({ bundled: false }),
      // Il carrier non salva una build fuori dal bundle: lì non si posta nulla.
      mac({ bundled: false, helper: '/usr/local/bin/terminal-notifier' }),
    ];
    for (const s of senzaConsegna) {
      expect(describeNativeNotifications(s).health).not.toBe('ok');
    }
  });
});

/**
 * Which button, if any, sits under the verdict. The verdict only reads the
 * state; this decides what pressing the button does, and it has to agree with
 * the shell's `request_permission`. One case per branch: ask while macOS has
 * not decided, open System Settings on a denial, and nothing when granted,
 * outside a .app bundle, off macOS, or outside Tauri.
 */
describe('notificationPermissionAction', () => {
  test('asks while macOS has not decided yet', () => {
    expect(notificationPermissionAction(mac({ authState: 'notDetermined' })))
      .toEqual({ kind: 'request', labelKey: 'notif.perm.request' });
    expect(notificationPermissionAction(mac({ authState: 'pending' })))
      .toEqual({ kind: 'request', labelKey: 'notif.perm.request' });
  });

  test('opens System Settings on a denial, the prompt is never shown twice', () => {
    expect(notificationPermissionAction(mac({ authState: 'denied' })))
      .toEqual({ kind: 'open-settings', labelKey: 'notif.perm.openSettings' });
  });

  test('nothing to do once granted', () => {
    expect(notificationPermissionAction(mac({ authState: 'granted', authorized: true })).kind).toBe('none');
  });

  test('nothing to do outside a .app bundle, even when undecided', () => {
    expect(notificationPermissionAction(mac({ bundled: false, authState: 'notDetermined' })).kind).toBe('none');
  });

  test('nothing to do off macOS', () => {
    expect(notificationPermissionAction(mac({ platform: 'windows', authState: 'unknown' })).kind).toBe('none');
  });

  test('nothing to do outside Tauri, the browser owns that permission', () => {
    expect(notificationPermissionAction(null).kind).toBe('none');
  });
});
