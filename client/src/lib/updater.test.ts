/**
 * shouldShowUpdaterToast — la tabella di verità del toast dell'updater.
 *
 * Il caso che ha motivato il flag `silent`: finché non esiste una release
 * FIRMATA l'endpoint dell'updater risponde 404, e il controllo automatico al
 * boot piazzava un toast di errore a ogni avvio dell'app — per qualcosa che
 * l'utente non ha chiesto e non può risolvere. Un aggiornamento davvero
 * disponibile deve invece uscire SEMPRE, anche se il controllo era silenzioso.
  * @covers UPDATER-01, STATUSLINE-03c
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellUpdateNotice, shouldShowUpdaterToast, updateTitle, type UpdaterStatus } from './updater';
import { ensureLocaleLoaded, t } from './i18n';

const quiet = { dismissed: false, versionPopoverOpen: false };

describe('shouldShowUpdaterToast', () => {
  test('idle non disegna niente', () => {
    expect(shouldShowUpdaterToast({ state: 'idle' }, quiet)).toBe(false);
  });

  test('gli stati che chiedono qualcosa si vedono', () => {
    const states: UpdaterStatus['state'][] = ['checking', 'update-available', 'downloading', 'ready', 'error'];
    for (const state of states) {
      expect(shouldShowUpdaterToast({ state }, quiet)).toBe(true);
    }
  });

  test("l'esito di un controllo silenzioso resta muto — anche se è un errore", () => {
    expect(shouldShowUpdaterToast({ state: 'error', error: '404', silent: true }, quiet)).toBe(false);
    expect(shouldShowUpdaterToast({ state: 'idle', silent: true }, quiet)).toBe(false);
  });

  test('un aggiornamento disponibile esce anche se il controllo era al boot', () => {
    // È il produttore a marcare `silent: false` su update-available: qui si pinna
    // che il consumatore lo rispetta, cioè che "silenzioso" non è una proprietà
    // del CONTROLLO ma dell'ESITO.
    expect(
      shouldShowUpdaterToast({ state: 'update-available', version: '2.3.0', silent: false }, quiet),
    ).toBe(true);
  });

  test('chiuso dall’utente, o popover della versione aperto → niente doppioni', () => {
    const ready: UpdaterStatus = { state: 'ready' };
    expect(shouldShowUpdaterToast(ready, { dismissed: true, versionPopoverOpen: false })).toBe(false);
    expect(shouldShowUpdaterToast(ready, { dismissed: false, versionPopoverOpen: true })).toBe(false);
  });
});

describe("an available update is announced, because it no longer arrives by itself", () => {
  // THE OPPOSITE RULE USED TO LIVE HERE. With `autoUpdate` on, the banner stayed
  // quiet about everything except "ready", and the reason was sound for as long
  // as it was true: the windows reloaded themselves, so offering a "Scarica"
  // button asked for a gesture on work already under way. Reported twice, fixed
  // twice (fda59c2b the version panel, then this banner).
  //
  // It stopped being true. The shell now reinstalls and relaunches on its own
  // ONLY while the main window is hidden (may_relaunch_unattended), and while it
  // is hidden this toast is not drawn. So the branch could only fire in the case
  // it was never written for: an update waiting for a click, in an app with no
  // way left to mention it. On 2026-08-21 the app had already reinstalled and
  // relaunched itself eight times in one week.
  test("available shows: without the banner nobody would know", () => {
    const s: UpdaterStatus = { state: "update-available", version: "2.3.0" };
    expect(shouldShowUpdaterToast(s, quiet)).toBe(true);
  });

  test("ready shows: a downloaded binary is waiting for a restart", () => {
    expect(shouldShowUpdaterToast({ state: "ready", version: "2.3.0" }, quiet)).toBe(true);
  });

  test("downloading shows: it is the state between the other two", () => {
    expect(shouldShowUpdaterToast({ state: "downloading", progress: 40 }, quiet)).toBe(true);
  });

  test("the silent boot check stays silent", () => {
    // The one thing boot must not draw: the outcome of a check nobody asked for.
    const s: UpdaterStatus = { state: "update-available", version: "2.3.0", silent: true };
    expect(shouldShowUpdaterToast(s, quiet)).toBe(false);
  });
});

describe('closing the banner means "not this version"', () => {
  // 2026-08-27, reported twice in one evening:
  //   "mi dice ANCORA nuova versione v2.2.200 disponibile"  allow-italian: the
  //   reported words are what this test pins.
  // Nothing was wrong with the message - the machine was 23 versions behind -
  // but the "x" bought about four seconds. The boot check
  // runs on every launch, an available update publishes non-silent on purpose,
  // and the component reset `dismissed` on every status event, so the banner
  // came back for the same version forever.
  const seen = { dismissed: false, versionPopoverOpen: false, dismissedVersion: '2.2.200' };

  test('the dismissed version stays quiet across a new check', () => {
    expect(
      shouldShowUpdaterToast({ state: 'update-available', version: '2.2.200' }, seen),
    ).toBe(false);
  });

  test('a newer version speaks again — the rule must not become a mute button', () => {
    expect(
      shouldShowUpdaterToast({ state: 'update-available', version: '2.2.203' }, seen),
    ).toBe(true);
  });

  test('only update-available is versioned: ready and error are not silenced', () => {
    // `ready` is a downloaded binary waiting for a restart, `error` is something
    // that just went wrong. Neither is "the announcement of version X", so the
    // memory of a closed announcement must not reach them.
    expect(shouldShowUpdaterToast({ state: 'ready', version: '2.2.200' }, seen)).toBe(true);
    expect(shouldShowUpdaterToast({ state: 'error', error: 'boom' }, seen)).toBe(true);
  });

  test('nothing dismissed yet — the banner shows', () => {
    const fresh = { dismissed: false, versionPopoverOpen: false, dismissedVersion: null };
    expect(
      shouldShowUpdaterToast({ state: 'update-available', version: '2.2.200' }, fresh),
    ).toBe(true);
  });

  test('an update with no version cannot be remembered, so it always shows', () => {
    expect(shouldShowUpdaterToast({ state: 'update-available' }, seen)).toBe(true);
  });
});

describe('updateTitle — the headline is a key, never the transport error', () => {
  // What reaches `status.error` is `e.to_string()` of the Rust updater plugin.
  // On screen it was the title, in bold, on the first line, truncated by the
  // banner: "Network Error: error sending request for url (…)". The user was
  // being shown the transport's business instead of their own.
  test('a network failure maps to a sentence, not to itself', () => {
    const key = updateTitle({
      state: 'error',
      error: 'Network Error: error sending request for url (https://example.invalid/latest.json)',
    }).key;
    expect(key).toBe('update.err.network');
    expect(key).not.toContain('sending request');
  });

  test('an endpoint with no release for this build says so', () => {
    expect(updateTitle({ state: 'error', error: 'Could not fetch a valid release JSON: 404' }).key)
      .toBe('update.err.endpoint');
  });

  test('an unknown failure still lands on a key', () => {
    expect(updateTitle({ state: 'error', error: 'boom' }).key).toBe('update.err.generic');
    expect(updateTitle({ state: 'error' }).key).toBe('update.err.generic');
  });

  test('every state has its own sentence, and the numbers travel as params', () => {
    expect(updateTitle({ state: 'up-to-date' }).key).toBe('update.title.upToDate');
    expect(updateTitle({ state: 'checking' }).key).toBe('update.title.checking');
    expect(updateTitle({ state: 'update-available', version: '2.3.0' }).params).toEqual({ v: ' v2.3.0' });
    expect(updateTitle({ state: 'downloading', progress: 41.4 }).params).toEqual({ pct: ' 41%' });
    expect(updateTitle({ state: 'ready' }).key).toBe('update.title.ready');
  });
});

describe('"you are up to date" is an answer, "idle" is not', () => {
  // A check the user asked for that found nothing used to end in `idle`, and no
  // surface draws `idle`: the menu entry flashed "Checking…" and then nothing.
  test('an explicit check that found nothing draws', () => {
    expect(shouldShowUpdaterToast({ state: 'up-to-date', silent: false }, quiet)).toBe(true);
  });

  test('the boot check that found nothing stays quiet', () => {
    expect(shouldShowUpdaterToast({ state: 'up-to-date', silent: true }, quiet)).toBe(false);
  });

  test('idle keeps meaning "no check has been made"', () => {
    expect(shouldShowUpdaterToast({ state: 'idle' }, quiet)).toBe(false);
  });
});

describe('an available update, and the number the sentence names', () => {
  // The three outcomes of the comparison, and the sentence each one puts on
  // screen. The case that produced the card: a shell at 2.2.264 on a machine
  // whose client bundle already read 2.2.277, so the release number alone said
  // nothing the person did not already believe they had.
  test('the published release is NEWER than the installed shell: the release sentence', () => {
    const notice = shellUpdateNotice('2.2.277', '2.2.264');
    expect(notice?.title).toEqual({ key: 'update.title.available', params: { v: ' v2.2.277' } });
    expect(notice?.detail).toBeUndefined();
    expect(t(notice!.title.key, 'it', notice!.title.params)).toBe('Aggiornamento v2.2.277 disponibile');
  });

  test('on a dev install the notice carries the SHELL number too, on its own line', async () => {
    await ensureLocaleLoaded('en');
    const notice = shellUpdateNotice('2.2.277', '2.2.264', { devInstall: true });
    expect(t(notice!.title.key, 'it', notice!.title.params)).toBe('Aggiornamento v2.2.277 disponibile');
    expect(t(notice!.detail!.key, 'it', notice!.detail!.params)).toBe('Guscio installato v2.2.264');
    expect(t(notice!.detail!.key, 'en', notice!.detail!.params)).toBe('Installed shell v2.2.264');
  });

  test('the same version, or an older one: nothing to say, on either install', () => {
    expect(shellUpdateNotice('2.2.277', '2.2.277')).toBeNull();
    expect(shellUpdateNotice('2.2.277', '2.2.277', { devInstall: true })).toBeNull();
    // The dev machine builds ahead of the last release all day: an endpoint
    // offering an OLDER version must not produce a banner.
    expect(shellUpdateNotice('2.2.276', '2.2.277', { devInstall: true })).toBeNull();
  });

  test('an unknown shell number does not buy silence: the update is real', () => {
    expect(shellUpdateNotice('2.2.277', undefined)?.title.key).toBe('update.title.available');
    expect(shellUpdateNotice('2.2.277', '0.0.0')?.title.key).toBe('update.title.available');
    // …and with nothing offered there is nothing to announce.
    expect(shellUpdateNotice(undefined, '2.2.264')).toBeNull();
  });

  test('the comparison is numeric, not alphabetical', () => {
    // '2.2.9' > '2.2.10' as strings, which would hide a real update.
    expect(shellUpdateNotice('2.2.10', '2.2.9')?.title.key).toBe('update.title.available');
    expect(shellUpdateNotice('2.2.9', '2.2.10')).toBeNull();
  });
});

describe('the keys exist in both dictionaries', () => {
  // A key with no sentence behind it renders as the key itself, which is how a
  // banner ends up saying "update.err.network" to a person.
  const KEYS = [
    'update.title.checking', 'update.title.upToDate', 'update.title.available',
    'update.title.downloading', 'update.title.ready', 'update.title.idle',
    'update.detail.localShell',
    'update.err.network', 'update.err.endpoint', 'update.err.generic',
    'update.downloadInstall', 'update.updateApp', 'dev.reload',
    'banner.eyebrow.build', 'banner.eyebrow.release',
  ];
  // A path string, not `new URL('./i18n-it.ts', import.meta.url)`: knip reads
  // a `new URL(…, import.meta.url)` as a module edge, and a catalogue reached
  // that way counts as "used whole" - every dead key in it goes blind
  // (`check:deadcode-blindspots` flagged both catalogues the day this landed).
  const it = readFileSync(join(import.meta.dir, 'i18n-it.ts'), 'utf8');
  const en = readFileSync(join(import.meta.dir, 'i18n-en.ts'), 'utf8');
  for (const k of KEYS) {
    test(`${k} is translated in it and en`, () => {
      expect(it).toContain(`'${k}':`);
      expect(en).toContain(`'${k}':`);
    });
  }
});
