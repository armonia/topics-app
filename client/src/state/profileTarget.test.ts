/**
 * THE DEEP LINK THAT GOT EATEN BEFORE IT ARRIVED.
 *
 * The request used to be destroyed by the first reader. On screen that meant
 * "Manage this organization" opening the profile on your OWN page: the pane
 * mounts twice (the lazy chunk lands, the pane store rebuilds the tab around
 * it) and the first mount swallowed the request the second one needed. Playing
 * it back here costs two calls; on screen it cost a wrong page every time.
 *
 * The other half of the contract is the expiry, and it is why this is a time
 * window and not a flag: reopening the profile an hour later from the "Topics"
 * menu must not land on the page somebody asked for at some other moment.
 *
 * @covers PROFILE-06
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { apriProfilo, openPersonProfile, dimenticaPaginaProfilo, paginaProfiloChiesta, requestedProfile } from './profileTarget';

// `apriProfilo` fires two DOM events: in bun there is no window, so the two
// gestures below need one that swallows them.
const finestra = { dispatchEvent: () => true } as unknown as Window & typeof globalThis;
(globalThis as { window?: unknown }).window = finestra;
(globalThis as { CustomEvent?: unknown }).CustomEvent ??= class {
  constructor(readonly type: string, readonly init?: unknown) {}
};

// The fake window (dispatchEvent only) would flip `typeof window === 'undefined'`
// for the later files in the sharded process. Remove it when the file ends.
afterAll(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('paginaProfiloChiesta', () => {
  beforeEach(() => { dimenticaPaginaProfilo(); });

  test('nobody asked: null, and the pane opens on its first page', () => {
    expect(paginaProfiloChiesta()).toBeNull();
  });

  test('TWO mounts in a row read the SAME page: the first does not eat it', () => {
    apriProfilo('privacy', 1_000);
    expect(paginaProfiloChiesta(1_010)).toBe('privacy');
    expect(paginaProfiloChiesta(1_020)).toBe('privacy');
  });

  test('past the window it is gone: an hour later the profile opens on itself', () => {
    apriProfilo('followers', 1_000);
    expect(paginaProfiloChiesta(3_600_000)).toBeNull();
    // And it stays gone, so a later mount cannot resurrect it.
    expect(paginaProfiloChiesta(3_600_001)).toBeNull();
  });

  test('the pane that showed the page forgets it, without waiting for the clock', () => {
    apriProfilo('followers', 1_000);
    dimenticaPaginaProfilo();
    expect(paginaProfiloChiesta(1_010)).toBeNull();
  });

  test('the last request wins: two clicks, the second page', () => {
    apriProfilo('privacy', 1_000);
    apriProfilo('followers', 1_100);
    expect(paginaProfiloChiesta(1_110)).toBe('followers');
  });
});

describe('opening somebody else', () => {
  test('a person is asked for by id, and the page is the overview', () => {
    openPersonProfile('per_1', 1_000);
    expect(requestedProfile(1_010)).toEqual({ pagina: 'profile', personId: 'per_1' });
  });

  test('my own pages carry no person: the pane must not go looking for one', () => {
    apriProfilo('followers', 1_000);
    expect(requestedProfile(1_010)?.personId).toBeNull();
  });

  test('a person expires like a page does', () => {
    openPersonProfile('per_1', 1_000);
    expect(requestedProfile(3_600_000)).toBeNull();
  });
});
