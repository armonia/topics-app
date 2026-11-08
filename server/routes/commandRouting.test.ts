import { describe, test, expect } from "bun:test";
import { declaredProviderName, fallbackModelFor, reasoningElsewhereMessage } from "./commandRouting";
import { sessionStatus } from "./sessionStatus";

/**
 * Il provider DICHIARATO decide, non quello risolto: su un runner senza la CLI
 * `claude` il provider `claude-code` non è registrato e la risoluzione ripiega
 * sul default, ma un topic non cambia natura per un binario mancante.
 *
 * @covers CMD-08
 */
describe("declaredProviderName", () => {
  test("il nome dichiarato vince sul default, sempre", () => {
    expect(declaredProviderName("codex", "native")).toBe("codex");
  });

  test("claude-code-team è il vecchio nome di claude-code", () => {
    expect(declaredProviderName("claude-code-team", "native")).toBe("claude-code");
  });

  test("stringa vuota o soli spazi valgono come «non dichiarato»", () => {
    expect(declaredProviderName("", "native")).toBe("native");
    expect(declaredProviderName("   ", "native")).toBe("native");
  });

  test("senza dichiarazione né default resta undefined, non una stringa vuota", () => {
    expect(declaredProviderName(null, "")).toBeUndefined();
  });
});

describe("/reasoning (CMD-08)", () => {
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
