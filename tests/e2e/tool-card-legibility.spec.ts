import { expect, test } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { hermetic } from "./fixtures/hermetic";
import { E2E_HOME } from "./helpers/test-server";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

hermetic(test);

/**
 * Che cosa si LEGGE dentro la card di un tool.
 *
 * Tre difetti di resa, tutti sullo stesso schermo:
 *
 *  1. la `Skill` riscriveva nel corpo il nome già stampato nell'intestazione, e
 *     sotto ci metteva «Launching skill: X» — l'unica cosa che la CLI
 *     restituisce, e che non dice niente di nuovo. Il contenuto vero (le
 *     istruzioni caricate) finiva invece nella PROSA della risposta;
 *  2. i risultati arrivati come array di blocchi venivano serializzati: nella
 *     card si leggeva `[{"type":"text","text":"…"}]` invece del testo. Sul DB di
 *     questa macchina: 4.735 risultati su 32.492;
 *  3. i messaggi già salvati con la forma (2) devono tornare leggibili senza
 *     riscrivere il DB.
 */
test.describe.serial("Leggibilità delle card dei tool", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  const SKILL_BODY =
    "Fai un riassunto in massimo 2 righe di tutte le modifiche fatte in questa sessione di chat.\nSii conciso: elenca i cambiamenti separati da punto e virgola.";
  const MCP_TEXT = "Task #12 — in review\nassegnato a: nessuno";
  /** La forma in cui i risultati MCP sono finiti nel DB fino a oggi. */
  const MCP_RAW = JSON.stringify([{ type: "text", text: MCP_TEXT }]);

  test.beforeAll(async ({ request }) => {
    topicName = "Tool Cards " + Date.now();
    const t = await createTopic(request, topicName);
    topicId = t.id;
    sessionKey = `topic:${t.id.slice(0, 8)}`;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("la Skill mostra le ISTRUZIONI, non il proprio nome due volte", async ({ page, request }) => {
    const u = await seedMessage(request, {
      sessionKey,
      role: "user",
      content: "/recap",
      timestamp: new Date(Date.now() - 5000).toISOString(),
    });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      parentId: u.id,
      content: "Corretto il ritaglio delle finestre; ridotta la latenza a 22 ms.",
      timestamp: new Date(Date.now() - 4000).toISOString(),
      toolCalls: [
        // Come arriva ADESSO: il corpo della skill è il risultato del tool.
        {
          id: "tc-skill-new",
          name: "Skill",
          args: { skill: "recap" },
          status: "success",
          result: SKILL_BODY,
          startedAt: Date.now() - 4200,
          endedAt: Date.now() - 4100,
        },
        // Un messaggio VECCHIO: la CLI aveva restituito solo il segnaposto.
        {
          id: "tc-skill-old",
          name: "Skill",
          args: { skill: "caveman" },
          status: "success",
          result: "Launching skill: caveman",
          startedAt: Date.now() - 4400,
          endedAt: Date.now() - 4300,
        },
      ],
      latencyMs: 3900,
      usagePromptTokens: 432,
      usageCompletionTokens: 354,
      costCents: 2,
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const fresh = page.locator('[data-testid="tool-call-row-tc-skill-new"]');
    await expect(fresh).toBeVisible({ timeout: 15_000 });

    // L'intestazione nomina la skill come la si invoca.
    await expect(fresh.locator('[data-testid="tool-call-name"]')).toHaveText("Skill");
    await expect(fresh).toContainText("/recap");

    // La prosa della risposta NON contiene il corpo della skill: era il difetto
    // di partenza, il prompt del comando incollato prima della risposta.
    const assistant = page.locator('[data-testid="message-content-assistant"]').last();
    await expect(assistant).not.toContainText("Fai un riassunto in massimo 2 righe");

    // Aperta, la card porta le istruzioni caricate — una volta sola.
    await fresh.locator("button").first().click();
    const body = fresh.locator('[data-testid="tool-call-result"]');
    await expect(body).toBeVisible();
    await expect(body).toContainText("Fai un riassunto in massimo 2 righe");
    await expect(fresh).toContainText("Istruzioni caricate");
    // `/recap` compare UNA volta sola in tutta la riga: nell'intestazione.
    const occurrences = ((await fresh.innerText()).match(/\/recap/g) ?? []).length;
    expect(occurrences).toBe(1);

    // Il messaggio vecchio non ha istruzioni da mostrare, quindi la riga non
    // offre nemmeno il gesto: prima il chevron c'era e apriva il vuoto — è
    // esattamente così che si è letto «la skill non apre nulla».
    const old = page.locator('[data-testid="tool-call-row-tc-skill-old"]');
    await expect(old).toBeVisible();
    await expect(old).not.toContainText("Launching skill");
    // Non c'è proprio un bottone: la riga non promette un gesto che non ha —
    // ma DICE perché, o si legge come una riga rotta invece che vuota.
    await expect(old.locator("button")).toHaveCount(0);
    const inerte = old.locator('[data-empty="true"]');
    await expect(inerte).toHaveCount(1);
    await expect(inerte).toHaveAttribute("title", /Nessuna istruzione registrata/);
    await old.click();
    await expect(old.locator('[data-testid="tool-call-result"]')).toHaveCount(0);

    // …e il nome parte comunque dalla stessa colonna della riga che si apre:
    // togliere il chevron non deve disallineare la pila.
    const xOf = async (sel: string) =>
      (await page.locator(`${sel} [data-testid="tool-call-name"]`).boundingBox())!.x;
    const dx = Math.abs(
      (await xOf('[data-testid="tool-call-row-tc-skill-old"]')) -
        (await xOf('[data-testid="tool-call-row-tc-skill-new"]')),
    );
    expect(dx).toBeLessThan(1);

    // Nessuna spunta verde su un'azione riuscita: l'esito si dice solo quando è
    // cattivo. Lo stato resta leggibile come attributo della riga.
    await expect(fresh).toHaveAttribute("data-status", "success");
    await expect(fresh.locator(".text-green-500")).toHaveCount(0);

    // Qui il MODELLO ha chiamato il tool: non c'è nessuna riga sintetica in più
    // — quella riga non esiste più affatto, il comando digitato si legge una
    // volta sola, sul messaggio dell'utente (vedi `SlashCommandChip`).
    await expect(page.locator('[data-testid="invoked-command-row"]')).toHaveCount(0);

    await fresh.screenshot({ path: "test-results/skill-card-instructions.png" });
  });

  test("una corsa VIVA: il chevron dice la verità, il cronometro gira, i figli sono rientrati", async ({ page, request }) => {
    // Da quando i messaggi consecutivi di sola azione si fondono, la riga di
    // gruppo si vede DAVVERO tutti i giorni — e con lei tre difetti che prima
    // erano teorici: il chevron puntato a destra su un corpo aperto, nessun
    // numero mentre la corsa va avanti (una riga singola in corso il suo
    // cronometro ce l'ha sempre avuto), e i figli sulla stessa colonna del
    // genitore, senza gerarchia.
    const fresh = await createTopic(request, "Corsa Viva " + Date.now());
    const sk = `topic:${fresh.id.slice(0, 8)}`;
    const base = Date.now() - 30_000;
    try {
      const u = await seedMessage(request, {
        sessionKey: sk,
        role: "user",
        content: "fai quattro cose",
        timestamp: new Date(Date.now() - 3000).toISOString(),
      });
      await seedMessage(request, {
        sessionKey: sk,
        role: "assistant",
        parentId: u.id,
        content: "",
        timestamp: new Date(Date.now() - 2000).toISOString(),
        toolCalls: [
          { id: "lv-1", name: "Read", args: { file_path: "/a.ts" }, status: "success", result: "a", startedAt: base, endedAt: base + 1000 },
          { id: "lv-2", name: "Read", args: { file_path: "/b.ts" }, status: "success", result: "b", startedAt: base + 1500, endedAt: base + 2500 },
          { id: "lv-3", name: "Read", args: { file_path: "/c.ts" }, status: "success", result: "c", startedAt: base + 3000, endedAt: base + 4000 },
          { id: "lv-4", name: "Bash", args: { command: "bun test" }, status: "running", startedAt: base + 5000 },
        ],
      });

      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(fresh.name));

      const group = page.locator('[data-testid="tool-group-row"]').last();
      await expect(group).toBeVisible({ timeout: 15_000 });
      await expect(group).toContainText("3/4 azioni");

      // Il corpo è aperto (l'azione in corso si vede) e il chevron lo dice.
      const running = page.locator('[data-testid="tool-call-row-lv-4"]');
      await expect(running).toBeVisible();
      await expect(group.locator('[data-testid="tool-group-chevron"]')).toHaveAttribute("data-open", "true");

      // Il cronometro della corsa gira: parte da `startedAt` del primo, quindi
      // ~30s fa. Sta nella RIGA di riepilogo, non nell'azione in corso.
      const groupClock = group.locator('[data-testid="tool-group-summary"] [data-testid="tool-elapsed"]');
      await expect(groupClock).toBeVisible();
      await expect(groupClock).toContainText(/\d/);

      // Gerarchia: le azioni del gruppo cominciano più a destra della riga che
      // le contiene.
      const groupLeft = (await group.locator('[data-testid="tool-group-summary"]').boundingBox())!.x;
      const childLeft = (await running.boundingBox())!.x;
      expect(childLeft).toBeGreaterThan(groupLeft + 8);

      // La corsa di sola azione NON si porta dietro la riga dei metadati: la
      // durata di ogni passo è già in fondo alla sua riga, e riservare 14px per
      // messaggio per ripeterla in hover era spazio speso per niente.
      const rigaLavoro = page.locator('[data-testid="chat-message"][data-role="assistant"]').last();
      await expect(rigaLavoro.locator('[data-testid="message-meta-row"]')).toHaveCount(0);

      await group.screenshot({ path: "test-results/tool-group-live.png" });
    } finally {
      await deleteTopic(request, fresh.id);
    }
  });

  test("la card usa la superficie dell'app, non il fondo dei blocchi di codice", async ({ page, request }) => {
    // Il `pre` globale di index.css è UNLAYERED, e in Tailwind v4 batte
    // qualunque utility. Le card scrivevano `bg-app-hover/40 px-2 py-1.5
    // text-[11px]` e non ne applicavano NESSUNA: veniva dipinto `--code-bg`
    // (#1f2937, un ardesia bluastro anche in tema chiaro) con 12px di padding e
    // 13px di testo. Misurato prima e dopo — per questo il test misura, invece
    // di guardare le classi.
    const fresh = await createTopic(request, "Tinta card " + Date.now());
    const sk = `topic:${fresh.id.slice(0, 8)}`;
    try {
      const u = await seedMessage(request, {
        sessionKey: sk, role: "user", content: "leggi",
        timestamp: new Date(Date.now() - 3000).toISOString(),
      });
      await seedMessage(request, {
        sessionKey: sk, role: "assistant", parentId: u.id, content: "Fatto.",
        timestamp: new Date(Date.now() - 2000).toISOString(),
        toolCalls: [{ id: "tint-1", name: "Read", args: { file_path: "/a.ts" }, status: "success", result: "const x = 1;" }],
      });

      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(fresh.name));

      const row = page.locator('[data-testid="tool-call-row-tint-1"]');
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.locator("button").first().click();

      const misura = await row.locator('[data-testid="tool-call-result"]').evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          bg: cs.backgroundColor,
          codeBg: getComputedStyle(document.documentElement).getPropertyValue('--code-bg').trim(),
          padTop: cs.paddingTop,
          fontSize: cs.fontSize,
        };
      });

      // La tinta è NEUTRA: in oklab le componenti a/b sono la deriva di colore,
      // e su un grigio di sistema devono essere ~0. Il vecchio #1f2937 aveva
      // hue 215 e il 28% di saturazione.
      const ab = (misura.bg.match(/-?[\d.]+/g) ?? []).slice(1, 3).map(Number);
      expect(Math.abs(ab[0] ?? 1)).toBeLessThan(0.01);
      expect(Math.abs(ab[1] ?? 1)).toBeLessThan(0.01);
      expect(misura.bg).not.toContain('31, 41, 55');
      expect(misura.bg).not.toBe(misura.codeBg);
      // …e le misure che le classi dichiarano vengono davvero applicate.
      expect(misura.padTop).toBe('6px');
      expect(misura.fontSize).toBe('11px');
    } finally {
      await deleteTopic(request, fresh.id);
    }
  });

  test("un risultato salvato come array di blocchi torna leggibile", async ({ page, request }) => {
    const u = await seedMessage(request, {
      sessionKey,
      role: "user",
      content: "che stato ha il task 12?",
      timestamp: new Date(Date.now() - 3000).toISOString(),
    });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      parentId: u.id,
      content: "È in review.",
      timestamp: new Date(Date.now() - 2000).toISOString(),
      toolCalls: [
        {
          id: "tc-mcp-json",
          name: "mcp__topics__get_task",
          args: { taskId: "12" },
          status: "success",
          result: MCP_RAW,
          startedAt: Date.now() - 2200,
          endedAt: Date.now() - 2100,
        },
      ],
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    const row = page.locator('[data-testid="tool-call-row-tc-mcp-json"]');
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.locator("button").first().click();

    const body = row.locator('[data-testid="tool-call-result"]');
    await expect(body).toBeVisible();
    await expect(body).toContainText("Task #12 — in review");
    // Nessuna traccia dell'involucro JSON.
    await expect(body).not.toContainText('"type"');
    await expect(body).not.toContainText("[{");

    await row.screenshot({ path: "test-results/mcp-card-unwrapped.png" });
  });

  test("un messaggio che È un comando si legge come un comando", async ({ page, request }) => {
    // `/recap` parte verbatim e la CLI lo espande PRIMA del turno: sul filo non
    // torna nessun tool e nessun testo iniettato (verificato). Finché il corpo
    // del comando colava nella risposta, il segnale «sto usando una skill»
    // c'era per sbaglio; tolto quello, la chat non diceva più niente. L'unico
    // che sa cosa hai lanciato è il tuo messaggio.
    const fresh = await createTopic(request, "Comando " + Date.now());
    const sk = `topic:${fresh.id.slice(0, 8)}`;
    const cmdDir = join(E2E_HOME, ".claude", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "recap.md"), "Fai un riassunto in massimo 2 righe di questa chat.");
    try {
      const u = await seedMessage(request, {
        sessionKey: sk, role: "user", content: "/recap",
        timestamp: new Date(Date.now() - 3000).toISOString(),
      });
      await seedMessage(request, {
        sessionKey: sk, role: "assistant", parentId: u.id,
        content: "Corretto il ritaglio delle finestre; ridotta la latenza.",
        timestamp: new Date(Date.now() - 2000).toISOString(),
      });

      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(fresh.name));

      // `.last()`: il primo test di questo file semina anche lui un `/recap`, e
      // la sua pane resta montata — due chip a schermo, una per topic.
      const cmd = page.locator('[data-testid="user-slash-command"]').last();
      await expect(cmd).toBeVisible({ timeout: 15_000 });
      await expect(cmd).toHaveAttribute("data-command", "recap");
      await expect(cmd).toContainText("/recap");

      // UNA VOLTA SOLA — e «una volta» si conta DENTRO IL TURNO, non a schermo:
      // le pane dei test precedenti restano montate, e i loro `/recap` sono
      // chip legittimi (stessa ragione del `.last()` qui sopra).
      //
      // Il turno apriva anche con una riga «questo turno gira /recap»: stesso
      // nome, stessa icona, a un centimetro dal chip, e nessuna delle due
      // diceva qualcosa che l'altra non dicesse — chi guardava vedeva il
      // proprio comando due volte e non capiva se fosse partito due volte. Ne
      // resta quello nel posto giusto: il messaggio che l'utente ha scritto.
      // Il turno si risale DAL CHIP (`ancestor`), non con `filter({ has })`: il
      // filtro chiede «i messaggi che contengono un chip» e li trova TUTTI —
      // anche quello della pane rimasta montata dal test precedente — quindi
      // contava due chip su due messaggi diversi e accusava un duplicato che
      // non c'era.
      const turno = cmd.locator('xpath=ancestor::*[@data-testid="chat-message"][1]');
      await expect(page.locator('[data-testid="invoked-command-row"]')).toHaveCount(0);
      await expect(turno.locator('[data-testid="user-slash-command"]')).toHaveCount(1);

      // …e il corpo del comando — la sola cosa in più che la riga sparita
      // portava — si apre da QUI: non passa dal filo, lo legge dal file il
      // server. Il server di test ha un HOME isolato, quindi il comando va
      // seminato lì: è esattamente il file che il server andrà a leggere.
      await cmd.getByTestId("user-slash-command-toggle").click();
      const corpo = cmd.locator('[data-testid="invoked-command-body"]');
      await expect(corpo).toBeVisible({ timeout: 10_000 });
      await expect(corpo).toContainText("riassunto");
      // Nessuna etichetta sopra il corpo: l'intestazione dice già `/recap`.
      await expect(cmd).not.toContainText("CONTENUTO DEL COMANDO");
      await expect(cmd).not.toContainText("Contenuto del comando");
      await expect(cmd).not.toContainText("Istruzioni della skill");
      await expect(cmd).not.toContainText("Skill (");
      await expect(cmd).not.toContainText("Comando (");

      await cmd.screenshot({ path: "test-results/user-slash-command.png" });
    } finally {
      await deleteTopic(request, fresh.id);
    }
  });

  test("un percorso all\'inizio del messaggio NON diventa un comando", async ({ page, request }) => {
    const fresh = await createTopic(request, "Percorso " + Date.now());
    const sk = `topic:${fresh.id.slice(0, 8)}`;
    try {
      await seedMessage(request, {
        sessionKey: sk, role: "user", content: "/Users/utente/Projects/topics-app",
        timestamp: new Date(Date.now() - 3000).toISOString(),
      });

      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(fresh.name));

      // Scoped all'ULTIMO messaggio: le pane dei test precedenti restano
      // montate, e i loro `/recap` sono chip legittimi.
      const ultimo = page.locator('[data-testid="chat-message"][data-role="user"]').last();
      await expect(ultimo).toContainText("Projects/topics-app");
      await expect(ultimo.locator('[data-testid="user-slash-command"]')).toHaveCount(0);
    } finally {
      await deleteTopic(request, fresh.id);
    }
  });
});