/**
 * scripts/ui-app/serve.mjs - shared by the scripts that drive the built
 * preview (walk, crawl, phone, shots): serves `client/dist-ui/` on a loopback
 * port and collects the page's errors, so every script fails the same way on
 * a console error, an exception or a missing file. `serveDist` can serve
 * another build folder of `client/` (`dist-ui-mutant`, the planted-defect
 * build of the bar) instead of the default one.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DIST = join(ROOT, "client/dist-ui");

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json", ".pdf": "application/pdf",
};

/**
 * Starts the server; resolves to `{ base, close }` where base is the URL of the
 * entry without hash: `app` (the multi-organization preview), `orbit` (the
 * ORBIT edition) or `consorzio` (the Consorzio edition). `dist` is the build
 * folder under `client/` (default `dist-ui`).
 */
export async function serveDist(script, entry = "app", dist = "dist-ui") {
  const root = join(ROOT, "client", dist);
  if (!existsSync(join(root, `${entry}.html`))) {
    console.error(`${script}: client/${dist}/${entry}.html is missing, run \`bun run build:ui\` first.`);
    process.exit(1);
  }
  const server = createServer(async (req, res) => {
    const path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(path);
      res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { base: `http://127.0.0.1:${server.address().port}/${entry}.html`, close: () => server.close() };
}

/** Wires the error listeners of a page into `errors` (strings). */
export function collectErrors(page, errors) {
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => { if (!r.url().startsWith("data:")) errors.push(`requestfailed: ${r.url()}`); });
  page.on("response", (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`); });
}

export const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
export const flag = (name) => process.argv.includes(`--${name}`);
