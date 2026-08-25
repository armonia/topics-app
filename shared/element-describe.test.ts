/**
 * The description of a page element picked in the browser pane, as it reaches
 * the chat.
 *
 * @covers BROWSER-CHAT-04
 */
import { describe, expect, test } from "bun:test";
import { formatElementContext, type ElementDescription } from "./element-describe";

function desc(over: Partial<ElementDescription> = {}): ElementDescription {
  return {
    path: "/html/body[1]/div[1]/button[2]",
    cssPath: "button.cta",
    selector: "main > div.card > button.cta",
    bbox: { x: 120, y: 340, w: 96, h: 32 },
    html: '<button class="cta">Compra</button>',
    htmlTruncated: false,
    ancestors: ["body", "div#root", "main.layout"],
    styles: { display: "inline-flex", color: "rgb(255, 255, 255)" },
    viewport: { w: 1280, h: 720 },
    url: "https://example.test/prodotto",
    ...over,
  };
}

describe("formatElementContext", () => {
  test("mette markup e stile in due blocchi separati e etichettati", () => {
    const out = formatElementContext(desc());
    expect(out).toContain("```html\n<button class=\"cta\">Compra</button>\n```");
    expect(out).toContain("```css");
    expect(out).toContain("display: inline-flex;");
    expect(out).toContain("color: rgb(255, 255, 255);");
    // Il selettore serve a ritrovare l'elemento: deve esserci sempre.
    expect(out).toContain("main > div.card > button.cta");
  });

  test("dichiara la potatura invece di far sembrare il markup completo", () => {
    const full = formatElementContext(desc());
    expect(full).not.toContain("potato");
    const cut = formatElementContext(desc({ htmlTruncated: true }));
    expect(cut).toContain("potato");
  });

  test("annuncia il ritaglio solo quando l'host lo ha davvero allegato", () => {
    expect(formatElementContext(desc())).not.toContain("allegato");
    expect(formatElementContext(desc(), { screenshotAttached: true })).toContain("allegato");
  });

  test("niente blocco css quando lo stile è tutto al default", () => {
    const out = formatElementContext(desc({ styles: {} }));
    expect(out).not.toContain("```css");
    expect(out).toContain("```html");
  });

  test("le righe opzionali spariscono invece di comparire vuote", () => {
    const out = formatElementContext(
      desc({ selector: "", ancestors: [], url: "", text: undefined }),
    );
    expect(out).not.toContain("- selettore:");
    expect(out).not.toContain("- antenati:");
    expect(out).not.toContain("- pagina:");
    expect(out).not.toContain("- testo:");
    // Quelle non opzionali restano.
    expect(out).toContain("- percorso:");
    expect(out).toContain("- riquadro: 120,340 · 96×32 px");
  });
});
