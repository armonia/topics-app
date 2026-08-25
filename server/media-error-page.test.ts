/**
 * @covers MEDIAERR-01
 */
import { test, expect, describe } from "bun:test";
import { wantsHtml, mediaErrorHtml } from "./media-error-page";

describe("wantsHtml", () => {
  // Le navigazioni chiedono html per prime; un <img> o un fetch() no. La
  // distinzione serve a non cambiare la forma della risposta sotto i piedi al
  // codice che la controlla (le immagini delle card leggono il JSON).
  test("una navigazione vuole la pagina", () => {
    expect(wantsHtml("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe(true);
    expect(wantsHtml("text/html")).toBe(true);
  });

  test("un <img>, un fetch o un Accept assente vogliono il JSON di sempre", () => {
    expect(wantsHtml("image/avif,image/webp,*/*")).toBe(false);
    expect(wantsHtml("*/*")).toBe(false);
    expect(wantsHtml("application/json")).toBe(false);
    expect(wantsHtml(null)).toBe(false);
    expect(wantsHtml("")).toBe(false);
  });
});

describe("mediaErrorHtml", () => {
  const page = mediaErrorHtml({
    path: "/etc/passwd",
    title: "Questo file non posso servirlo",
    detail: "È fuori dalle cartelle consentite.",
  });

  test("dice il file, il motivo, ed è una pagina vera", () => {
    expect(page).toStartWith("<!doctype html>");
    expect(page).toContain("/etc/passwd");
    expect(page).toContain("Questo file non posso servirlo");
    expect(page).toContain("È fuori dalle cartelle consentite.");
  });

  test("non sbianca in tema scuro", () => {
    // La pane non dichiara il suo tema: una pagina con fondo bianco fisso su
    // un'app scura è, di nuovo, un lampo bianco.
    expect(page).toContain("prefers-color-scheme: dark");
    expect(page).toContain("color-scheme: light dark");
  });

  test("il percorso finisce nel testo, non nel markup", () => {
    // Il path arriva da chi chiama: se passasse per HTML sarebbe una
    // iniezione in una pagina che serviamo noi, su una porta locale.
    const nasty = mediaErrorHtml({
      path: '/tmp/<script>alert("x")</script>',
      title: "t",
      detail: "d",
    });
    expect(nasty).not.toContain("<script>alert");
    expect(nasty).toContain("&lt;script&gt;");
  });
});
