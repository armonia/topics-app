/**
 * @covers SPAFB-01
 */
import { describe, test, expect } from "bun:test";
import { shouldServeSpaFallback } from "./spa-fallback";
import { buildTabPath, encodeTabSegment } from "../shared/tab-link";

const HTML = "text/html,application/xhtml+xml";

describe("shouldServeSpaFallback", () => {
  test("serves the shell for a board deep-link navigation (/task/<uuid>)", () => {
    expect(shouldServeSpaFallback({
      method: "GET",
      pathname: "/task/d8ea2ff3-d412-4771-810d-401faa1d1754",
      accept: HTML,
    })).toBe(true);
  });

  test("serves the shell for a bare navigation path", () => {
    expect(shouldServeSpaFallback({ method: "GET", pathname: "/settings", accept: HTML })).toBe(true);
  });

  test("an unknown /api/* route is NOT masked (stays 404)", () => {
    expect(shouldServeSpaFallback({ method: "GET", pathname: "/api/does-not-exist", accept: HTML })).toBe(false);
  });

  test("a missing asset (path with an extension) is NOT masked (stays 404)", () => {
    expect(shouldServeSpaFallback({ method: "GET", pathname: "/assets/missing.js", accept: HTML })).toBe(false);
    expect(shouldServeSpaFallback({ method: "GET", pathname: "/favicon.ico", accept: HTML })).toBe(false);
    expect(shouldServeSpaFallback({ method: "GET", pathname: "/foo/bar.png", accept: HTML })).toBe(false);
  });

  test("a /ws path is never the shell", () => {
    expect(shouldServeSpaFallback({ method: "GET", pathname: "/ws/terminal/abc", accept: HTML })).toBe(false);
  });

  test("i metodi che non leggono non prendono mai la shell", () => {
    expect(shouldServeSpaFallback({ method: "POST", pathname: "/task/x", accept: HTML })).toBe(false);
    expect(shouldServeSpaFallback({ method: "DELETE", pathname: "/task/x", accept: HTML })).toBe(false);
  });

  // HEAD stava nella lista qui sopra insieme a POST: un link checker che chiedeva
  // «esiste /task/<uuid>?» leggeva 404 mentre il GET sullo stesso path dava 200.
  // RFC 9110 §9.3.2: HEAD = GET senza corpo, stesso status e stessi header.
  test("HEAD si comporta come GET (RFC 9110): stessa decisione su ogni path", () => {
    const paths = ["/task/d8ea2ff3-d412-4771-810d-401faa1d1754", "/settings", "/tab/project/my.app", "/assets/missing.js", "/api/does-not-exist", "/ws/terminal/abc"];
    for (const pathname of paths) {
      expect(shouldServeSpaFallback({ method: "HEAD", pathname, accept: HTML }))
        .toBe(shouldServeSpaFallback({ method: "GET", pathname, accept: HTML }));
    }
    // …e la decisione non è "false per tutti": la navigazione riceve la shell.
    expect(shouldServeSpaFallback({ method: "HEAD", pathname: "/settings", accept: HTML })).toBe(true);
  });

  test("a non-HTML client (no text/html Accept) does not get the shell", () => {
    expect(shouldServeSpaFallback({ method: "GET", pathname: "/task/x", accept: "application/json" })).toBe(false);
    expect(shouldServeSpaFallback({ method: "GET", pathname: "/task/x", accept: null })).toBe(false);
  });
});

// Il permalink a una tab (`shared/tab-link.ts`) porta chiavi che possono
// contenere un PUNTO — un path di progetto (`/Users/x/my.app`), un nome di file
// (`App.tsx`). La regola "ultimo segmento con estensione ⇒ asset" lo avrebbe
// 404-ato in silenzio. La grammatica lo evita già col base64url; questo è il
// secondo strato, quello che regge anche un link scritto a mano.
describe("shouldServeSpaFallback — permalink alle tab (/tab/)", () => {
  const nav = (pathname: string) => shouldServeSpaFallback({ method: "GET", pathname, accept: HTML });

  test("/tab/chat/<uuid> è una navigazione", () => {
    expect(nav("/tab/chat/d8ea2ff3-d412-4771-810d-401faa1d1754")).toBe(true);
  });

  test("/tab/file/<b64>/<b64> — i due segmenti encodati passano", () => {
    const path = buildTabPath({ kind: "file", key: "client/src/App.tsx", projectPath: "/Users/utente/Projects/my.app" })!;
    // Pre-condizione della grammatica: l'encoding non ha prodotto punti.
    expect(path).not.toContain(".");
    expect(nav(path)).toBe(true);
    // …e la forma esplicita, per non dipendere solo da buildTabPath.
    expect(nav(`/tab/file/${encodeTabSegment("/Users/x/my.app")}/${encodeTabSegment("src/App.tsx")}`)).toBe(true);
  });

  test("una /tab/ scritta a mano CON un punto dentro riceve comunque la shell", () => {
    // Il caso che l'allowlist esiste per coprire: chiave non encodata.
    expect(nav("/tab/project/my.app")).toBe(true);
    expect(nav("/tab/file/my.app/src/App.tsx")).toBe(true);
    expect(nav("/tab/panel/board")).toBe(true);
  });

  test("gli alias storici /task/ e /topic/ restano navigazioni", () => {
    expect(nav("/task/d8ea2ff3-d412-4771-810d-401faa1d1754")).toBe(true);
    expect(nav("/topic/a83b73e9-0d39-4b86-a829-cd62400f8a02")).toBe(true);
  });

  test("l'allowlist NON scavalca le guardie che le stanno sopra", () => {
    // POST su una /tab/ non è una navigazione.
    expect(shouldServeSpaFallback({ method: "POST", pathname: "/tab/chat/x", accept: HTML })).toBe(false);
    // Un client che non vuole HTML (il resolver, curl, l'agente) prende il 404.
    expect(shouldServeSpaFallback({ method: "GET", pathname: "/tab/chat/x", accept: "application/json" })).toBe(false);
    expect(shouldServeSpaFallback({ method: "GET", pathname: "/tab/chat/x", accept: null })).toBe(false);
    // E un /api/ sconosciuto resta un 404 vero, anche quello del resolver.
    expect(nav("/api/tabs/resolve")).toBe(false);
    expect(nav("/api/does-not-exist")).toBe(false);
  });
});
