/**
 * THE VIEWPORT OF A SHARED PAGE IS APPLIED FROM ONE DOOR, AND THAT DOOR ASKS.
 *
 * This is a textual test, and the reason it is worth having is that the failure
 * it guards is silent AND invisible to every other gate. The RULE of
 * TOPIC-BROWSER-05 lives in two modules with tests of their own
 * (`browser-viewport-arbiter.ts`, `browser-viewport-wiring.ts`), but the socket
 * branch of `server.ts` still has to CALL them: tell the wiring that a pane
 * opened, that an input arrived, ask before applying a `resize`, and ask the
 * heir for its size when the driver leaves. Delete any one of those calls and
 * nothing breaks loudly. Types still check, both module suites still pass (they
 * are pure and still correct), the panes still render. What comes back is the
 * original bug: a phone that merely watches reflows the page under the hands of
 * whoever is typing on a laptop.
 *
 * The only witness that covers those calls end to end needs a server-side
 * Chromium, and that one does not run on pull requests (see
 * `NIGHTLY_ONLY_SPECS` in playwright.config.ts). So the wiring was removable
 * with the PR gate green. A grep in a test is ugly, and it holds where a type
 * cannot: TypeScript has no way to say "this call must exist, and must be
 * preceded by that question".
 *
 * @covers TOPIC-BROWSER-05
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

/** How far back the question may sit from the call it guards. */
const GUARD_WINDOW_LINES = 8;

/**
 * Every place allowed to hand a viewport to the shared page, and why.
 *
 * `server/routes/browser.ts` is the REST `resize` action: a deliberate tool
 * call ("make the page 1280 wide"), not a pane streaming the size of its own
 * container. It has no socket and no client behind it, so there is nothing for
 * the arbiter to arbitrate. It is listed here so that adding a second pane
 * path through REST would have to move this comment first.
 */
const DOORS = new Set([
  "server.ts",
  "server/routes/browser.ts",
  "server/browser-service.ts",
]);

const SOURCES = [
  "server.ts",
  "server/routes/browser.ts",
  "server/browser-service.ts",
  "server/browser-viewport-arbiter.ts",
  "server/browser-viewport-wiring.ts",
  "client/src/hooks/useRemoteBrowser.ts",
];

const VIEWPORT_CALL = /browserService\.resize\(|\.setViewportSize\(/;

describe("una porta sola sul viewport condiviso", () => {
  it("il resize che arriva da un socket passa dall'arbitro", () => {
    const lines = readFileSync(join(ROOT, "server.ts"), "utf-8").split("\n");
    const calls = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /browserService\.resize\(/.test(line));

    // If this is zero the test has stopped watching anything: the call moved
    // out of server.ts and this file has to be pointed at its new home.
    expect(calls.length, "nessuna chiamata a browserService.resize in server.ts").toBeGreaterThan(0);

    for (const { line, index } of calls) {
      const before = lines.slice(Math.max(0, index - GUARD_WINDOW_LINES), index).join("\n");
      expect(
        /viewportWiring\.onResize\(/.test(before),
        `server.ts:${index + 1} applica un viewport senza chiedere all'arbitro (${line.trim()})`,
      ).toBe(true);
    }
  });

  it("chi si registra come esecutore nativo esce dal pubblico dell'arbitro", () => {
    // The Tauri shell opens a socket on the context to EXECUTE, not to watch.
    // Left in the audience, its device queues as a spectator and the shell's
    // own streaming socket ends up behind a phone that is only looking.
    const source = readFileSync(join(ROOT, "server.ts"), "utf-8");
    const lines = source.split("\n");
    const registered = lines.findIndex((line) => /delegated === 'registered'/.test(line));
    expect(registered, "il ramo della registrazione nativa non e' piu' in server.ts").toBeGreaterThan(-1);
    const branch = lines.slice(registered, registered + 20).join("\n");
    expect(
      /viewportWiring\.onNativeExecutor\(/.test(branch),
      "l'esecutore nativo resta nel pubblico dell'arbitro del viewport",
    ).toBe(true);
  });

  it("quando il driver esce, al successore si chiede la misura", () => {
    // The heir already sent this size once and deduplicates it, so without the
    // question the page keeps the viewport of whoever just left.
    const source = readFileSync(join(ROOT, "server.ts"), "utf-8");
    const lines = source.split("\n");
    const disconnect = lines.findIndex((line) => /viewportWiring\.onClose\(/.test(line));
    expect(disconnect, "il close non avvisa piu' l'arbitro").toBeGreaterThan(-1);
    expect(
      /const \w+ = viewportWiring\.onClose\(/.test(lines[disconnect] ?? ""),
      "l'erede che noteDisconnect restituisce viene buttato via",
    ).toBe(true);
    const after = lines.slice(disconnect, disconnect + 25).join("\n");
    expect(
      /viewportWiring\.askViewportOf\(/.test(after),
      "nessuno chiede la misura al dispositivo che eredita il viewport",
    ).toBe(true);
  });

  it("l'apertura di una pane e ogni input arrivano all'arbitro", () => {
    // Without the first call nobody is in the audience, so the arbiter has no
    // first arrival to fall back on and the last resize wins again. Without the
    // second one nobody ever becomes the driver: the page belongs forever to
    // whoever connected first, and using it stops meaning anything.
    const source = readFileSync(join(ROOT, "server.ts"), "utf-8");
    expect(
      /viewportWiring\.onOpen\(/.test(source),
      "nessuno avvisa l'arbitro quando una pane si affaccia sul contesto",
    ).toBe(true);
    expect(
      /viewportWiring\.onInput\(/.test(source),
      "nessuno avvisa l'arbitro quando un client usa la pagina",
    ).toBe(true);
  });

  it("nessun altro file applica un viewport alla pagina condivisa", () => {
    for (const relative of SOURCES) {
      const source = readFileSync(join(ROOT, relative), "utf-8");
      if (!VIEWPORT_CALL.test(source)) continue;
      expect(
        DOORS.has(relative),
        `${relative} applica un viewport fuori dalle porte dichiarate in questo test`,
      ).toBe(true);
    }
  });
});
