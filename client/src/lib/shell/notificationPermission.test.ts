/**
 * `primeWebNotificationPermission` — la porta unica al permesso dei banner web.
 *
 * Il bug che questa porta chiude: «le tre spuntine da riaggiungere a ogni
 * avvio». La regola vera è una sola — sotto Tauri il permesso web NON va
 * chiesto, perché in WKWebView `Notification.permission` non sopravvive al
 * rilancio (quindi il prompt ripartiva sempre) e perché quel permesso non
 * governa nulla (la consegna passa dal comando nativo `notify`). Ma la regola
 * era scritta in un solo punto su tre: `usePanelLifecycle` e
 * `usePushNotifications` chiedevano il permesso nudo. E `usePanelLifecycle` è
 * montato una volta PER FINESTRA: con i gruppi staccati, N finestre = N prompt.
 *
 * Questi test tengono la regola dov'è adesso, cioè in un posto solo.
 *
 * `shellKind` è una costante di caricamento del modulo (`lib/shell/index`), per
 * questo si passa da `mock.module` prima dell'import: è l'unico modo di vedere
 * il ramo nativo da `bun test`, dove il guscio è sempre 'web'.
 *
 * @covers CMD-02
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';

let asked = 0;
let permission: NotificationPermission = 'default';

function installFakeNotification() {
  asked = 0;
  permission = 'default';
  (globalThis as unknown as { Notification: unknown }).Notification = {
    get permission() { return permission; },
    requestPermission: () => {
      asked += 1;
      permission = 'granted';
      return Promise.resolve<NotificationPermission>('granted');
    },
  };
}

// The REAL module, taken before it is replaced. The stub is built ON TOP of it
// because `mock.module` swaps the whole module: naming only the four exports
// this file lies about left `isTauriWindows` out, and every file running after
// read it as `undefined`. Named one by one, not spread from the namespace: a
// namespace import would make this module opaque to knip.
const {
  detectShell: realDetectShell,
  shellKind: realShellKind,
  isTauri: realIsTauri,
  isDesktop: realIsDesktop,
  isTauriWindows: realIsTauriWindows,
} = await import('./index');
const realShell = {
  detectShell: realDetectShell,
  shellKind: realShellKind,
  isTauri: realIsTauri,
  isDesktop: realIsDesktop,
  isTauriWindows: realIsTauriWindows,
};

function mockShell(kind: 'tauri' | 'web') {
  mock.module('./index', () => ({
    ...realShell,
    shellKind: kind,
    isTauri: kind === 'tauri',
    isDesktop: kind !== 'web',
    detectShell: () => kind,
  }));
}

// L'import è dinamico e DOPO il mock: `shellKind` si legge al caricamento.
// I nomi sono scritti uno per uno invece di restituire il namespace del modulo:
// un `import()` il cui risultato non finisce in una destrutturazione è OPACO per
// il cancello sul codice morto, che da lì in poi considera usato OGNI export di
// `app.ts` (11) — guardia `bun run check:deadcode-blindspots`.
async function loadApp() {
  const {
    __resetWebNotificationPrimeForTests,
    primeWebNotificationPermission,
    webNotificationPermission,
  } = await import('./app');
  return { __resetWebNotificationPrimeForTests, primeWebNotificationPermission, webNotificationPermission };
}

beforeEach(() => { installFakeNotification(); });
afterEach(() => {
  delete (globalThis as unknown as { Notification?: unknown }).Notification;
});

// `mock.module` patcha il registro dei moduli per TUTTO il processo di
// `bun test`, non solo per questo file: se si uscisse con il guscio finto
// addosso, il file successivo che importa `lib/shell` leggerebbe il nostro mock.
//
// The way out is putting the REAL MODULE back, not another stub. This used to be
// `mockShell('web')`, and the reasoning looked sound - there is no `window` under
// bun, so the real shell says 'web' anyway. But a mock stays a mock: that one
// declared four exports out of five, and `isTauriWindows` vanished for everybody
// after it.
afterAll(() => { mock.module('./index', () => realShell); });

describe('primeWebNotificationPermission', () => {
  test('sotto Tauri non chiede NIENTE — è il bug dei prompt a ogni avvio', async () => {
    mockShell('tauri');
    const app = await loadApp();
    app.__resetWebNotificationPrimeForTests();

    expect(await app.primeWebNotificationPermission()).toBe('unsupported');
    expect(asked).toBe(0);

    // Una finestra staccata monta gli stessi hook da capo: nemmeno la decima
    // deve far comparire un prompt.
    for (let i = 0; i < 10; i++) await app.primeWebNotificationPermission();
    expect(asked).toBe(0);

    // E il permesso web non viene nemmeno LETTO come se contasse: sotto Tauri
    // non governa niente, la consegna passa dal comando nativo `notify`.
    expect(app.webNotificationPermission()).toBe('unsupported');
  });

  test('sul web chiede una volta sola, poi ricorda', async () => {
    mockShell('web');
    const app = await loadApp();
    app.__resetWebNotificationPrimeForTests();

    expect(await app.primeWebNotificationPermission()).toBe('granted');
    expect(asked).toBe(1);

    // Secondo hook, stessa finestra: la risposta c'è già.
    expect(await app.primeWebNotificationPermission()).toBe('granted');
    expect(asked).toBe(1);
  });

  test('un «no» non si ri-chiede: riproporlo non riapre nessun prompt', async () => {
    mockShell('web');
    const app = await loadApp();
    app.__resetWebNotificationPrimeForTests();
    permission = 'denied';

    expect(await app.primeWebNotificationPermission()).toBe('denied');
    expect(asked).toBe(0);
  });

  test('senza l’API Notification non esplode: «unsupported», nessuna richiesta', async () => {
    mockShell('web');
    const app = await loadApp();
    app.__resetWebNotificationPrimeForTests();
    delete (globalThis as unknown as { Notification?: unknown }).Notification;

    expect(app.webNotificationPermission()).toBe('unsupported');
    expect(await app.primeWebNotificationPermission()).toBe('unsupported');
  });
});
