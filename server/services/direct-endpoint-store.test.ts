/**
 * The endpoint file, and the secret that must not live next to the API keys.
 *
 * @covers MP-DIRECT-01
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteDirectEndpoint,
  getDirectEndpoint,
  listDirectEndpoints,
  readEndpointSecret,
  saveDirectEndpoint,
  writeEndpointSecret,
} from "./direct-endpoint-store";
import { validateDirectEndpoint, type DirectEndpointConfig } from "../../shared/direct-endpoints";

const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "direct-endpoints-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function endpoint(label: string, url = "http://127.0.0.1:18080/v1"): DirectEndpointConfig {
  const result = validateDirectEndpoint({ label, baseUrl: url });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe("the endpoint file", () => {
  test("an endpoint survives the round trip and the file is private", () => {
    const dir = root();
    saveDirectEndpoint(endpoint("Local llama"), dir);
    expect(listDirectEndpoints(dir).map((entry) => entry.id)).toEqual(["local-llama"]);
    expect(getDirectEndpoint("local-llama", dir)?.baseUrl).toBe("http://127.0.0.1:18080/v1");
    expect(statSync(join(dir, "direct-endpoints.json")).mode & 0o777).toBe(0o600);
  });

  test("saving the same id replaces it in place instead of duplicating it", () => {
    const dir = root();
    saveDirectEndpoint(endpoint("Local llama"), dir);
    saveDirectEndpoint(endpoint("Other"), dir);
    saveDirectEndpoint(endpoint("Local llama", "http://10.0.0.5:8000/v1"), dir);
    const all = listDirectEndpoints(dir);
    expect(all.map((entry) => entry.id)).toEqual(["local-llama", "other"]);
    expect(all[0].baseUrl).toBe("http://10.0.0.5:8000/v1");
  });

  test("a damaged file reads as no endpoints, it does not throw", () => {
    const dir = root();
    writeFileSync(join(dir, "direct-endpoints.json"), "{ not json", "utf8");
    expect(listDirectEndpoints(dir)).toEqual([]);
  });

  test("one invalid entry does not cost the valid ones", () => {
    const dir = root();
    writeFileSync(
      join(dir, "direct-endpoints.json"),
      JSON.stringify([{ label: "broken" }, { label: "Good", baseUrl: "http://10.0.0.5:8000" }]),
      "utf8",
    );
    expect(listDirectEndpoints(dir).map((entry) => entry.id)).toEqual(["good"]);
  });

  test("a missing file is simply an empty list", () => {
    expect(listDirectEndpoints(root())).toEqual([]);
  });
});

describe("the bearer token", () => {
  test("it is stored apart from the endpoint, and never inside it", () => {
    const dir = root();
    saveDirectEndpoint(endpoint("Gateway", "https://gateway.example.com/v1"), dir);
    writeEndpointSecret("gateway", "tok-abc", dir);
    expect(readEndpointSecret("gateway", dir)).toBe("tok-abc");
    expect(readFileSync(join(dir, "direct-endpoints.json"), "utf8")).not.toContain("tok-abc");
    expect(statSync(join(dir, ".topics-secrets", "direct-endpoint-secrets.json")).mode & 0o777).toBe(0o600);
  });

  test("it does not sit in the file that holds the API keys", () => {
    const dir = root();
    writeEndpointSecret("gateway", "tok-abc", dir);
    const names = readFileSync(join(dir, ".topics-secrets", "direct-endpoint-secrets.json"), "utf8");
    expect(names).toContain("gateway");
    expect(() => readFileSync(join(dir, ".topics-secrets", "providers.json"), "utf8")).toThrow();
  });

  test("deleting an endpoint takes its token with it", () => {
    const dir = root();
    saveDirectEndpoint(endpoint("Gateway", "https://gateway.example.com/v1"), dir);
    writeEndpointSecret("gateway", "tok-abc", dir);
    deleteDirectEndpoint("gateway", dir);
    expect(listDirectEndpoints(dir)).toEqual([]);
    expect(readEndpointSecret("gateway", dir)).toBeUndefined();
  });
});
