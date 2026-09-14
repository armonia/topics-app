/**
 * The guard in front of a configured endpoint: the LAN is allowed, the
 * metadata address is not, and a redirect does not buy a way around it.
 *
 * @covers MP-DIRECT-02
 */
import { describe, expect, test } from "bun:test";
import { checkEndpointUrl, fetchCheckedEndpoint, EndpointUrlError, type AddressResolver } from "./private-endpoint-url";

const never: AddressResolver = async () => { throw new Error("no resolution expected"); };

const allowed: string[] = [
  "http://127.0.0.1:18080/v1",
  "http://localhost:18080/v1",
  "http://10.0.0.5:8000",
  "http://172.16.3.4:8000",
  "http://192.168.1.50:1234/v1",
  "http://100.92.197.74:18080/v1", // tailnet
  "http://[fd00::1]:8080",
  "http://[::1]:8080",
  "https://api.example.com/v1",
];

const refused: [string, string][] = [
  ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
  ["link-local IPv6", "http://[fe80::1]:8080"],
  ["the unspecified network", "http://0.0.0.0:8080"],
  ["IPv6 unspecified", "http://[::]:8080"],
  ["multicast", "http://224.0.0.1:8080"],
  ["another scheme", "ftp://10.0.0.1/"],
  ["a file URL", "file:///etc/passwd"],
  ["credentials in the URL", "http://user:secret@10.0.0.1/"],
];

const resolvesTo = (address: string, family = 4): AddressResolver => async () => [{ address, family }];

describe("checkEndpointUrl", () => {
  for (const url of allowed) {
    test(`allows ${url}`, async () => {
      const verdict = await checkEndpointUrl(url, resolvesTo("93.184.216.34"));
      expect(verdict.ok).toBe(true);
    });
  }

  for (const [what, url] of refused) {
    test(`refuses ${what}`, async () => {
      const verdict = await checkEndpointUrl(url, never);
      expect(verdict.ok).toBe(false);
    });
  }

  test("a name resolving to the metadata address is refused", async () => {
    const verdict = await checkEndpointUrl("http://models.internal/v1", resolvesTo("169.254.169.254"));
    expect(verdict.ok).toBe(false);
  });

  test("a name resolving to the LAN is allowed", async () => {
    const verdict = await checkEndpointUrl("http://models.internal/v1", resolvesTo("192.168.1.7"));
    expect(verdict.ok).toBe(true);
  });

  test("one bad address among several is enough to refuse", async () => {
    const mixed: AddressResolver = async () => [
      { address: "192.168.1.7", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ];
    const verdict = await checkEndpointUrl("http://models.internal/v1", mixed);
    expect(verdict.ok).toBe(false);
  });

  test("a name that does not resolve is refused, not retried", async () => {
    const verdict = await checkEndpointUrl("http://nowhere.invalid/v1", never);
    expect(verdict.ok).toBe(false);
  });
});

describe("fetchCheckedEndpoint", () => {
  test("a redirect towards the metadata address is refused before it is followed", async () => {
    const seen: string[] = [];
    const doFetch = (async (url: string) => {
      seen.push(String(url));
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    }) as unknown as typeof fetch;

    await expect(
      fetchCheckedEndpoint("http://127.0.0.1:18080/v1/models", {}, never, doFetch),
    ).rejects.toBeInstanceOf(EndpointUrlError);
    expect(seen).toEqual(["http://127.0.0.1:18080/v1/models"]);
  });

  test("a redirect inside the private network is followed", async () => {
    const seen: string[] = [];
    const doFetch = (async (url: string) => {
      seen.push(String(url));
      return seen.length === 1
        ? new Response(null, { status: 307, headers: { location: "http://10.0.0.9:8000/v1/models" } })
        : new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const response = await fetchCheckedEndpoint("http://127.0.0.1:18080/v1/models", {}, never, doFetch);
    expect(response.status).toBe(200);
    expect(seen).toEqual(["http://127.0.0.1:18080/v1/models", "http://10.0.0.9:8000/v1/models"]);
  });

  test("a redirect loop stops instead of spinning", async () => {
    const doFetch = (async () =>
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1:18080/v1/models" } })) as unknown as typeof fetch;
    await expect(
      fetchCheckedEndpoint("http://127.0.0.1:18080/v1/models", {}, never, doFetch),
    ).rejects.toBeInstanceOf(EndpointUrlError);
  });
});
