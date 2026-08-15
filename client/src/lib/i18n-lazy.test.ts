import { describe, expect, test } from "bun:test";
import { ensureLocaleLoaded, loadedLocales, t, subscribeCatalogues, FALLBACK_LOCALE } from "./i18n";

/**
 * The English catalogue lives in its own chunk (`i18n-en.ts`) because the app
 * defaults to Italian and shipping ~880 lines nobody reads pushed the eager
 * entry 55 KB raw / 17 KB gzip past `check:bundle` on 2026-08-15.
 *
 * The price of that split is a window: between "the user picked English" and
 * "the dictionary arrived" the app can only draw Italian. These pin that the
 * window is a degraded state and not a broken one, and that it closes.
 */
describe("the English catalogue arrives on demand", () => {
  test("Italian is there from the first frame, without asking", () => {
    expect(loadedLocales()).toContain("it");
    expect(FALLBACK_LOCALE).toBe("it");
    // A real key, so this cannot pass against an empty dictionary.
    expect(t("topic.openElsewhere", "it")).toBe("Aperto in un'altra finestra");
  });

  test("before it lands, English falls back to Italian instead of printing the key", () => {
    // `t` is synchronous by contract (it paints the first frame). The fallback
    // chain it already had for a missing key is the same one that covers a
    // catalogue that has not arrived, which is why the split is safe.
    const beforeLoad = t("topic.openElsewhere", "en");
    expect(beforeLoad).not.toBe("topic.openElsewhere");
  });

  test("ensureLocaleLoaded resolves, installs the catalogue and wakes subscribers", async () => {
    let woken = 0;
    const stop = subscribeCatalogues(() => { woken++; });
    try {
      await ensureLocaleLoaded("en");
      expect(loadedLocales()).toBe("it,en");
      expect(t("topic.openElsewhere", "en")).toBe("Open in another window");
      // Only fires when a catalogue actually lands, so the count is 1 for the
      // first load and 0 for every call after it.
      expect(woken).toBeLessThanOrEqual(1);
    } finally {
      stop();
    }
  });

  test("asking twice does not load twice, and asking for Italian is a no-op", async () => {
    let woken = 0;
    const stop = subscribeCatalogues(() => { woken++; });
    try {
      await Promise.all([ensureLocaleLoaded("en"), ensureLocaleLoaded("en"), ensureLocaleLoaded("it")]);
      expect(woken).toBe(0); // already loaded by the test above
      expect(loadedLocales()).toBe("it,en");
    } finally {
      stop();
    }
  });

  test("a subscriber that unsubscribed is not called", async () => {
    let woken = 0;
    const stop = subscribeCatalogues(() => { woken++; });
    stop();
    await ensureLocaleLoaded("en");
    expect(woken).toBe(0);
  });
});
