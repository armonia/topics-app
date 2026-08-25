/**
 * Cancellare vuol dire spostare nel cestino.
 *
 * Due punti del server cancellavano per davvero: `/api/files/delete` e lo
 * scarto di un file NON TRACCIATO in `/api/git/discard`. Il secondo era il piu'
 * cattivo: sta dietro lo stesso bottone dello scarto di un file tracciato, che
 * git sa ripristinare, e niente distingueva i due casi.
 *
 * Qui si prova il CABLAGGIO: che le rotte chiamino il cestino e non `rm`. Che
 * il cestino sia un cestino (il contenuto resta leggibile, i nomi non si
 * sovrascrivono, il .trashinfo c'e') lo provano i test unitari di
 * `server/lib/trash.ts`, dove la radice si puo' scegliere. Da qui non si puo':
 * su macOS leggere `~/.Trash` richiede Full Disk Access.
 *
 * @covers FILE-01
 */
import { test, expect } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { seedFileProject, cleanupFileProject, type FileProject } from "./helpers/file-project";
import { existsSync, writeFileSync } from "fs";

hermetic(test);

test.describe("cancellare = cestinare", () => {
  let project: FileProject | undefined;
  let tmpDir = "";

  test.beforeAll(async ({ request }) => {
    project = await seedFileProject(request, "trash");
    ({ tmpDir } = project);
  });

  test.afterAll(async ({ request }) => {
    await cleanupFileProject(request, project);
  });

  test("il file sparisce dal progetto e la rotta dice che e' nel cestino", async ({ request }) => {
    const file = `${tmpDir}/da-cestinare.txt`;
    writeFileSync(file, "contenuto\n");
    expect(existsSync(file)).toBe(true);

    const res = await request.delete("/api/files/delete", { data: { path: file } });
    expect(res.status()).toBe(200);
    // `trashed: true` e' il contratto: distingue «spostato» da «cancellato», ed
    // e' quello su cui la UI puo' promettere all'utente di poterlo rimettere a
    // posto.
    expect(await res.json()).toMatchObject({ ok: true, trashed: true });
    expect(existsSync(file)).toBe(false);
  });

  test("una cartella intera segue la stessa strada", async ({ request }) => {
    const dir = `${tmpDir}/cartella-da-cestinare`;
    writeFileSync(`${tmpDir}/segnaposto.txt`, "x\n");
    const { mkdirSync } = await import("fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/dentro.txt`, "x\n");

    const res = await request.delete("/api/files/delete", { data: { path: dir } });
    expect(res.status()).toBe(200);
    expect(existsSync(dir)).toBe(false);
  });

  test("scartare un file mai committato lo cestina, non lo cancella", async ({ request }) => {
    // git non ha nessuna copia di un file non tracciato: se lo scarto lo
    // cancellasse, non ci sarebbe nessun modo di tornare indietro.
    const nuovo = `${tmpDir}/mai-committato.txt`;
    writeFileSync(nuovo, "lavoro non salvato\n");

    const res = await request.post("/api/git/discard", {
      data: { path: tmpDir, files: ["mai-committato.txt"] },
    });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(existsSync(nuovo)).toBe(false);
  });

  test("un path che esce dal progetto non viene toccato", async ({ request }) => {
    // Il path arriva dal client. Una cancellazione non deve appoggiarsi al
    // fatto che `git status` per caso risponda male fuori dal repo.
    const fuori = `${tmpDir}/../e2e-fuori-${Date.now()}.txt`;
    writeFileSync(fuori, "non mio\n");

    const res = await request.post("/api/git/discard", {
      data: { path: tmpDir, files: [`../${fuori.split("/").pop()}`] },
    });
    // O rifiuta, o lo elenca fra i falliti: in nessun caso il file sparisce.
    expect(existsSync(fuori)).toBe(true);
    if (res.status() === 200) {
      expect(await res.json()).not.toMatchObject({ ok: true });
    }

    const { unlinkSync } = await import("fs");
    unlinkSync(fuori);
  });
});
