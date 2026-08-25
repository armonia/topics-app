/**
 * @covers HEADPAR-01
 */
import { test, expect } from "@playwright/test";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * PARITÀ GET/HEAD sui file statici — RFC 9110 §9.3.2.
 *
 * Il guasto misurato l'11/08 sul server vivo (:3333): `GET /assets/index-<hash>.js`
 * → 200, `HEAD` sullo STESSO path → 404, e `HEAD /` → 404. Ogni ramo statico di
 * `server.ts` era montato sul solo `method === "GET"`, quindi un HEAD scivolava
 * oltre tutte le rotte e finiva nel 404 finale.
 *
 * Non è un caso di laboratorio: HEAD è il verbo di cache, proxy, link checker e
 * sonde di salute. Chi lo usa per chiedere «esiste? è cambiato?» si sentiva
 * rispondere «non esiste» e agiva di conseguenza — invalida, riscarica, segnala
 * un link morto. `curl -I` per leggere i Cache-Control del bundle faceva credere
 * che la app fosse rotta.
 *
 * Questo file è la barra: per lo stesso path confronta GET e HEAD e pretende
 * stesso status, stessi header e corpo VUOTO su HEAD. Vale per la shell
 * (`/`, `/index.html`) e per un asset con hash — cioè i due path del rapporto.
 *
 * Niente fixture ermetica: sono richieste HTTP pure, non tocca il DB.
 */

/**
 * Header che possono legittimamente differire fra due risposte, anche fra due
 * GET consecutivi: la data e i dettagli di framing della connessione. Tutto il
 * resto — content-type, cache-control, content-length — deve coincidere.
 */
const VOLATILE = new Set(["date", "connection", "keep-alive", "transfer-encoding"]);

async function parity(request: import("@playwright/test").APIRequestContext, path: string, accept?: string) {
  const headers = accept ? { accept } : undefined;
  const get = await request.get(`${E2E_BASE}${path}`, { headers });
  const head = await request.head(`${E2E_BASE}${path}`, { headers });

  expect(head.status(), `${path}: HEAD deve dare lo stesso status di GET`).toBe(get.status());
  expect(get.status(), `${path}: il GET di riferimento deve essere un 200`).toBe(200);

  // Stessi header, campo per campo — è la ragione per cui si usa HEAD (leggere
  // Cache-Control / Content-Length senza scaricare il corpo).
  const strip = (h: Record<string, string>) =>
    Object.fromEntries(Object.entries(h).filter(([k]) => !VOLATILE.has(k.toLowerCase())));
  expect(strip(head.headers()), `${path}: gli header di HEAD devono combaciare con quelli di GET`)
    .toEqual(strip(get.headers()));

  // …e il corpo è vuoto, mentre il GET ne ha uno.
  expect((await head.body()).length, `${path}: HEAD non deve avere corpo`).toBe(0);
  expect((await get.body()).length, `${path}: il GET di riferimento deve avere un corpo`).toBeGreaterThan(0);

  return get;
}

test.describe("Statici: HEAD risponde come GET, senza corpo", () => {
  test("la shell (/ e /index.html) e un asset con hash hanno parità GET/HEAD", async ({ request }) => {
    // La shell. È il `HEAD /` → 404 del rapporto.
    const shell = await parity(request, "/");
    await parity(request, "/index.html");

    // L'asset con hash, preso dalla shell servita adesso: nessun hash cablato,
    // così il test non scade al prossimo build.
    const html = await shell.text();
    const asset = html.match(/\/assets\/[A-Za-z0-9._-]+\.js/)?.[0];
    expect(asset, "index.html deve referenziare almeno un /assets/*.js").toBeTruthy();
    const assetGet = await parity(request, asset!);
    // Il motivo per cui si fa HEAD su un asset: leggerne la cache. Se l'header
    // non arrivasse più, la parità sarebbe verde ma inutile.
    expect(assetGet.headers()["cache-control"]).toContain("immutable");
  });

  test("una navigazione client (/task/<uuid>) risponde a HEAD come a GET", async ({ request }) => {
    // Il ramo SPA-fallback: un link checker che chiede «questo permalink esiste?»
    // deve leggere lo stesso 200 di chi lo apre.
    await parity(request, "/task/d8ea2ff3-d412-4771-810d-401faa1d1754", "text/html,application/xhtml+xml");
  });

  test("HEAD non inventa 200: un asset inesistente resta 404 come su GET", async ({ request }) => {
    // Il contrario del guasto — montare HEAD non deve trasformare il verbo in un
    // «esiste sempre», altrimenti la sonda mente nell'altro verso.
    const path = "/assets/questo-file-non-esiste-mai.js";
    const get = await request.get(`${E2E_BASE}${path}`);
    const head = await request.head(`${E2E_BASE}${path}`);
    expect(get.status()).toBe(404);
    expect(head.status()).toBe(404);
  });
});
