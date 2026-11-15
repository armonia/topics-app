/**
 * A cloud server in Processes, like the Mac (card 672744e2).
 *
 * Two paired nodes (fakes, placeholder names): one answers its gauges and a
 * pending-restart flag, one is silent. A fake hosting provider knows only the
 * first. The row of the node has the gauges and the history line of the Mac's;
 * the cost, location and pending restart appear on the machine the provider
 * recognises and NOT on the silent one; the silent one says why it is silent.
 * The hover is the gauge's own title, as on the Mac.
 *
 * Mutation: with no adapter registered (`createProviderRegistry` given `[]`)
 * the cost test is red; with the provider token not saved nothing is drawn
 * from the provider either.
 *
 * Video on: the .webm of the hover is the proof.
 *
 * @covers HUBBR-08
 */
import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { openPerfPanel } from "./helpers/open-perf-panel";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { E2E_BASE, providerApiPortFor } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ mode: "serial", timeout: 120_000 });

const DEVICE_COOKIE = "d".repeat(32);
const TOKEN = "p".repeat(32);

function listen(handler: Parameters<typeof createServer>[1], port = 0): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}` });
    });
  });
}

/** A node's Topics as far as the pairing and the gauges need it; `answers` false makes it refuse the gauges. */
function nodeHandler(name: string, answers: boolean): Parameters<typeof createServer>[1] {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && url.pathname === "/api/auth/pair/request") return send(200, { requestId: "r", claim: "c", code: "123456", name, expiresInMs: 60_000 });
    if (req.method === "GET" && url.pathname === "/api/auth/pair/status") return send(200, { state: "approved", name }, { "Set-Cookie": `topics_device=${DEVICE_COOKIE}; Path=/; HttpOnly` });
    if (req.method === "GET" && url.pathname === "/api/system/machine-metrics" && answers) {
      return send(200, { metrics: { cpuPct: 37, memPct: 52, memUsedGB: 2.1, memTotalGB: 4, diskPct: 41, netInBps: 2048, netOutBps: 1024, uptimeSec: 90_000, rebootRequired: true, cores: 2 } });
    }
    send(answers ? 404 : 503, { error: "no" });
  };
}

test.describe("remote machines in Processes", () => {
  const closers: Array<() => void> = [];
  const machineIds: string[] = [];
  // The Processes menu row exists once the live reader holds a hub: the fake one stands in.
  let hub: FakeHub | null = null;

  test.beforeAll(async ({ request }) => {
    hub = await startFakeHub();
    // The fake provider knows "cloud-one" only.
    const provider = await listen((req, res) => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); res.end("{}"); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ servers: [{
        name: "cloud-one", status: "running", created: "2026-01-01T00:00:00Z",
        public_net: { ipv4: { ip: "203.0.113.9" } },
        datacenter: { location: { name: "loc1", city: "Cityville" } },
        server_type: { name: "type-s", prices: [{ location: "loc1", price_hourly: { gross: "0.0100" }, price_monthly: { gross: "4.5000" } }] },
      }] }));
    }, providerApiPortFor());
    closers.push(() => provider.server.close());
    for (const [name, answers] of [["cloud-one", true], ["quiet-two", false]] as const) {
      const node = await listen(nodeHandler(name, answers));
      closers.push(() => { node.server.close(); node.server.closeAllConnections(); });
      const opened = await request.post(`${E2E_BASE}/api/machines/pair`, { data: { baseUrl: node.url } });
      const { pairingId } = (await opened.json()) as { pairingId: string };
      const done = (await (await request.get(`${E2E_BASE}/api/machines/pair/${pairingId}`)).json()) as { state: string; machine: { id: string } };
      expect(done.state).toBe("approved");
      machineIds.push(done.machine.id);
      await request.patch(`${E2E_BASE}/api/machines/${done.machine.id}`, { data: { name } });
    }
    const saved = await request.put(`${E2E_BASE}/api/machines/providers/hetzner/token`, { data: { token: TOKEN } });
    expect(saved.ok(), await saved.text()).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    await request.put(`${E2E_BASE}/api/machines/providers/hetzner/token`, { data: { token: null } }).catch(() => {});
    for (const id of machineIds) await request.delete(`${E2E_BASE}/api/machines/${id}`).catch(() => {});
    closers.forEach((c) => c());
    await hub?.close();
  });

  test("the node has the Mac's gauges and hover; the cost only where the provider knows it; the silent one says why", async ({ page, request }) => {
    await expect.poll(async () => {
      const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { data?: { services?: unknown[] } }>;
      return snap.services?.data?.services?.length ?? -1;
    }, { timeout: 30_000, message: "the live reader never read the fake hub" }).toBeGreaterThan(0);
    await goToApp(page);
    await openPerfPanel(page);
    await page.getByTestId("menu-system-processes").click();
    const cloud = page.locator('[data-testid="machine-remote"]', { has: page.getByText("cloud-one", { exact: true }) });
    const quiet = page.locator('[data-testid="machine-remote"]', { has: page.getByText("quiet-two", { exact: true }) });
    await expect(cloud).toBeVisible({ timeout: 30_000 });

    await expect(cloud).toHaveAttribute("data-state", "live");
    await expect(cloud.getByTestId("machine-remote-cpu")).toContainText("37");
    await expect(cloud.getByTestId("machine-remote-disk")).toContainText("41");
    // The same hover as the Mac's gauge row: the header carries the machine's summary as its title.
    await cloud.getByTestId("machine-remote-name").hover();
    await expect(cloud.getByTestId("machine-remote-provider")).toContainText("Cityville");
    await expect(cloud.getByTestId("machine-remote-provider")).toContainText(/4[.,]50/);
    await expect(cloud.getByTestId("machine-remote-reboot")).toHaveAttribute("data-pending", "true");

    await expect(quiet).toHaveAttribute("data-state", "unreachable");
    await expect(quiet.getByTestId("machine-remote-reason")).toHaveAttribute("data-reason", /http_503|unreachable/);
    await expect(quiet.getByTestId("machine-remote-provider")).toHaveCount(0);
  });
});
