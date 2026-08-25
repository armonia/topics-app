import { describe, test, expect } from "bun:test";
import { declaredProviderName, routesThroughGateway } from "./commandRouting";

/**
 * Il difetto che questi test bloccano: `/model` si biforcava su
 * `providerForSessionKey(sessionKey).name === 'openclaw'`, cioè sul provider
 * RISOLTO. Su un runner senza la CLI `claude` il provider `claude-code` non
 * viene registrato, la risoluzione ripiega sul default (openclaw) e il comando
 * partiva verso il gateway inesistente: 500 «Command failed: Unable to connect».
 * Verde in locale, rosso solo in CI — per sei giorni.
 *
 * La riga che conta è la prima: topic claude-code + default openclaw NON è una
 * rotta verso il gateway.
 *
 * @covers CMD-08
 */
describe("routesThroughGateway", () => {
  test("topic claude-code su una macchina il cui default è openclaw → NON passa dal gateway", () => {
    expect(routesThroughGateway("claude-code", "openclaw")).toBe(false);
  });

  test("topic openclaw → passa dal gateway", () => {
    expect(routesThroughGateway("openclaw", "openclaw")).toBe(true);
  });

  test("topic senza provider esplicito → eredita il default del server", () => {
    expect(routesThroughGateway(null, "openclaw")).toBe(true);
    expect(routesThroughGateway(undefined, "claude-code")).toBe(false);
  });

  test("nessun provider dichiarato e nessun default → non si inventa il gateway", () => {
    expect(routesThroughGateway(null, undefined)).toBe(false);
  });
});

describe("declaredProviderName", () => {
  test("il nome dichiarato vince sul default, sempre", () => {
    expect(declaredProviderName("codex", "openclaw")).toBe("codex");
  });

  test("claude-code-team è il vecchio nome di claude-code", () => {
    expect(declaredProviderName("claude-code-team", "openclaw")).toBe("claude-code");
  });

  test("stringa vuota o soli spazi valgono come «non dichiarato»", () => {
    expect(declaredProviderName("", "openclaw")).toBe("openclaw");
    expect(declaredProviderName("   ", "openclaw")).toBe("openclaw");
  });

  test("senza dichiarazione né default resta undefined, non una stringa vuota", () => {
    expect(declaredProviderName(null, "")).toBeUndefined();
  });
});
