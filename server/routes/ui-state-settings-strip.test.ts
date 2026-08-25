/**
 * `stripDeviceLocalFields` è la difesa in profondità del PUT su `ui_state`: il
 * client toglie già i campi che non devono viaggiare, ma il server non si fida.
 *
 * Finora copriva solo `scrollOffset` (pane-store). Con la chiave `settings`
 * entra in gioco un secondo caso: la GEOMETRIA della finestra. `sidebarWidth`
 * e `sidebarCollapsed` vivono in `AppSettings` perché è lì che l'app le legge,
 * ma 256px su un 27" sono mezzo schermo su un telefono, e "collassata" viene
 * forzata da sé dalle finestre staccate e dal mobile: se viaggiassero, l'ultimo
 * dispositivo che salva imporrebbe la propria a tutti gli altri.
 *
 * Il test è mirato: si strippa SOLO sotto la chiave `settings`, e SOLO quei due
 * campi — un pane-store che avesse per caso un campo con lo stesso nome non
 * deve perderlo.
 *
 * @covers APPSET-02
 */
import { describe, test, expect } from "bun:test";
import { stripDeviceLocalFields, SETTINGS_KEY, DEVICE_LOCAL_SETTINGS_FIELDS } from "./ui-state";

describe("stripDeviceLocalFields — chiave `settings`", () => {
  test("toglie la geometria della finestra, tiene le preferenze vere", () => {
    const out = stripDeviceLocalFields(
      {
        fontSize: 15,
        notificationsEnabled: false,
        messageDensity: "compact",
        sidebarWidth: 420,
        sidebarCollapsed: true,
      },
      SETTINGS_KEY,
    ) as Record<string, unknown>;

    expect(out).toEqual({ fontSize: 15, notificationsEnabled: false, messageDensity: "compact" });
    expect("sidebarWidth" in out).toBe(false);
    expect("sidebarCollapsed" in out).toBe(false);
  });

  test("i due campi tolti sono esattamente quelli dichiarati", () => {
    const payload: Record<string, unknown> = { fontSize: 13 };
    for (const f of DEVICE_LOCAL_SETTINGS_FIELDS) payload[f] = 1;
    const out = stripDeviceLocalFields(payload, SETTINGS_KEY) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["fontSize"]);
  });

  test("non muta il payload del chiamante", () => {
    const input = { fontSize: 13, sidebarWidth: 300 };
    stripDeviceLocalFields(input, SETTINGS_KEY);
    expect(input.sidebarWidth).toBe(300);
  });

  test("un payload senza geometria passa intatto", () => {
    const out = stripDeviceLocalFields({ fontSize: 13, messageDensity: "compact" }, SETTINGS_KEY);
    expect(out).toEqual({ fontSize: 13, messageDensity: "compact" });
  });
});

describe("stripDeviceLocalFields — le altre chiavi non sono toccate", () => {
  // Il taglio è per-chiave, non per-nome-di-campo: una chiave diversa che avesse
  // un `sidebarWidth` suo (o un pane-store) non deve perderlo per omonimia.
  test("stessa forma sotto un'altra chiave resta intera", () => {
    const payload = { fontSize: 13, sidebarWidth: 420, sidebarCollapsed: true };
    expect(stripDeviceLocalFields(payload, "sidebar-state")).toEqual(payload);
    expect(stripDeviceLocalFields(payload)).toEqual(payload);
  });

  test("lo strip storico di scrollOffset continua a valere", () => {
    const out = stripDeviceLocalFields(
      { panes: { p1: { kind: "chat", scrollOffset: 900 } } },
      "pane-store",
    ) as { panes: Record<string, Record<string, unknown>> };
    expect(out.panes.p1).toEqual({ kind: "chat" });
  });

  test("scrollOffset NON viene strippato sotto `settings` per errore di ordine", () => {
    // Il ramo `settings` esce presto: deve comunque non lasciar passare la
    // geometria, e non deve pretendere di trovare un pane-store.
    const out = stripDeviceLocalFields(
      { fontSize: 13, sidebarWidth: 1, panes: { p1: { scrollOffset: 5 } } },
      SETTINGS_KEY,
    ) as Record<string, unknown>;
    expect("sidebarWidth" in out).toBe(false);
    expect(out.panes).toEqual({ p1: { scrollOffset: 5 } });
  });
});

describe("stripDeviceLocalFields — non-oggetti", () => {
  test("primitivi, null e array tornano identici anche con la chiave settings", () => {
    expect(stripDeviceLocalFields(null, SETTINGS_KEY)).toBe(null);
    expect(stripDeviceLocalFields(42, SETTINGS_KEY)).toBe(42);
    expect(stripDeviceLocalFields("x", SETTINGS_KEY)).toBe("x");
    const arr = [1, 2];
    expect(stripDeviceLocalFields(arr, SETTINGS_KEY)).toBe(arr);
  });
});
