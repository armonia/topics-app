/**
 * La sonda di 4.2 contro un DOM VERO.
 *
 * `DESCRIBE_ELEMENT_FN` vive dentro la pagina: niente `document` finto regge la
 * verifica che conta — `elementFromPoint`, `getComputedStyle` e il layout reale
 * sono esattamente le cose che un DOM simulato sbaglia. Quindi la si valuta in
 * un browser su `setContent`: nessun server dell'app di mezzo, test veloce.
 *
 * Copre quello che il test unitario non può: potatura del markup, filtro dello
 * stile calcolato e selettore risalente.
 *
 * @covers BROWSER-CHAT-04
 */
import { test, expect } from "@playwright/test";
import { DESCRIBE_ELEMENT_FN } from "../../shared/element-describe";
import { hermetic } from "./fixtures/hermetic";

// Questo file non tocca il server dell'app (gira su `setContent`), ma il confine
// si dichiara lo stesso: un'eccezione "tanto questa spec non sporca" è la crepa
// da cui il presidio smette di valere per tutti.
hermetic(test);

const PAGE = `
<!doctype html>
<html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: monospace; }
  .card { padding: 16px; background: rgb(240, 240, 240); }
  #cta { display: inline-flex; width: 200px; height: 40px; border-radius: 8px;
         background-color: rgb(0, 102, 255); color: rgb(255, 255, 255);
         font-weight: 700; }
  .deep { padding: 4px; }
</style></head>
<body>
  <main class="layout">
    <section class="card">
      <h2 class="t">Primo</h2>
      <h2 class="t">Secondo</h2>
      <button id="cta" class="btn primary extra ignored" data-role="buy">Compra ora</button>
    </section>
    <section class="card">
      <div class="deep">a<div class="deep">b<div class="deep">c<div class="deep">d<span>e</span></div></div></div></div>
    </section>
  </main>
</body></html>`;

/** Centro del riquadro di un selettore, in CSS px di viewport. */
async function centerOf(page: import("@playwright/test").Page, selector: string) {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, selector);
}

/** Un punto dentro il PADDING di un contenitore: al centro `elementFromPoint`
 *  restituirebbe il figlio che ci sta sopra, non il contenitore. */
async function paddingOf(page: import("@playwright/test").Page, selector: string) {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + 2), y: Math.round(r.top + 2) };
  }, selector);
}

test.describe("DESCRIBE_ELEMENT_FN", () => {
  test("descrive l'elemento con markup, stile calcolato e antenati", async ({ page }) => {
    await page.setContent(PAGE);
    const at = await centerOf(page, "#cta");
    const d = await page.evaluate(DESCRIBE_ELEMENT_FN, at);

    expect(d).not.toBeNull();
    expect(d!.cssPath).toBe("button#cta.btn.primary.extra"); // max 3 classi
    // Il selettore si FERMA al primo #id: da lì in su è già univoco.
    expect(d!.selector).toBe("button#cta");
    expect(d!.path).toMatch(/^\/html\/body\[1\]\/main\[1\]\/section\[1\]\/button\[1\]$/);
    expect(d!.ancestors).toEqual(["body", "main.layout", "section.card"]);
    expect(d!.text).toBe("Compra ora");

    // Markup completo, attributi inclusi.
    expect(d!.html).toContain('id="cta"');
    expect(d!.html).toContain('data-role="buy"');
    expect(d!.html).toContain("Compra ora</button>");
    expect(d!.htmlTruncated).toBe(false);

    // Stile CALCOLATO: c'è quello impostato…
    expect(d!.styles["display"]).toBe("inline-flex");
    expect(d!.styles["background-color"]).toBe("rgb(0, 102, 255)");
    expect(d!.styles["border-radius"]).toBe("8px");
    expect(d!.styles["font-weight"]).toBe("700");
    // …e NON quello al default, che sarebbe solo rumore da pagare a token.
    expect(d!.styles["transform"]).toBeUndefined();
    expect(d!.styles["position"]).toBeUndefined();
    expect(d!.styles["text-decoration"]).toBeUndefined();
    expect(d!.styles["padding"]).toBeUndefined();
    expect(d!.styles["box-shadow"]).toBeUndefined();
    expect(d!.styles["z-index"]).toBeUndefined();
    expect(d!.styles["overflow"]).toBeUndefined();
    // Il bordo di un <button> viene dallo user-agent: non è "impostato" nel
    // nostro CSS ma è VERO sullo schermo, e va detto.
    expect(d!.styles["border"]).toContain("outset");

    expect(d!.viewport.w).toBeGreaterThan(0);
    expect(d!.bbox.w).toBe(200);
    expect(d!.bbox.h).toBe(40);
  });

  test("il selettore distingue i fratelli con :nth-of-type", async ({ page }) => {
    await page.setContent(PAGE);
    const at = await centerOf(page, ".card h2:nth-of-type(2)");
    const d = await page.evaluate(DESCRIBE_ELEMENT_FN, at);
    expect(d!.selector).toContain("h2.t:nth-of-type(2)");
    // E rimanda davvero all'elemento giusto.
    const resolved = await page.evaluate(
      (sel) => document.querySelector(sel)?.textContent,
      d!.selector,
    );
    expect(resolved).toBe("Secondo");
  });

  test("i figli oltre la profondità massima si collassano, e l'HTML resta valido", async ({ page }) => {
    await page.setContent(PAGE);
    const at = await paddingOf(page, "section.card:nth-of-type(2) > .deep");
    const d = await page.evaluate(DESCRIBE_ELEMENT_FN, { ...at, maxDepth: 2 });

    // Il punto deve aver colpito il contenitore ESTERNO, non un annidato.
    expect(d!.ancestors).toEqual(["body", "main.layout", "section.card"]);
    expect(d!.htmlTruncated).toBe(true);
    expect(d!.html).toContain("figli omessi");
    expect(d!.html).not.toContain("<span>e</span>");
    // Tag di chiusura scritti comunque: quello che arriva si può ancora leggere
    // (e riparsare) invece di finire mozzato a metà.
    const balanced = await page.evaluate((html) => {
      const p = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
      return p.querySelector("parsererror") === null && p.body.textContent !== null;
    }, d!.html);
    expect(balanced).toBe(true);
  });

  test("il budget di caratteri taglia, ma lo DICHIARA", async ({ page }) => {
    await page.setContent(PAGE);
    const at = await centerOf(page, "main.layout");
    const d = await page.evaluate(DESCRIBE_ELEMENT_FN, { ...at, maxHtml: 80 });
    expect(d!.htmlTruncated).toBe(true);
    // Il budget vale per il contenuto; le chiusure si aggiungono comunque.
    expect(d!.html.length).toBeLessThan(300);
  });

  test("un punto fuori dalla pagina non inventa un elemento", async ({ page }) => {
    await page.setContent(PAGE);
    const d = await page.evaluate(DESCRIBE_ELEMENT_FN, { x: -50, y: -50 });
    expect(d).toBeNull();
  });
});
