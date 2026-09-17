/**
 * The rules an endpoint has to pass before anybody saves it.
 *
 * @covers MP-DIRECT-01
 */
import { describe, expect, test } from "bun:test";
import {
  isDirectProviderName,
  providerNameForEndpoint,
  slugifyEndpointLabel,
  validateDirectEndpoint,
} from "./direct-endpoints";

function ok(input: unknown) {
  const result = validateDirectEndpoint(input);
  if (!result.ok) throw new Error(`expected a valid endpoint, got: ${result.error}`);
  return result.value;
}

describe("slug and provider name", () => {
  test("a colon never survives into a provider name", () => {
    expect(slugifyEndpointLabel("Qwen 3 :: 3090")).toBe("qwen-3-3090");
    expect(providerNameForEndpoint({ id: slugifyEndpointLabel("Qwen 3 :: 3090") })).toBe("direct-qwen-3-3090");
  });

  test("accents and punctuation collapse to a readable slug", () => {
    expect(slugifyEndpointLabel("Località  Locale!")).toBe("localita-locale");
  });

  test("only the feature prefix counts as a direct provider", () => {
    expect(isDirectProviderName("direct-qwen")).toBe(true);
    expect(isDirectProviderName("openai")).toBe(false);
  });
});

describe("validateDirectEndpoint", () => {
  test("a minimal endpoint gets an id from its name and no authentication", () => {
    const value = ok({ label: "Local llama", baseUrl: "http://127.0.0.1:18080/v1/" });
    expect(value.id).toBe("local-llama");
    expect(value.auth).toBe("none");
    expect(value.baseUrl).toBe("http://127.0.0.1:18080/v1");
  });

  test("usage reporting is on unless it was turned off", () => {
    expect(ok({ label: "a", baseUrl: "http://10.0.0.2:8000" }).includeUsage).toBe(true);
    expect(ok({ label: "a", baseUrl: "http://10.0.0.2:8000", includeUsage: false }).includeUsage).toBe(false);
  });

  test("a declared context window is kept per model", () => {
    const value = ok({
      label: "Qwen",
      baseUrl: "http://127.0.0.1:18080/v1",
      contextWindows: { "qwen38-27b-200k": 200_192 },
    });
    expect(value.contextWindows).toEqual({ "qwen38-27b-200k": 200_192 });
  });

  const rejected: [string, unknown][] = [
    ["not an object", "http://127.0.0.1"],
    ["no name", { baseUrl: "http://127.0.0.1:1" }],
    ["a name with no letters or digits", { label: "***", baseUrl: "http://127.0.0.1:1" }],
    ["no URL", { label: "a" }],
    ["another scheme", { label: "a", baseUrl: "ftp://127.0.0.1" }],
    ["a file URL", { label: "a", baseUrl: "file:///etc/passwd" }],
    ["credentials inside the URL", { label: "a", baseUrl: "http://user:pass@127.0.0.1:1" }],
    ["an unknown authentication mode", { label: "a", baseUrl: "http://127.0.0.1:1", auth: "basic" }],
    ["a model list that is not a list", { label: "a", baseUrl: "http://127.0.0.1:1", modelFilter: "gpt" }],
    ["an empty model id", { label: "a", baseUrl: "http://127.0.0.1:1", modelFilter: ["gpt", " "] }],
    ["a timeout below a second", { label: "a", baseUrl: "http://127.0.0.1:1", timeoutMs: 10 }],
    ["a fractional timeout", { label: "a", baseUrl: "http://127.0.0.1:1", timeoutMs: 1500.5 }],
    ["a context window of zero", { label: "a", baseUrl: "http://127.0.0.1:1", contextWindows: { m: 0 } }],
  ];

  for (const [what, input] of rejected) {
    test(`refuses ${what}`, () => {
      const result = validateDirectEndpoint(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
    });
  }
});
