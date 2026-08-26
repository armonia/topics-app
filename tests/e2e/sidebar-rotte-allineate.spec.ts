/**
 * LE RIGHE DELLA SIDEBAR PARTONO DALLA STESSA COLONNA.
 *
 * Segnalato: «se non c'è l'icona dell'accordion va bene che arrivi a sinistra,
 * al massimo differenziamo icona progetto da icona chat e facciamo tutto
 * consistente. Le rotte dovevano essere allineate, e metti un'icona ai progetti
 * che non hanno l'icona, come è allineata a quelli della chat».
 *
 * Le due righe usano le stesse costanti (`ROW_PX` per il rientro, `ROW_GAP` per
 * lo spazio), quindi sulla carta sono allineate. Ma la riga PROGETTO monta
 * `ProjectFavicon` senza `fallback`, e un progetto la cui cartella non porta
 * una favicon rende NIENTE: ingombro zero. Il gap però resta, quindi il nome di
 * quel progetto parte da una x diversa da quella di un progetto che l'icona ce
 * l'ha, e diversa da quella di una chat (che un glifo ce l'ha sempre).
 *
 * Non è la stessa decisione di «niente monogrammi» (16/07): lì si
 * vietava di INVENTARE un'identità (una lettera, una tessera colorata) per un
 * progetto che non ne ha una. Qui serve solo che la colonna del testo sia una
 * sola, cioè un segnaposto neutro che non dice niente e occupa lo spazio.
 *
 * Si misura la x del NOME rispetto alla riga, che è la sola cosa che l'occhio
 * confronta scorrendo una colonna.
  * @covers ROWALIGN-01
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const STAMP = Date.now();
/** Un progetto la cui cartella porta una favicon vera. */
const CON_ICONA = `/tmp/e2e-rotte-con-${STAMP}`;
/** E uno che non ce l'ha: è il caso del difetto. */
const SENZA_ICONA = `/tmp/e2e-rotte-senza-${STAMP}`;

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** La x del testo di una riga, RELATIVA alla riga: righe diverse stanno a
 *  altezze diverse ma devono cominciare dalla stessa colonna. */
async function xDelNome(page: Page, sel: string): Promise<number | null> {
  return page.locator(sel).first().evaluate((el) => {
    // Il primo span che porta testo e non contiene un'icona: è il nome.
    const nome = [...el.querySelectorAll("span")].find(
      (s) => s.textContent?.trim() && !s.querySelector("svg, img"),
    );
    if (!nome) return null;
    return +(nome.getBoundingClientRect().left - el.getBoundingClientRect().left).toFixed(1);
  });
}

test.describe("Sidebar · le rotte partono dalla stessa colonna", () => {
  test.describe.configure({ timeout: 90_000 });
  const creati: string[] = [];

  test.beforeAll(async ({ request }) => {
    mkdirSync(CON_ICONA, { recursive: true });
    writeFileSync(`${CON_ICONA}/favicon.png`, Buffer.from(PNG_1x1, "base64"));
    mkdirSync(SENZA_ICONA, { recursive: true });
    // Una chat dentro ciascuno, così le due righe progetto compaiono.
    creati.push((await createTopic(request, `E2E-Rotte-Con-${STAMP}`, { projectPath: CON_ICONA })).id);
    creati.push((await createTopic(request, `E2E-Rotte-Senza-${STAMP}`, { projectPath: SENZA_ICONA })).id);
  });

  test.afterAll(async ({ request }) => {
    for (const id of creati) await deleteTopic(request, id).catch(() => {});
  });

  test("ROTTE-01: il nome di un progetto senza favicon parte dalla stessa x di uno che ce l'ha", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "ROWALIGN-01" });
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    const conIcona = `[data-testid="project-toggle-${CON_ICONA.split("/").pop()}"]`;
    const senzaIcona = `[data-testid="project-toggle-${SENZA_ICONA.split("/").pop()}"]`;
    await expect(page.locator(conIcona)).toBeVisible({ timeout: 15000 });
    await expect(page.locator(senzaIcona)).toBeVisible({ timeout: 15000 });
    // L'icona vera arriva da una fetch: senza aspettarla si misurerebbe il
    // momento in cui NESSUNO dei due ce l'ha, cioè due righe uguali per il
    // motivo sbagliato.
    await expect(page.locator(`${conIcona} img`)).toBeVisible({ timeout: 15000 });

    const xCon = await xDelNome(page, conIcona);
    const xSenza = await xDelNome(page, senzaIcona);
    expect(xCon, "il progetto con icona deve avere un nome misurabile").not.toBeNull();
    expect(xSenza).not.toBeNull();

    // I NUMERI OSSERVATI, sempre, anche quando passa: senza, un verde dice solo
    // «non e' peggiorato» e non permette di rispondere a «di quanto era fuori?».
    console.log(`[ROTTE-01] con favicon x=${xCon} · senza favicon x=${xSenza} · scarto ${Math.abs(xCon! - xSenza!).toFixed(1)}px`);
    expect(
      Math.abs(xCon! - xSenza!),
      `il nome parte da due colonne diverse: con icona x=${xCon}, senza icona x=${xSenza}`,
    ).toBeLessThanOrEqual(0.5);
  });
});
