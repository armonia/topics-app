/**
 * Il nome del dispositivo e i default della sua riga.
 *
 * Sembra cosmesi e non lo è: l'elenco delle impostazioni serve a spegnere UN
 * dispositivo, e per spegnere quello giusto devi riconoscerlo. L'endpoint non
 * si può mostrare (è un URL di 200 caratteri che cambia da solo), quindi tutto
 * il riconoscimento poggia su questa riga di testo.
  * @covers PUSH-03
 */
import { describe, expect, test } from "bun:test";
import { deviceLabelFromUserAgent, parseWhenOpen, toDeviceView, DEFAULT_WHEN_OPEN } from "./push-devices";

describe("deviceLabelFromUserAgent", () => {
  test("i tre dispositivi che l'utente ha davvero", () => {
    expect(deviceLabelFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("iPhone");
    expect(deviceLabelFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("Mac");
    expect(deviceLabelFromUserAgent("Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari")).toBe("Android");
  });

  test("iPad prima di Mac: da iPadOS 13 un iPad si dichiara «Macintosh»", () => {
    expect(deviceLabelFromUserAgent("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)")).toBe("iPad");
  });

  test("uno user agent che non dice niente dà «Dispositivo», non una stringa tecnica", () => {
    expect(deviceLabelFromUserAgent(null)).toBe("Dispositivo");
    expect(deviceLabelFromUserAgent("   ")).toBe("Dispositivo");
    expect(deviceLabelFromUserAgent("curl/8.4.0")).toBe("Dispositivo");
  });
});

describe("parseWhenOpen", () => {
  test("due valori ammessi, tutto il resto è null — la rotta ci fa un 400", () => {
    expect(parseWhenOpen("native")).toBe("native");
    expect(parseWhenOpen("in-app")).toBe("in-app");
    expect(parseWhenOpen("toast")).toBeNull();
    expect(parseWhenOpen(undefined)).toBeNull();
  });
});

describe("toDeviceView", () => {
  const base = {
    endpoint: "https://web.push.apple.com/abc",
    device_id: "dev-1",
    device_label: null,
    enabled: 1,
    when_open: null,
    user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    created_at: "2026-08-12 10:00:00",
    last_seen_at: null,
  };

  test("una riga senza preferenze scritte ricade sui default, non su undefined", () => {
    const v = toDeviceView(base, "dev-1");
    expect(v.whenOpen).toBe(DEFAULT_WHEN_OPEN);
    expect(v.enabled).toBe(true);
    expect(v.label).toBe("iPhone");
    expect(v.isThisDevice).toBe(true);
  });

  test("un'etichetta scritta a mano vince sullo user agent", () => {
    expect(toDeviceView({ ...base, device_label: "Telefono di lavoro" }, null).label).toBe("Telefono di lavoro");
  });

  test("senza id di chi chiede, nessuna riga è «questo dispositivo»", () => {
    expect(toDeviceView(base, null).isThisDevice).toBe(false);
  });

  test("`enabled = 0` è spento — la colonna è un intero, la vista un booleano", () => {
    expect(toDeviceView({ ...base, enabled: 0 }, null).enabled).toBe(false);
  });
});
