import { describe, test, expect } from "bun:test";
import { declaredProviderName, fallbackModelFor, reasoningCommandText, reasoningElsewhereMessage, routesThroughGateway } from "./commandRouting";
import { sessionStatus } from "./sessionStatus";

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

describe("/reasoning carries what was typed (CMD-08)", () => {
  // The client never sent a level and the route defaulted to "on": on openclaw
  // a «toggle» could only switch reasoning on.
  test("the typed level is passed through", () => {
    expect(reasoningCommandText("off")).toBe("/reasoning off");
    expect(reasoningCommandText(" stream ")).toBe("/reasoning stream");
  });

  test("bare is forwarded bare: the gateway toggles it", () => {
    expect(reasoningCommandText(undefined)).toBe("/reasoning");
    expect(reasoningCommandText("  ")).toBe("/reasoning");
  });

  test("elsewhere the answer names the DECLARED provider, not claude-code everywhere", () => {
    expect(reasoningElsewhereMessage("codex")).toContain("Su codex");
    expect(reasoningElsewhereMessage("codex")).not.toContain("claude-code");
    expect(reasoningElsewhereMessage("gemini")).toContain("/effort");
  });
});

describe("/status names the model of an unpinned topic (CMD-07)", () => {
  const registry: Record<string, { defaultModel?(): string | null }> = {
    "claude-code": { defaultModel: () => "claude-sonnet-5" },
    codex: { defaultModel: () => "gpt-5.5" },
  };
  const lookup = (name: string) => registry[name];

  test("an unpinned topic gets the default of the provider it declares", () => {
    expect(fallbackModelFor("codex", "claude-code", lookup)).toBe("gpt-5.5");
    expect(fallbackModelFor(null, "claude-code", lookup)).toBe("claude-sonnet-5");
  });

  test("a provider not registered here gives no model, never the default's", () => {
    expect(fallbackModelFor("gemini", "claude-code", lookup)).toBeNull();
  });

  test("and the report says it is a default", () => {
    const out = sessionStatus({ sessionKey: "topic:x", topic: {}, modelloDiRipiego: fallbackModelFor(null, "claude-code", lookup) });
    expect(out).toContain("Modello: claude-sonnet-5 (default, non fissato qui)");
  });
});
