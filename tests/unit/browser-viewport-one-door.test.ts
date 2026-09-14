/**
 * THE VIEWPORT OF A SHARED PAGE IS APPLIED FROM ONE DOOR, AND THAT DOOR ASKS.
 *
 * This is a textual test, and what it is for is narrow: the RULE of
 * TOPIC-BROWSER-05 and the DECISION both live in modules with behavioural tests
 * (`browser-viewport-arbiter.ts`, `browser-viewport-wiring.ts`, whose suite
 * drives real frames through the real identity chain), but the socket branch of
 * `server.ts` still has to CALL them. Delete one of those calls and nothing
 * breaks loudly: types check, both module suites pass (they are pure and still
 * correct), the panes render. What comes back is the original bug, a phone that
 * merely watches reflowing the page under the hands of whoever is typing.
 *
 * So this file asks one question only: is the wiring still wired? It does NOT
 * check the decision any more. It used to try, by looking for the question
 * above the call that applied the size, and that was worth little: a mutant
 * that asked and ignored the answer read the same. The decision moved INTO the
 * wiring (`onFrame` applies the size itself, or does not) where a test can see
 * it happen.
 *
 * Two properties of a grep-in-a-test that bit us and are now handled: it must
 * read CODE, not comments (a commented-out call satisfied a `toContain`), and
 * it must fail loudly when it stops watching anything at all (a renamed symbol
 * would otherwise make it vacuously green).
 *
 * @covers TOPIC-BROWSER-05
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

/**
 * The file as lines, with comment LINES blanked out and the numbering kept.
 *
 * A commented-out `viewportWiring.onOpen(...)` used to keep this whole file
 * green, which is the one failure a textual test must not have. Only whole
 * comment lines go: blanking from every `//` would also eat the tail of a
 * string that contains a URL.
 */
function codeLines(relative: string): string[] {
  return readFileSync(join(ROOT, relative), "utf-8")
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      const isComment =
        trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
      return isComment ? "" : line;
    });
}

const codeOf = (relative: string): string => codeLines(relative).join("\n");

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

/** How far the dependency literal may stretch below its opening line. */
const DEPS_WINDOW_LINES = 20;

describe("una porta sola sul viewport condiviso", () => {
  it("in server.ts il resize della pagina condivisa lo applica solo il wiring", () => {
    // The socket branch does not resize any more, and cannot: it hands
    // `browserService.resize` to the wiring as a dependency and the wiring
    // calls it after asking the arbiter. That is why there is no `if` left
    // next to the call to mutate away. What this test defends is that nobody
    // adds a SECOND, unguarded call somewhere else in the file.
    const lines = codeLines("server.ts");
    const opening = lines.findIndex((line) => /createViewportWiring\(/.test(line));
    expect(opening, "server.ts non costruisce piu' il wiring del viewport").toBeGreaterThan(-1);

    const calls = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /browserService\.resize\(/.test(line));
    expect(calls.length, "nessuna chiamata a browserService.resize in server.ts").toBe(1);

    for (const { line, index } of calls) {
      const insideDeps = index > opening && index <= opening + DEPS_WINDOW_LINES;
      expect(
        insideDeps,
        `server.ts:${index + 1} applica un viewport fuori dalle dipendenze del wiring (${line.trim()})`,
      ).toBe(true);
    }
  });

  it("ogni frame del socket del browser passa dal wiring", () => {
    // `onFrame` is the door: input and resize both go through it, and it is
    // what decides. Two call sites, one per branch of the message handler.
    const source = codeOf("server.ts");
    const doorCalls = source.match(/viewportWiring\.onFrame\(/g) ?? [];
    expect(
      doorCalls.length,
      "i frame del socket non passano piu' dal wiring del viewport (input e resize)",
    ).toBe(2);
  });

  it("ogni pane dice il proprio nome aprendo il socket del browser", () => {
    // On this machine every client is the owner: without `?client=` the Mac
    // pane and a second window would be ONE claimant, and the arbiter would be
    // back to deciding by socket. Both hooks that open a browser socket send
    // it, the streaming one and the native one, because they are the same pane
    // before and after the flip.
    for (const hook of ["client/src/hooks/useRemoteBrowser.ts", "client/src/hooks/useTauriBrowser.ts"]) {
      expect(codeOf(hook), `${hook} apre il socket senza dire chi e'`).toContain(
        "client=${encodeURIComponent(browserClientId())}",
      );
    }
  });

  it("chi si registra come esecutore nativo esce dal pubblico dell'arbitro", () => {
    // The Tauri shell opens a socket on the context to EXECUTE, not to watch.
    // Left in the audience, its device queues as a spectator and the shell's
    // own streaming socket ends up behind a phone that is only looking.
    const lines = codeLines("server.ts");
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
    const lines = codeLines("server.ts");
    const disconnect = lines.findIndex((line) => /viewportWiring\.onClose\(/.test(line));
    expect(disconnect, "il close non avvisa piu' l'arbitro").toBeGreaterThan(-1);
    expect(
      /const \w+ = viewportWiring\.onClose\(/.test(lines[disconnect] ?? ""),
      "l'erede che onClose restituisce viene buttato via",
    ).toBe(true);
    const after = lines.slice(disconnect, disconnect + 25).join("\n");
    expect(
      /viewportWiring\.askViewportOf\(/.test(after),
      "nessuno chiede la misura al dispositivo che eredita il viewport",
    ).toBe(true);
  });

  it("l'arbitro sa quando una pane si affaccia sul contesto", () => {
    // Without this call nobody is in the audience, so the arbiter has no first
    // arrival to fall back on and the last resize wins again.
    expect(
      /viewportWiring\.onOpen\(/.test(codeOf("server.ts")),
      "nessuno avvisa l'arbitro quando una pane si affaccia sul contesto",
    ).toBe(true);
  });

  it("nessun altro file applica un viewport alla pagina condivisa", () => {
    for (const relative of SOURCES) {
      const source = codeOf(relative);
      if (!VIEWPORT_CALL.test(source)) continue;
      expect(
        DOORS.has(relative),
        `${relative} applica un viewport fuori dalle porte dichiarate in questo test`,
      ).toBe(true);
    }
  });
});
