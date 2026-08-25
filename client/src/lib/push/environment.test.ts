/**
 * La fotografia dell'ambiente che decide quale stato push vedi.
 *
 * `pushStatus.test.ts` prova il GIUDIZIO — dati `capable`, `permission`,
 * `iosNeedsInstall`, che cosa si dice all'utente. Questo file prova la
 * FOTOGRAFIA, cioe' il passo prima: da `navigator` e `window` come si arriva a
 * quei campi. Era scoperto, e il giudizio piu' curato del mondo non serve se
 * legge un ambiente sbagliato.
 *
 * IL CASO CHE VALE PIU' DI TUTTI, ed e' l'unico con un commento nel sorgente
 * che lo spiega: da iPadOS 13 un iPad **si dichiara «Macintosh»**. Senza il
 * secondo controllo (`maxTouchPoints > 1`) un iPad in Safari finisce nel ramo
 * desktop, e a quella persona Topics direbbe «il tuo browser non supporta le
 * notifiche» quando invece il rimedio esiste ed e' installare la PWA. Un
 * messaggio sbagliato che manda a casa qualcuno che poteva essere servito.
 *
 * Le globali si sostituiscono e si rimettono a posto: `bun test` fa girare i
 * file nello stesso processo, e una `navigator` finta lasciata in giro
 * cambierebbe il mondo sotto ai file successivi.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { pushCapable, pushDeviceId, readPushEnvironment } from "./environment";

type Globali = { navigator?: unknown; window?: unknown; localStorage?: unknown; Notification?: unknown };
const ORIGINALI: Globali = {
  navigator: (globalThis as Globali).navigator,
  window: (globalThis as Globali).window,
  localStorage: (globalThis as Globali).localStorage,
  Notification: (globalThis as Globali).Notification,
};

function metti(g: Globali) {
  for (const [k, v] of Object.entries(g)) {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}

afterEach(() => metti(ORIGINALI));

/** Un ambiente browser finto, con solo quello che il modulo legge davvero. */
function ambiente(opts: {
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
  metti({
    navigator: nav,
    window: win,
    Notification: { permission: opts.permission ?? "default" },
  });
}

describe("il browser puo' ricevere una notifica push?", () => {
  test("servono ENTRAMBI: service worker e PushManager", () => {
    ambiente({});
    expect(pushCapable()).toBe(true);

    ambiente({ serviceWorker: false });
    expect(pushCapable(), "senza service worker non c'e' niente da iscrivere").toBe(false);

    ambiente({ pushManager: false });
    expect(pushCapable(), "senza PushManager non c'e' niente da iscrivere").toBe(false);
  });
});

describe("iOS fuori dalla PWA installata", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari";
  const IPAD_13 = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari";
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome";

  test("un iPhone in Safari ha un rimedio: installare la PWA", () => {
    ambiente({ ua: IPHONE, pushManager: false });
    expect(readPushEnvironment(false).iosNeedsInstall).toBe(true);
  });

  test("lo stesso iPhone, con la PWA installata, non chiede piu' niente", () => {
    ambiente({ ua: IPHONE, standalone: true });
    expect(readPushEnvironment(false).iosNeedsInstall).toBe(false);
  });

  test("e lo riconosce anche dal display-mode, non solo da `navigator.standalone`", () => {
    ambiente({ ua: IPHONE, displayMode: true });
    expect(readPushEnvironment(false).iosNeedsInstall).toBe(false);
  });

  test("UN IPAD SI DICHIARA «MACINTOSH»: lo tradisce il touch", () => {
    // Il caso per cui esiste il doppio controllo. Stessa identica stringa di un
    // Mac, e la differenza e' un solo campo.
    ambiente({ ua: IPAD_13, touch: 5, pushManager: false });
    expect(
      readPushEnvironment(false).iosNeedsInstall,
      "un iPad in Safari finisce nel ramo desktop e si sente dire «non supportato»",
    ).toBe(true);
  });

  test("un Mac vero resta un Mac: stessa stringa, zero touch", () => {
    // La meta' che rende non vacuo il test sopra: se bastasse la stringa,
    // questo darebbe lo stesso risultato, e il doppio controllo non servirebbe.
    ambiente({ ua: MAC, touch: 0 });
    expect(readPushEnvironment(false).iosNeedsInstall).toBe(false);
  });

  test("IL LIMITE dell'euristica, scritto invece che nascosto", () => {
    // «Macintosh» + piu' di un punto di tocco viene letto come iPad, quindi un
    // Mac che dichiarasse del touch finirebbe nel ramo «installa la PWA».
    //
    // Non e' un difetto da correggere, ed e' per questo che il test lo FISSA
    // invece di chiedere un fix: macOS non espone `maxTouchPoints` (resta 0
    // anche con un display touch collegato), quindi il caso non si presenta.
    // Vale la pena scriverlo perche' il giorno in cui si presentasse — un
    // motore nuovo, un cambio di Safari — questo test diventerebbe il posto in
    // cui si scopre, invece di un utente Mac che si sente dire di installare
    // una PWA che non gli serve.
    ambiente({ ua: MAC, touch: 10 });
    expect(readPushEnvironment(false).iosNeedsInstall).toBe(true);
  });
});

describe("l'ambiente riassunto", () => {
  test("porta il permesso e lo stato di iscrizione che gli si passa", () => {
    ambiente({ permission: "denied" });
    const env = readPushEnvironment(true);
    expect(env.permission).toBe("denied");
    expect(env.subscribed).toBe(true);
    expect(env.capable).toBe(true);
  });
});

describe("l'identita' del dispositivo", () => {
  test("e' stabile: chiesta due volte, risponde lo stesso", () => {
    const memoria = new Map<string, string>();
    metti({
      localStorage: {
        getItem: (k: string) => memoria.get(k) ?? null,
        setItem: (k: string, v: string) => void memoria.set(k, v),
      },
    });
    const uno = pushDeviceId();
    expect(uno).toBeTruthy();
    expect(pushDeviceId(), "un id che cambia non puo' reggere una preferenza").toBe(uno);
  });

  test("con lo storage non scrivibile risponde comunque, invece di fallire", () => {
    // Il ramo dichiarato nel sorgente: «peggio e' un'iscrizione che fallisce
    // del tutto». Navigazione privata bloccata, storage pieno.
    metti({
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
