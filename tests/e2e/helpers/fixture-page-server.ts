import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A page from `tests/e2e/fixtures/`, served on a loopback port by the TEST
 * process, for specs that drive the server-side headless browser and assert on
 * what the page CONTAINS.
 *
 * Why not a live site: `https://example.com` dropped its `<h1>` in September
 * 2026 and the extract assertion went red with no change on our side. A third
 * party page is an external boundary, and the e2e rule is to replace external
 * boundaries, not to depend on them.
 *
 * Why a loopback server and not `/api/media`: the agent open path accepts any
 * http URL (`assertAgentNavAllowed` checks the scheme only), the headless
 * browser runs on the same machine as the test server, and
 * `browser-loopback-navigates.spec.ts` already proves that route end to end.
 * `/api/media` would tie the fixture to the media allowlist and the app data
 * roots of the test server, which is a different contract than the one these
 * specs are about.
 *
 * Only the fixture itself is served; every other path answers 404.
 */
export interface FixturePage {
  /** Absolute loopback URL of the fixture, e.g. `http://127.0.0.1:54321/agent-control-page.html`. */
  url: string;
  /** Host and port, for assertions that check where a context navigated. */
  host: string;
  close: () => Promise<void>;
}

export async function serveFixturePage(fileName: string): Promise<FixturePage> {
  const body = readFileSync(resolve(__dirname, "../fixtures", fileName));
  const route = `/${fileName}`;
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split(/[?#]/)[0];
    if (req.method === "GET" && path === route) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const host = `127.0.0.1:${port}`;
  return {
    url: `http://${host}${route}`,
    host,
    // The headless browser keeps its connection alive: drop it, or `close`
    // waits for the keep-alive timeout.
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
