/**
 * board-theme.spec.ts — la Board deve essere LEGGIBILE anche in tema chiaro.
 *
 * La Board era l'unico pezzo di app scritto su una palette dark cablata:
 * 277 `text-neutral-*` (fino a `text-neutral-100`, cioè quasi bianco) più le
 * superfici `bg-neutral-800/900/950` e i bordi `border-white/10`, in 10 file
 * sotto `client/src/components/Board/`. Zero occorrenze di `neutral-*` nel
 * resto del client: era una palette parallela, non una scelta di tema.
 *
 * Conseguenza in chiaro: testo quasi bianco su fondo chiaro, e bordi bianchi
 * su superfici bianche — cioè le card sparivano. Non è un dettaglio estetico,
 * è illeggibilità.
 *
 * Questo test NON è uno screenshot: misura il CONTRASTO reale (WCAG 2.1) fra
 * il colore calcolato del testo e lo sfondo calcolato risalendo gli antenati,
 * nei DUE temi. Con la palette vecchia falliva in chiaro con un rapporto
 * intorno a 1 (bianco su bianco). Gli screenshot li allega comunque, come
 * prova durevole per l'umano.
 *
 * Il tema si pilota con `emulateMedia({ colorScheme })`: il default di Topics è
 * `themeMode: 'system'` (`useTheme.ts`), che risolve via `matchMedia` e ha già
 * un listener sul cambio — quindi è il percorso vero, non una forzatura della
 * classe `.dark`.
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = `/tmp/e2e-board-theme-${Date.now()}`;

/** BYTE-IDENTICAL to server/services/tasks.ts:projectIdForPath. */
function boardIdForPath(projectPath: string): string {
  const parts = projectPath.replace(/\/+$/, "").split("/");
  const dirName = parts[parts.length - 1] || "project";
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = ((hash << 5) - hash) + projectPath.charCodeAt(i);
    hash |= 0;
  }
  return dirName + "-" + Math.abs(hash).toString(36).slice(0, 6);
}
const PROJECT_ID = boardIdForPath(PROJECT_PATH);

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = page
    .locator('[aria-label="Topics sidebar"] button')
    .filter({ hasText: /e2e-board-theme/ })
    .first();
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });

  const triggers = page.getByTestId("pane-add-menu-trigger");
  const count = await triggers.count();
  const item = page.getByTestId("pane-add-menu-kanban");
  let opened = false;
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    const clicked = await t.click({ timeout: 3000 }).then(() => true, () => false);
    if (!clicked) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) {
      opened = true;
      break;
    }
    await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

/**
 * Contrasto WCAG 2.1 fra il testo di un elemento e il primo sfondo OPACO
 * risalendo gli antenati (una card con `bg-surface` è opaca; un chip con
 * `bg-white/10` no, e allora conta quello che ha sotto).
 */
async function contrastOf(page: Page, selector: string): Promise<{ ratio: number; color: string; bg: string }> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`nessun elemento per il selettore ${sel}`);

    // Il colore lo normalizza il BROWSER, non una regex. `getComputedStyle`
    // non restituisce sempre `rgb()`: per la palette interna di Tailwind v4
    // torna `oklch(0.97 0 0)`, e una regex su `rgba?\(` lo leggeva come
    // [0,0,0,0] — cioè nero trasparente. Risultato: il controllo con la
    // palette vecchia dava 21:1 in chiaro (nero su bianco) invece di ~1:1
    // (quasi-bianco su bianco), cioè il test giurava che la Board illeggibile
    // fosse a posto. Un canvas 1×1 accetta qualunque sintassi CSS che il
    // browser sappia parsare (oklch, color(), hsl, nomi) e restituisce RGBA
    // veri, alpha compresa.
    const probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    const ctx = probe.getContext("2d", { willReadFrequently: true })!;
    const parse = (s: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = s; // se `s` è impresentabile resta "#000": lo vediamo dal contrasto
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    // Composita gli sfondi traslucidi uno sull'altro finché non se ne trova uno
    // opaco: è quello che l'occhio vede davvero sotto il testo.
    const effectiveBg = (start: Element): [number, number, number] => {
      const stack: [number, number, number, number][] = [];
      let node: Element | null = start;
      while (node) {
        const [r, g, b, a] = parse(getComputedStyle(node).backgroundColor);
        if (a > 0) {
          stack.push([r, g, b, a]);
          if (a >= 1) break;
        }
        node = node.parentElement;
      }
      // Nessuno sfondo opaco trovato: il fondo pagina fa da base.
      let [br, bg_, bb] = [255, 255, 255];
      for (let i = stack.length - 1; i >= 0; i--) {
        const [r, g, b, a] = stack[i];
        br = r * a + br * (1 - a);
        bg_ = g * a + bg_ * (1 - a);
        bb = b * a + bb * (1 - a);
      }
      return [br, bg_, bb];
    };

    const lum = (r: number, g: number, b: number) => {
      const f = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };

    const cs = getComputedStyle(el);
    const [cr, cg, cb] = parse(cs.color);
    const [br, bg_, bb] = effectiveBg(el);
    const l1 = lum(cr, cg, cb);
    const l2 = lum(br, bg_, bb);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    return {
      ratio,
      color: `rgb(${Math.round(cr)}, ${Math.round(cg)}, ${Math.round(cb)})${cs.color.startsWith("rgb") ? "" : ` [${cs.color}]`}`,
      bg: `rgb(${Math.round(br)}, ${Math.round(bg_)}, ${Math.round(bb)})`,
    };
  }, selector);
}

test.describe("Board — leggibilità nei due temi", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-board-theme" }, null, 2));
    const topic = await createTopic(request, "E2E-Board-Theme", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
    const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, {
      data: { text: "Card di prova per il contrasto", status: "todo" },
    });
    expect(res.ok()).toBe(true);
    const task = (await res.json()) as { id: string };
    createdTasks.push(`${PROJECT_ID}:${task.id}`);
  });

  test.afterAll(async ({ request }) => {
    for (const key of createdTasks) {
      const [pid, tid] = key.split(":");
      await deleteTask(request, pid, tid);
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  // UN TEST PER TEMA, non un ciclo dentro un test solo. La Board è un pane
  // SINGLETON nel gruppo: appena la apri, `availableTypesForGroup` toglie la
  // voce «Board» dal menu «+», quindi la seconda passata del ciclo trovava un
  // menu senza board e moriva con «no + menu with a Board (kanban) entry
  // found» — un errore che parla del menu mentre il problema è il workspace
  // sporco. Due test separati prendono ognuno il `beforeEach` che azzera
  // pane-store globale e layout di progetto, e falliscono uno per volta
  // dicendo QUALE tema è rotto.
  for (const scheme of ["dark", "light"] as const) {
    test(`BOARD-THEME-01 (${scheme}): la card della board è leggibile`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/");
      await openProjectBoard(page);

      const card = page.locator("[data-task-card]").first();
      await expect(card).toBeVisible({ timeout: 10000 });

      // Il tema è davvero cambiato: la classe `.dark` sull'<html> è la stessa
      // leva che usa il resto dell'app.
      const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
      expect(isDark, `colorScheme=${scheme} deve produrre .dark=${scheme === "dark"}`).toBe(scheme === "dark");

      const { ratio, color, bg } = await contrastOf(page, "[data-task-card]");
      testInfo.annotations.push({
        type: "contrasto",
        description: `${scheme}: ${ratio.toFixed(2)}:1 — testo ${color} su ${bg}`,
      });
      // AA per testo normale. Con la palette vecchia in chiaro era ~1.05:1
      // (quasi-bianco su bianco): non "poco elegante", illeggibile.
      expect(ratio, `contrasto card in tema ${scheme} (testo ${color} su ${bg})`).toBeGreaterThanOrEqual(4.5);

      await testInfo.attach(`board-${scheme}.png`, {
        body: await page.getByTestId("kanban-board").screenshot(),
        contentType: "image/png",
      });
    });
  }
});
