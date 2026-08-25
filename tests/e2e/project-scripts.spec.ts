/**
 * Gli script di un progetto, da qualunque manifest.
 *
 * Prima si leggeva `package.json` e basta: su un progetto Rust, Python, Go o
 * retto da un Makefile la sezione Processi era vuota per sempre e non diceva
 * perche — `ScriptRunner` faceva `return null`. I comandi c'erano, solo che
 * nessuno li guardava, e l'esecutore aveva `npm run` cablato quindi non avrebbe
 * saputo lanciarli comunque.
 *
 * I parser stanno in `server/lib/project-scripts.ts` e sono verificati contro
 * gli strumenti veri (`make -pRrq`, `deno task`, `cargo metadata`). Qui si
 * prova il resto: che arrivino allo schermo, che si lancino, e che quando non
 * c'e niente la sezione lo DICA.
 *
 * @covers PROCESS-01
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { resetPaneStore, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";

hermetic(test);

const RUST = `/tmp/e2e-scripts-rust-${Date.now()}`;
const NUDA = `/tmp/e2e-scripts-nuda-${Date.now()}`;

async function apriProcessi(page: import("@playwright/test").Page, path: string) {
  const win = page.locator(`[data-testid="project-window"][data-project-path="${path}"]`);
  await expect(win).toHaveCount(1, { timeout: 15000 });
  const riga = win.locator('[data-testid="project-sidebar-processes"]');
  await expect(riga).toBeVisible({ timeout: 10000 });
  if ((await riga.getAttribute("aria-expanded")) !== "true") await riga.click();
  return win;
}

test.describe("script del progetto", () => {
  test.beforeAll(() => {
    // Un progetto SENZA package.json: prima era una sezione muta per sempre.
    mkdirSync(`${RUST}/src`, { recursive: true });
    writeFileSync(`${RUST}/Cargo.toml`, '[package]\nname = "esempio"\nversion = "0.1.0"\n');
    writeFileSync(`${RUST}/src/main.rs`, "fn main() {}\n");
    writeFileSync(`${RUST}/Makefile`, "VAR := non:un:target\n\n.PHONY: fmt\n\nfmt:\n\t@echo formattato\n\nciao:\n\t@echo ciao\n");
    mkdirSync(NUDA, { recursive: true });
    writeFileSync(`${NUDA}/note.txt`, "niente da lanciare\n");
  });
  test.afterAll(() => {
    rmSync(RUST, { recursive: true, force: true });
    rmSync(NUDA, { recursive: true, force: true });
  });

  test("un progetto Rust con Makefile mostra i comandi di tutt'e due", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await seedProjectPane(request, RUST);
    await waitForPaneStoreQuiet(request);
    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const win = await apriProcessi(page, RUST);

    const runner = win.locator('[data-testid="script-runner"]');
    await expect(runner).toBeVisible({ timeout: 10000 });

    // L'aggancio e l'id, non il testo: la riga mostra nome + manifest e
    // `getByText` legge il testo concatenato.
    const ids = await runner.locator("[data-script-id]").evaluateAll(
      els => els.map(e => e.getAttribute("data-script-id")));

    // Cargo: i tre comandi standard. `run` senza `--bin` perche c'e un binario
    // solo — quello implicito di `src/main.rs`, che nel TOML non e scritto.
    expect(ids).toContain("Cargo.toml#build");
    expect(ids).toContain("Cargo.toml#test");
    expect(ids).toContain("Cargo.toml#run");

    // Makefile: i target veri, e NON l'assegnamento coi due punti.
    expect(ids).toContain("Makefile#fmt");
    expect(ids).toContain("Makefile#ciao");
    expect(ids.some(i => i?.includes("VAR"))).toBe(false);

    // Con piu di un manifest ogni riga dice da dove viene, altrimenti «test»
    // di Cargo e «test» di npm sarebbero indistinguibili.
    await expect(runner.locator('[data-script-from="Cargo.toml"]').first()).toBeVisible();
    await expect(runner.locator('[data-script-from="Makefile"]').first()).toBeVisible();
    await expect(runner.locator('[data-script-id="Cargo.toml#test"]')).toContainText("Cargo.toml");
  });

  test("un target di Makefile si lancia davvero, non con npm", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await seedProjectPane(request, RUST);
    await waitForPaneStoreQuiet(request);
    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const win = await apriProcessi(page, RUST);
    const runner = win.locator('[data-testid="script-runner"]');
    await expect(runner).toBeVisible({ timeout: 10000 });

    await runner.locator('[data-script-id="Makefile#ciao"]').click();

    // Il processo compare fra quelli noti al server col comando GIUSTO:
    // `make ciao`, non `npm run ciao` (che fallirebbe: non c'e package.json).
    await expect.poll(async () => {
      const r = await request.get("/api/scripts");
      const d = await r.json();
      return (d.scripts ?? []).map((s: { command: string }) => s.command);
    }, { timeout: 20000 }).toContain("make ciao");
  });

  test("una cartella senza manifest lo DICE, e dice cosa ha guardato", async ({ page, request }) => {
    // Prima: `return null`, la sezione si apriva sul vuoto. Il silenzio non
    // distingue «qui non c'e niente» da «non ho guardato».
    await resetPaneStore(request, []);
    await seedProjectPane(request, NUDA);
    await waitForPaneStoreQuiet(request);
    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const win = await apriProcessi(page, NUDA);

    const vuoto = win.locator('[data-testid="script-runner-empty"]');
    await expect(vuoto).toBeVisible({ timeout: 10000 });
    await expect(vuoto).toContainText("Nessun manifest");
    // E l'elenco di cosa cerca, che e la parte che rende l'assenza leggibile.
    await expect(vuoto).toContainText("package.json");
    await expect(vuoto).toContainText("Makefile");
    await expect(vuoto).toContainText("Cargo.toml");
  });
});
