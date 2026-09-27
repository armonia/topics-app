/**
 * board-task-changes-panel.spec.ts: the "Modifiche" panel answers the right
 * question, and keeps answering it after the land.
 *
 * Three states, on a REAL git repo and a real worktree:
 *
 *  1. The card's branch is born from ANOTHER branch (as it was before
 *     `worktree-base-ref.ts`, and still is for every branch born then): it
 *     carries a commit that is not its own. The panel must list ONE file, its
 *     own, and head the list with that file's total alone. With
 *     `merge-base main HEAD` it listed two, and the card claimed another
 *     session's work.
 *
 *  2. The land: merge on main and worktree reaped. Here the panel used to
 *     vanish (`no_worktree`, nothing drawn) exactly when it matters most, once
 *     the work is done. It must stay, reading from the merge, and SAY so.
 *
 *  3. Nothing to rebuild from: it must say that. A missing panel and a panel
 *     saying "I could not look" are the same picture to a reviewer, and they
 *     are opposite verdicts.
 *
 * The task stays in `todo`: in review a comment wakes the dispatcher, and what
 * is under test here is what the drawer DRAWS, not the delivery.
 *
 * Then the same panel shows a changed file as what it is (DIFFPV-02..05): a
 * picture as a Before/After pair read at the two revisions the bundle names,
 * a README rendered with its image read at the README's own revision, a
 * renamed text file read whole with its review note still on its row, the
 * pair still right after the land even in a panel opened before it, and a
 * byte route that reads nothing the bundle does not name.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { deflateSync } from "zlib";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const API = `${BASE}/api`;

interface WorktreeRow { id: string; status: string; absPath: string; branchName: string }

// Canonical spelling (`/private/tmp` on macOS): the board id is hashed from the
// resolved projectPath, so a literal `/tmp` wrote the card to a board the pane
// never read — locally only, the Linux runner has a real `/tmp`.
const REPO = canonicalTmpDir("topics-e2e-changespanel");
const PROJECT_ID = boardIdForPath(REPO);
/** Il ramo dell'altra sessione: è da qui che il worktree della card nasce. */
const ALTRA = "topics/altra-sessione";

let topicId: string | null = null;
let landedTopicId: string | null = null;
let orphanTopicId: string | null = null;
let taskId: string | null = null;
let landedTaskId: string | null = null;
let orphanTaskId: string | null = null;
let worktreePath: string | null = null;
let landedPath: string | null = null;
let landedBranch: string | null = null;
let imagesTopicId: string | null = null;
let imagesTaskId: string | null = null;
let imagesPath: string | null = null;
let imagesBranch: string | null = null;
/** Out of every worktree: what a symlink must not be able to serve. */
const OUTSIDE = `${REPO}-outside`;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
}

/** The CRC-32 every PNG chunk ends with (the zlib polynomial). */
function cyclicCheck(buf: Buffer): number {
  let sum = 0xffffffff;
  for (const b of buf) {
    sum ^= b;
    for (let k = 0; k < 8; k++) sum = sum & 1 ? (sum >>> 1) ^ 0xedb88320 : sum >>> 1;
  }
  return (sum ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(cyclicCheck(body), 8 + data.length);
  return out;
}

/** Twelve numbered lines, the `changed` ones rewritten: the text file the images card renames. */
function numberedLines(changed: number[] = []): string {
  return Array.from({ length: 12 }, (_, i) => (changed.includes(i + 1) ? `riga ${i + 1} cambiata` : `riga ${i + 1}`)).join("\n") + "\n";
}

/** A real, decodable solid-colour PNG: its size in pixels is what the pair reports after loading it. */
function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour RGB
  const row = Buffer.from([0, ...Array.from({ length: width }, () => rgb).flat()]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /topics-e2e-changespanel/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });

  const alreadyOpen = page.getByTestId("kanban-board");
  if (await alreadyOpen.waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false)) return;

  const triggers = page.getByTestId("pane-add-menu-trigger");
  const count = await triggers.count();
  const item = page.getByTestId("pane-add-menu-kanban");
  let opened = false;
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) { opened = true; break; }
    await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("nessun menu + con la voce Board");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

/** Apre il drawer di un task dalla colonna Todo. */
// The changes bar lives in the DELIVERY band since the drawer became tabbed
// (e113ca7bb): the drawer opens on the conversation, and the band that carries
// the diff is not even mounted until it is asked for. Opening it here keeps
// every case below reading as "open the card, look at the panel".
async function openTask(page: Page, title: string) {
  await page.getByTestId("kanban-column-todo").getByText(title).click();
  const drawer = page.getByTestId("task-detail-drawer");
  await expect(drawer).toBeVisible({ timeout: 10000 });
  await drawer.getByTestId("task-delivery-toggle").click();
  await expect(drawer.getByTestId("task-delivery-panel")).toBeVisible({ timeout: 10000 });
  return drawer;
}

test.describe.serial("Board · il pannello Modifiche", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    // 1. Repo vero. `main` porta il file di partenza.
    mkdirSync(REPO, { recursive: true });
    writeFileSync(`${REPO}/package.json`, JSON.stringify({ name: "e2e-changespanel" }, null, 2));
    writeFileSync(`${REPO}/lista.txt`, "uno\ndue\n");
    // The picture and the README the images card changes: 1x1 on main.
    mkdirSync(`${REPO}/assets`, { recursive: true });
    writeFileSync(`${REPO}/assets/logo.png`, png(1, 1, [30, 30, 200]));
    writeFileSync(`${REPO}/README.md`, "# Vecchio titolo\n");
    // The text file the images card renames and changes on one line.
    mkdirSync(`${REPO}/docs`, { recursive: true });
    writeFileSync(`${REPO}/docs/vecchio.txt`, numberedLines());
    git(REPO, ["init", "-q", "-b", "main"]);
    git(REPO, ["add", "-A"]);
    git(REPO, ["commit", "-q", "-m", "init"]);

    // 2. L'ALTRA sessione, parcheggiata sul checkout condiviso con il suo commit.
    git(REPO, ["checkout", "-q", "-b", ALTRA]);
    writeFileSync(`${REPO}/roba-di-un-altro.ts`, "export const nonMio = 1;\n");
    git(REPO, ["add", "-A"]);
    git(REPO, ["commit", "-q", "-m", "lavoro di un'altra sessione"]);
    git(REPO, ["checkout", "-q", "main"]);

    const proj = await request.post(`${API}/projects`, { data: { name: `e2e-changespanel-${Date.now()}`, path: REPO } });
    expect(proj.ok()).toBe(true);
    const project = (await proj.json()) as { id: string };

    async function makeWorktree(baseRef: string): Promise<WorktreeRow> {
      const res = await request.post(`${API}/worktrees`, { data: { project_id: project.id, mode: "branch", base_ref: baseRef } });
      expect(res.status()).toBe(202);
      const created = (await res.json()) as { id: string };
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const got = await request.get(`${API}/worktrees/${created.id}`);
        if (got.ok()) {
          const row = (await got.json()) as WorktreeRow;
          if (row.status !== "pending") {
            if (row.status !== "ready") throw new Error(`worktree non pronto: ${row.status}`);
            return row;
          }
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error("worktree mai pronto");
    }

    /** Un task legato alla sua chat, com'è dopo un dispatch. */
    async function makeTask(text: string, worktreeId: string | null): Promise<{ taskId: string; topicId: string }> {
      const topic = await createTopic(request, `E2E-ChangesPanel-${text}`, { projectPath: REPO });
      if (worktreeId) expect((await request.patch(`${API}/topics/${topic.id}`, { data: { worktreeId } })).ok()).toBe(true);
      const res = await request.post(`${API}/boards/${PROJECT_ID}/tasks`, { data: { text, status: "todo" } });
      expect(res.ok()).toBe(true);
      const id = ((await res.json()) as { id: string }).id;
      expect((await request.post(`${API}/test/tasks/${id}/bind-topic`, { data: { topicId: topic.id } })).ok()).toBe(true);
      return { taskId: id, topicId: topic.id };
    }

    // 3. La card MISTA: il suo worktree nasce dal ramo dell'altra sessione, quindi
    //    il suo ramo porta anche un commit che non è suo.
    const wt = await makeWorktree(ALTRA);
    worktreePath = wt.absPath;
    writeFileSync(`${wt.absPath}/consegna.ts`, "export const mio = 1;\nexport const anche = 2;\n");
    git(wt.absPath, ["add", "-A"]);
    git(wt.absPath, ["commit", "-q", "-m", "la consegna della card"]);
    ({ taskId, topicId } = await makeTask("Card con worktree", wt.id));

    // 4. La card PULITA, nata da main: è quella che il land fa atterrare con un
    //    `merge --no-ff` (per un ramo misto il land ricopia i commit, non fonde).
    const wtL = await makeWorktree("main");
    landedPath = wtL.absPath;
    landedBranch = wtL.branchName;
    writeFileSync(`${wtL.absPath}/atterrata.ts`, "export const uno = 1;\nexport const due = 2;\n");
    git(wtL.absPath, ["add", "-A"]);
    git(wtL.absPath, ["commit", "-q", "-m", "il lavoro che atterra"]);
    ({ taskId: landedTaskId, topicId: landedTopicId } = await makeTask("Card atterrata", wtL.id));

    // 5b. The IMAGES card, born from main: a picture changed and committed
    //     (1x1 -> 3x2), a README that shows it, a text file renamed with its
    //     line 9 changed, and a picture never committed.
    const wtI = await makeWorktree("main");
    imagesPath = wtI.absPath;
    imagesBranch = wtI.branchName;
    writeFileSync(`${wtI.absPath}/assets/logo.png`, png(3, 2, [200, 30, 30]));
    // Plus what a delivered file must not do in the preview: run an
    // iframe, or navigate the app through a relative link.
    writeFileSync(
      `${wtI.absPath}/README.md`,
      "# Titolo della consegna\n\n![logo](assets/logo.png)\n\n[le regole](CONTRIBUTING.md) e [il sito](https://example.test/)\n\n<iframe srcdoc=\"<p>dentro</p>\"></iframe>\n",
    );
    git(wtI.absPath, ["mv", "docs/vecchio.txt", "docs/nuovo.txt"]);
    writeFileSync(`${wtI.absPath}/docs/nuovo.txt`, numberedLines([9]));
    git(wtI.absPath, ["add", "-A"]);
    git(wtI.absPath, ["commit", "-q", "-m", "la consegna con le immagini"]);
    writeFileSync(`${wtI.absPath}/assets/nuovo.png`, png(2, 2, [30, 200, 30]));
    ({ taskId: imagesTaskId, topicId: imagesTopicId } = await makeTask("Card con immagini", wtI.id));

    // 5. La card SENZA niente da cui ricostruire: una chat, nessun worktree.
    const orphanTopic = await createTopic(request, "E2E-ChangesPanel-Orfana", { projectPath: REPO });
    orphanTopicId = orphanTopic.id;
    const orphanRes = await request.post(`${API}/boards/${PROJECT_ID}/tasks`, { data: { text: "Card senza worktree", status: "todo" } });
    expect(orphanRes.ok()).toBe(true);
    orphanTaskId = ((await orphanRes.json()) as { id: string }).id;
    expect((await request.post(`${API}/test/tasks/${orphanTaskId}/bind-topic`, { data: { topicId: orphanTopic.id } })).ok()).toBe(true);

    // Il contratto del server PRIMA della UI: se cade qui, il rosso dice "setup".
    const diff = await request.get(`${API}/boards/${PROJECT_ID}/tasks/${taskId}/diff`);
    expect(diff.ok()).toBe(true);
    const bundle = (await diff.json()) as { code?: string; source?: string; stat: { path: string }[] };
    expect(bundle.code).toBeUndefined();
    expect(bundle.source).toBe("worktree");
    expect(bundle.stat.map((s) => s.path)).toEqual(["consegna.ts"]);
  });

  test.afterAll(async ({ request }) => {
    for (const id of [taskId, landedTaskId, imagesTaskId, orphanTaskId]) if (id) await deleteTask(request, PROJECT_ID, id);
    for (const id of [topicId, landedTopicId, imagesTopicId, orphanTopicId]) if (id) await deleteTopic(request, id);
    for (const p of [worktreePath, landedPath, imagesPath]) if (p && existsSync(p)) removeTmpDir(p);
    removeTmpDir(REPO);
    removeTmpDir(OUTSIDE);
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, REPO);
    await seedProjectPane(page.request, REPO);
  });

  test("CHANGES-01: elenca i file DELLA CARD, non quelli ereditati, col totale in testa", async ({ page }) => {

    test.info().annotations.push({ type: "spec", description: "KANBAN-43" });
    await page.goto("/");
    await openProjectBoard(page);
    const drawer = await openTask(page, "Card con worktree");

    const modifiche = drawer.getByRole("button", { name: /^Modifiche/ });
    await expect(modifiche).toBeVisible({ timeout: 15000 });
    // Un file, e il totale è quello di QUEL file: il commit ereditato non c'è.
    await expect(modifiche).toContainText("1 file");
    await expect(modifiche).toContainText("+2");
    await expect(modifiche).toContainText("−0");

    // Il chip apre una tendina PORTALATA: il diff non vive più nel flusso del
    // brief, quindi si cerca nel pannello e non dentro il drawer.
    await modifiche.click();
    const pannello = page.getByTestId("task-changes-panel");
    await expect(pannello.getByRole("button", { name: /^consegna\.ts/ })).toBeVisible({ timeout: 10000 });
    await expect(pannello.getByRole("button", { name: /roba-di-un-altro/ })).toHaveCount(0);
  });

  test("CHANGES-02: dopo il land il pannello RESTA, e dice da dove legge", async ({ page }) => {
    await page.goto("/");
    await openProjectBoard(page);
    let drawer = await openTask(page, "Card atterrata");
    await expect(drawer.getByRole("button", { name: /^Modifiche/ })).toBeVisible({ timeout: 15000 });

    // Il land: merge su main con il messaggio che il land scrive davvero, poi il
    // reap — worktree rimosso e ramo cancellato. Da qui in poi l'unica traccia
    // di cosa ha portato la card è quel merge.
    git(REPO, ["merge", "--no-ff", "-m", `merge task ${landedTaskId}: Card atterrata`, landedBranch!]);
    git(REPO, ["worktree", "remove", "--force", landedPath!]);
    git(REPO, ["branch", "-D", landedBranch!]);
    landedPath = null;

    // Il drawer legge il diff al montaggio: si chiude e si riapre, come farebbe
    // chiunque tornasse sulla card dopo l'atterraggio.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("task-detail-drawer")).toBeHidden({ timeout: 10000 });
    drawer = await openTask(page, "Card atterrata");

    const modifiche = drawer.getByRole("button", { name: /^Modifiche/ });
    await expect(modifiche).toBeVisible({ timeout: 15000 });
    await expect(modifiche).toContainText("1 file");
    await expect(modifiche).toContainText("dal merge su main");

    await modifiche.click();
    await expect(page.getByTestId("task-changes-panel").getByRole("button", { name: /^atterrata\.ts/ }))
      .toBeVisible({ timeout: 10000 });
  });

  test("CHANGES-03: senza niente da cui ricostruire lo DICE, invece di sparire", async ({ page }) => {
    await page.goto("/");
    await openProjectBoard(page);
    const drawer = await openTask(page, "Card senza worktree");

    await expect(drawer.getByText(/Diff non ricostruibile/)).toBeVisible({ timeout: 15000 });
    // Nessuna barra apribile: non c'è niente da aprire, e non si finge il contrario.
    await expect(drawer.getByRole("button", { name: /^Modifiche/ })).toHaveCount(0);
  });

  test("CHANGES-04: a changed picture is a Before/After pair, the README renders its image at the same revision, and a renamed file reads whole", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "DIFFPV-02" });
    test.info().annotations.push({ type: "spec", description: "DIFFPV-03" });
    test.info().annotations.push({ type: "spec", description: "DIFFPV-04" });
    const bundle = await (await page.request.get(`${API}/boards/${PROJECT_ID}/tasks/${imagesTaskId}/diff`)).json() as {
      source: string; revs: { base: string; head: string | null };
    };
    expect(bundle.source).toBe("worktree");
    expect(bundle.revs.head).toBeNull();
    expect(bundle.revs.base).toMatch(/^[0-9a-f]{40}$/);

    await page.goto("/");
    await openProjectBoard(page);
    const drawer = await openTask(page, "Card con immagini");
    await drawer.getByRole("button", { name: /^Modifiche/ }).click();
    const panel = page.getByTestId("task-changes-panel");

    // The modified picture: Before at the base SHA, After from the working tree,
    // both decoded (the pixel size is read off the loaded image).
    const logo = panel.locator('[data-testid="diff-file"][data-path="assets/logo.png"]');
    await logo.getByRole("button", { name: /^logo\.png/ }).click();
    const before = logo.getByTestId("diff-image-before");
    const after = logo.getByTestId("diff-image-after");
    await expect(before).toHaveAttribute("src", new RegExp(`file=assets%2Flogo\\.png&blob=${bundle.revs.base}`));
    await expect(after).toHaveAttribute("src", /file=assets%2Flogo\.png&blob=worktree/);
    await expect(before).toHaveJSProperty("naturalWidth", 1);
    await expect(after).toHaveJSProperty("naturalWidth", 3);
    await expect(logo.getByText("3 × 2 px")).toBeVisible();

    // The picture never committed: only an After.
    const fresh = panel.locator('[data-testid="diff-file"][data-path="assets/nuovo.png"]');
    await fresh.getByRole("button", { name: /^nuovo\.png/ }).click();
    await expect(fresh.getByTestId("diff-image-after")).toHaveAttribute("src", /blob=worktree/);
    await expect(fresh.getByTestId("diff-image-before")).toHaveCount(0);
    await expect(panel.getByText(/nessun diff testuale/)).toHaveCount(0);

    // The README opens on its lines; the preview renders the After, and its
    // image is read at the README's own revision, not from the disk.
    const readme = panel.locator('[data-testid="diff-file"][data-path="README.md"]');
    await readme.getByRole("button", { name: /^README\.md/ }).click();
    await expect(readme.getByTestId("diff-view-diff")).toHaveAttribute("aria-pressed", "true");
    await expect(readme.getByText("+# Titolo della consegna")).toBeVisible();
    await readme.getByTestId("diff-view-preview").click();
    const rendered = readme.getByTestId("diff-markdown-preview");
    await expect(rendered.getByRole("heading", { level: 1, name: "Titolo della consegna" })).toBeVisible({ timeout: 10000 });
    await expect(rendered.locator("img")).toHaveAttribute("src", /file=assets%2Flogo\.png&blob=worktree/);
    await expect(rendered.locator("img")).toHaveJSProperty("naturalWidth", 3);
    // A delivered file runs nothing and navigates nowhere: no iframe, a relative
    // link is text, a web link is still a link.
    await expect(rendered.locator("iframe")).toHaveCount(0);
    await expect(rendered.getByText("le regole", { exact: true })).toBeVisible();
    await expect(rendered.getByRole("link", { name: "le regole" })).toHaveCount(0);
    await expect(rendered.getByRole("link", { name: "il sito" })).toHaveAttribute("href", "https://example.test/");

    // The renamed text file opens on its hunk: line 1 is not in it.
    const moved = panel.locator('[data-testid="diff-file"][data-path="docs/nuovo.txt"]');
    await moved.getByRole("button", { name: /^nuovo\.txt/ }).click();
    await expect(moved.locator('[data-anchor="new:9"]')).toContainText("+riga 9 cambiata");
    await expect(moved.locator('[data-anchor="new:1"]')).toHaveCount(0);
    await moved.getByRole("button", { name: "Commenta docs/nuovo.txt:9", exact: true }).click();
    await panel.getByPlaceholder("Cosa non va in questa riga…").fill("Nota sulla riga 9");
    await panel.getByRole("button", { name: "Aggiungi" }).click();
    const noteUnder9 = moved.locator('[data-anchor="new:9"] + [data-testid="diff-note"]');
    await expect(noteUnder9).toContainText("Nota sulla riga 9");

    // "Full file" follows the rename: the rows outside the block are there and
    // uncoloured, the old side of line 9 too, and the note is still under its row.
    await moved.getByTestId("diff-view-full").click();
    await expect(moved.locator('[data-anchor="new:1"]')).toContainText("riga 1", { timeout: 10000 });
    await expect(moved.locator('[data-anchor="new:1"]')).not.toHaveClass(/emerald|red-/);
    await expect(moved.locator('[data-anchor="old:9"]')).toContainText("-riga 9");
    await expect(noteUnder9).toContainText("Nota sulla riga 9");

    // And back on the diff, the same note on the same row.
    await moved.getByTestId("diff-view-diff").click();
    await expect(moved.locator('[data-anchor="new:1"]')).toHaveCount(0);
    await expect(noteUnder9).toContainText("Nota sulla riga 9");
    // Not left to the next test: a pending note opens the panel on its own.
    await panel.getByRole("button", { name: "Scarta" }).click();
    await expect(panel.getByTestId("diff-note")).toHaveCount(0);

    // The agent keeps writing: once the drawer re-reads the bundle, "Full file"
    // shows the new line too, not the file as it was first read.
    await moved.getByTestId("diff-view-full").click();
    await expect(moved.locator('[data-anchor="new:2"]')).not.toHaveClass(/emerald/);
    writeFileSync(`${imagesPath}/docs/nuovo.txt`, numberedLines([2, 9]));
    let bump = 0;
    await expect.poll(async () => {
      // A harmless PATCH moves the card's `updatedAt`, and the drawer re-reads its diff on it.
      await page.request.patch(`${API}/boards/${PROJECT_ID}/tasks/${imagesTaskId}`, { data: { priority: (bump++ % 2) + 1 } });
      return moved.locator('[data-anchor="new:2"]').textContent();
    }, { timeout: 20_000, intervals: [500, 1000, 2000] }).toContain("+riga 2 cambiata");
  });

  test("CHANGES-06: the byte route reads only what the bundle names", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "DIFFPV-05" });
    const route = `${API}/boards/${PROJECT_ID}/tasks/${imagesTaskId}/diff`;
    const { revs } = await (await request.get(route)).json() as { revs: { base: string; head: string | null } };
    const blob = (file: string, rev: string) => request.get(`${route}?file=${encodeURIComponent(file)}&blob=${encodeURIComponent(rev)}`);

    // A symlink out of the worktree: 404, and none of its bytes.
    mkdirSync(OUTSIDE, { recursive: true });
    writeFileSync(`${OUTSIDE}/secret.png`, "OUTSIDE-THE-WORKTREE");
    symlinkSync(`${OUTSIDE}/secret.png`, `${imagesPath}/leak.png`);
    try {
      const leak = await blob("leak.png", "worktree");
      expect(leak.status()).toBe(404);
      expect(await leak.text()).not.toContain("OUTSIDE-THE-WORKTREE");
    } finally {
      unlinkSync(`${imagesPath}/leak.png`);
    }

    expect((await blob("../x.png", revs.base)).status()).toBe(400);
    const stale = await blob("assets/logo.png", "0".repeat(40));
    expect(stale.status()).toBe(409);
    expect((await stale.json()).code).toBe("stale_rev");
    expect((await blob(".env", revs.base)).status()).toBe(415);

    // The Before, byte for byte what git holds at that SHA.
    const png = await blob("assets/logo.png", revs.base);
    expect(png.status()).toBe(200);
    expect(png.headers()["content-type"]).toBe("image/png");
    const want = execFileSync("git", ["cat-file", "blob", `${revs.base}:assets/logo.png`], { cwd: imagesPath! });
    expect(Buffer.compare(await png.body(), want)).toBe(0);
  });

  test("CHANGES-05: after the land the pair reads from the merge's two SHAs, even in a panel opened before it", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "DIFFPV-01" });
    test.info().annotations.push({ type: "spec", description: "DIFFPV-02" });
    test.info().annotations.push({ type: "spec", description: "DIFFPV-05" });
    // The panel is opened on the live worktree: the new picture's After is the working tree.
    await page.goto("/");
    await openProjectBoard(page);
    const drawer = await openTask(page, "Card con immagini");
    const modifiche = drawer.getByRole("button", { name: /^Modifiche/ });
    await modifiche.click();
    const panel = page.getByTestId("task-changes-panel");
    const fresh = panel.locator('[data-testid="diff-file"][data-path="assets/nuovo.png"]');
    await fresh.getByRole("button", { name: /^nuovo\.png/ }).click();
    await expect(fresh.getByTestId("diff-image-after")).toHaveAttribute("src", /blob=worktree/);

    // The land, with the drawer still open: everything committed, merged on
    // main under the card's name, worktree reaped.
    git(imagesPath!, ["add", "-A"]);
    git(imagesPath!, ["commit", "-q", "-m", "il resto della consegna"]);
    git(REPO, ["merge", "--no-ff", "-m", `merge task ${imagesTaskId}: Card con immagini`, imagesBranch!]);
    git(REPO, ["worktree", "remove", "--force", imagesPath!]);
    git(REPO, ["branch", "-D", imagesBranch!]);
    imagesPath = null;
    const merge = git(REPO, ["rev-parse", "HEAD"]).trim();
    const parent = git(REPO, ["rev-parse", "HEAD^1"]).trim();

    // A picture this page never asked for: the panel still holds the live
    // bundle, so its After asks for `worktree`. The route answers 409 and the
    // panel re-reads the bundle instead of leaving "preview unavailable".
    const stale = page.waitForResponse((r) => r.url().includes("file=assets%2Flogo.png&blob=worktree") && r.status() === 409);
    const logo = panel.locator('[data-testid="diff-file"][data-path="assets/logo.png"]');
    await logo.getByRole("button", { name: /^logo\.png/ }).click();
    await stale;
    await expect(logo.getByTestId("diff-image-before")).toHaveAttribute("src", new RegExp(`blob=${parent}$`), { timeout: 15000 });
    await expect(logo.getByTestId("diff-image-after")).toHaveAttribute("src", new RegExp(`blob=${merge}$`));
    await expect(logo.getByTestId("diff-image-after")).toHaveJSProperty("naturalWidth", 3);
    await expect(modifiche).toContainText("dal merge su main");
  });
});
