/**
 * The Hetzner adapter reads the location of a server from either API shape:
 * the current one puts `location` on the server, the older one under
 * `datacenter`. The price must come from the price list of THAT location, not
 * from whichever price comes first.
 * @covers HETZNER-LOC-1
 */
import { describe, expect, test } from "bun:test";
import { hetznerAdapter, HETZNER_API_ENV } from "./machine-providers";

const prices = [
  { location: "nbg1", price_hourly: { gross: "0.0100" }, price_monthly: { gross: "5.00" } },
  { location: "hel1", price_hourly: { gross: "0.0200" }, price_monthly: { gross: "9.00" } },
];

/** Recorded response of the current API: `location` on top, no `datacenter`. */
const recordedNew = {
  servers: [{
    name: "node-hel",
    status: "running",
    created: "2026-10-01T00:00:00Z",
    public_net: { ipv4: { ip: "203.0.113.7" } },
    location: { name: "hel1", city: "Helsinki", country: "FI" },
    server_type: { name: "cx22", prices },
  }],
};

/** Recorded response of the older API: the location under `datacenter`. */
const recordedOld = {
  servers: [{
    name: "node-hel",
    status: "running",
    created: "2026-10-01T00:00:00Z",
    public_net: { ipv4: { ip: "203.0.113.7" } },
    datacenter: { location: { name: "hel1", city: "Helsinki", country: "FI" } },
    server_type: { name: "cx22", prices },
  }],
};

const now = Date.parse("2026-11-13T12:00:00Z");

async function listWith(body: unknown) {
  const fetchImpl = (async () => Response.json(body)) as unknown as typeof fetch;
  return hetznerAdapter.listServers("token", fetchImpl, now);
}

describe("hetzner adapter: location from both API shapes", () => {
  test.each([
    ["current API (location on the server)", recordedNew],
    ["older API (datacenter.location)", recordedOld],
  ])("%s: city and country, price from the hel1 price list", async (_label, body) => {
    const [server] = await listWith(body);
    expect(server.facts.location).toBe("Helsinki, FI");
    // hel1 is the second price: prices[0] (nbg1, 5.00) would be wrong.
    expect(server.facts.monthly).toEqual({ amount: 9, currency: "EUR" });
  });

  test("the location name alone when city is missing", async () => {
    const body = structuredClone(recordedNew);
    delete (body.servers[0].location as { city?: string }).city;
    const [server] = await listWith(body);
    expect(server.facts.location).toBe("hel1");
  });

  test("the base URL override is honoured", async () => {
    process.env[HETZNER_API_ENV] = "http://fake.invalid/v1/";
    try {
      let asked = "";
      const fetchImpl = (async (url: string) => { asked = String(url); return Response.json({ servers: [] }); }) as unknown as typeof fetch;
      await hetznerAdapter.listServers("token", fetchImpl, now);
      expect(asked).toBe("http://fake.invalid/v1/servers?per_page=50");
    } finally {
      delete process.env[HETZNER_API_ENV];
    }
  });
});
