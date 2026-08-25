/**
 * The snapshot of the environment that decides which push status you see.
 *
 * `pushStatus.test.ts` tests the JUDGEMENT - given `capable`, `permission`,
 * `iosNeedsInstall`, what gets said to the user. This file tests the
 * SNAPSHOT, that is the step before: how you get from `navigator` and `window`
 * to those fields. It was uncovered, and the most carefully crafted judgement
 * in the world is useless if it reads the wrong environment.
 *
 * THE CASE THAT MATTERS MOST OF ALL, and the only one with a comment in the
 * source explaining it: since iPadOS 13 an iPad **declares itself "Macintosh"**.
 * Without the second check (`maxTouchPoints > 1`) an iPad in Safari ends up in
 * the desktop branch, and Topics would tell that person "your browser does not
 * support notifications" when in fact the remedy exists and it is installing
 * the PWA. A wrong message that sends home someone who could have been served.
 *
 * The globals get replaced and put back: `bun test` runs the files in the same
 * process, and a fake `navigator` left lying around would change the world out
 * from under the files that follow.
 *
 * @covers CMD-02
 */
import { afterEach, describe, expect, test } from "bun:test";
import { pushCapable, pushDeviceId, readPushEnvironment } from "./environment";

type Globals = { navigator?: unknown; window?: unknown; localStorage?: unknown; Notification?: unknown };
const ORIGINALS: Globals = {
  navigator: (globalThis as Globals).navigator,
  window: (globalThis as Globals).window,
  localStorage: (globalThis as Globals).localStorage,
  Notification: (globalThis as Globals).Notification,
};

function setGlobals(g: Globals) {
  for (const [k, v] of Object.entries(g)) {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}

afterEach(() => setGlobals(ORIGINALS));

/** A fake browser environment, with only what the module actually reads. */
function environment(opts: {
  ua?: string;
  touch?: number;
  standalone?: boolean;
  displayMode?: boolean;
  serviceWorker?: boolean;
  pushManager?: boolean;
  permission?: string;
}) {
  const nav: Record<string, unknown> = {
    userAgent: opts.ua ?? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    maxTouchPoints: opts.touch ?? 0,
  };
  if (opts.serviceWorker ?? true) nav.serviceWorker = {};
  if (opts.standalone !== undefined) nav.standalone = opts.standalone;
  const win: Record<string, unknown> = {
    matchMedia: (q: string) => ({ matches: q.includes("standalone") ? (opts.displayMode ?? false) : false }),
  };
  if (opts.pushManager ?? true) win.PushManager = function () {};
  setGlobals({
    navigator: nav,
    window: win,
    Notification: { permission: opts.permission ?? "default" },
  });
}

describe("il browser puo' ricevere una notifica push?", () => {
  test("servono ENTRAMBI: service worker e PushManager", () => {
    environment({});
    expect(pushCapable()).toBe(true);

    environment({ serviceWorker: false });
    expect(pushCapable(), "senza service worker non c'e' niente da iscrivere").toBe(false);

    environment({ pushManager: false });
    expect(pushCapable(), "senza PushManager non c'e' niente da iscrivere").toBe(false);
  });
});

describe("iOS fuori dalla PWA installata", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari";
  const IPAD_13 = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari";
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome";

  test("un iPhone in Safari ha un rimedio: installare la PWA", () => {
    environment({ ua: IPHONE, pushManager: false });
    expect(readPushEnvironment(false).iosNeedsInstall).toBe(true);
  });

  test("lo stesso iPhone, con la PWA installata, non chiede piu' niente", () => {
    environment({ ua: IPHONE, standalone: true });
    expect(readPushEnvironment(false).iosNeedsInstall).toBe(false);
  });

  test("e lo riconosce anche dal display-mode, non solo da `navigator.standalone`", () => {
    environment({ ua: IPHONE, displayMode: true });
    expect(readPushEnvironment(false).iosNeedsInstall).toBe(false);
  });

  test("UN IPAD SI DICHIARA «MACINTOSH»: lo tradisce il touch", () => {
    // The case the double check exists for. The exact same string as a Mac,
    // and the difference is a single field.
    environment({ ua: IPAD_13, touch: 5, pushManager: false });
    expect(
      readPushEnvironment(false).iosNeedsInstall,
      "un iPad in Safari finisce nel ramo desktop e si sente dire «non supportato»",
    ).toBe(true);
  });

  test("un Mac vero resta un Mac: stessa stringa, zero touch", () => {
    // The half that makes the test above non-vacuous: if the string alone were
    // enough, this would give the same result, and the double check would not be needed.
    environment({ ua: MAC, touch: 0 });
    expect(readPushEnvironment(false).iosNeedsInstall).toBe(false);
  });

  test("IL LIMITE dell'euristica, scritto invece che nascosto", () => {
    // "Macintosh" + more than one touch point is read as an iPad, so a Mac
    // that declared touch would end up in the "install the PWA" branch.
    //
    // This is not a defect to correct, and that is why the test PINS it
    // instead of asking for a fix: macOS does not expose `maxTouchPoints` (it
    // stays 0 even with a touch display connected), so the case does not come
    // up. It is worth writing down because the day it did come up - a new
    // engine, a change in Safari - this test would become the place where it
    // gets discovered, instead of a Mac user being told to install a PWA they
    // have no use for.
    environment({ ua: MAC, touch: 10 });
    expect(readPushEnvironment(false).iosNeedsInstall).toBe(true);
  });
});

describe("l'ambiente riassunto", () => {
  test("porta il permesso e lo stato di iscrizione che gli si passa", () => {
    environment({ permission: "denied" });
    const env = readPushEnvironment(true);
    expect(env.permission).toBe("denied");
    expect(env.subscribed).toBe(true);
    expect(env.capable).toBe(true);
  });
});

describe("l'identita' del dispositivo", () => {
  test("e' stabile: chiesta due volte, risponde lo stesso", () => {
    const store = new Map<string, string>();
    setGlobals({
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
    const first = pushDeviceId();
    expect(first).toBeTruthy();
    expect(pushDeviceId(), "un id che cambia non puo' reggere una preferenza").toBe(first);
  });

  test("con lo storage non scrivibile risponde comunque, invece di fallire", () => {
    // The branch declared in the source: "worse is a subscription that fails
    // altogether". Blocked private browsing, full storage.
    setGlobals({
      localStorage: {
        getItem: () => { throw new Error("storage bloccato"); },
        setItem: () => { throw new Error("storage bloccato"); },
      },
    });
    const id = pushDeviceId();
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });
});
