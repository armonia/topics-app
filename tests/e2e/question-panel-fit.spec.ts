import { mkdirSync } from "fs";
import { join } from "path";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { splitViaContextMenu } from "./helpers/layout";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * "Il pannello delle domande a scelte resta DENTRO la pane."
 *
 * Quando l'agente chiama `ask_user_question` la chat mostra un pannello con le
 * opzioni e il campo «Altro». Con domande lunghe, descrizioni lunghe, un
 * percorso o un URL senza spazi e una pane stretta (split a due o tre) il
 * pannello usciva dal bordo della pane e veniva tagliato: opzioni e pulsante
 * Invia non si raggiungevano.
 *
 * La prova MISURA, non guarda: il rettangolo del pannello e quello di ogni
 * suo figlio devono stare dentro il rettangolo della pane, a ogni larghezza e
 * con la pane divisa. Con `QPF_SHOT_DIR` e `QPF_TAG` salva anche le immagini
 * (prima/dopo) per il confronto affiancato.
 *
 * @covers ASK-10
 */
const BASE = E2E_BASE;
const SHOT_DIR = process.env.QPF_SHOT_DIR;
const SHOT_TAG = process.env.QPF_TAG ?? "dopo";

const LONG_TOKEN = "/home/dev/work/topics-app/client/src/components/Chat/ToolInputForm.tsx";
// Una sola parola senza punti di rottura: un hash, un URL con la query, un id.
const UNBROKEN = "https%3A%2F%2Fexample.com%2Fapi%2Fv2%2Fsessions%3Ffilter%3Dstatus%3Aactive%26sort%3Dcreated_at%3Adesc%26cursor%3DaGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgY3Vyc29y";
const LONG_DESC =
  "Questa opzione cambia il comportamento del pannello in modo che le descrizioni molto lunghe vadano a capo "
  + "invece di allargare la riga oltre il bordo della pane, e include anche un percorso lungo: "
  + LONG_TOKEN + " " + UNBROKEN;

function bigQuestions() {
  return [1, 2, 3, 4].map((n) => ({
    header: `Scelta ${n} con un titolo piuttosto lungo`,
    question:
      `Domanda ${n}: quale strategia vuoi adottare per la migrazione dei dati della sessione, tenendo conto `
      + `dei vincoli di compatibilità con le versioni precedenti e dei tempi di rilascio? ${LONG_TOKEN} ${UNBROKEN}`,
    multiSelect: n % 2 === 0,
    options: [1, 2, 3, 4].map((o) => ({
      label: `Opzione ${n}.${o} con un'etichetta abbastanza lunga da occupare più righe ${o === 2 ? UNBROKEN : ""}`,
      description: LONG_DESC,
    })),
  }));
}

interface Overflow { what: string; left: number; right: number; paneLeft: number; paneRight: number }

/** Ogni elemento del pannello che sborda orizzontalmente dalla pane che lo contiene. */
async function overflowsOf(form: Locator): Promise<Overflow[]> {
  return form.evaluate((el) => {
    const pane = el.closest<HTMLElement>("[data-chat-topic-id]");
    if (!pane) throw new Error("il pannello non sta dentro una pane di chat");
    const p = pane.getBoundingClientRect();
    const out: Overflow[] = [];
    const all = [el, ...Array.from(el.querySelectorAll<HTMLElement>("*"))];
    for (const node of all) {
      const r = node.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < p.left - 0.5 || r.right > p.right + 0.5) {
        out.push({
          what: `${node.tagName.toLowerCase()}${node.className && typeof node.className === "string" ? "." + node.className.split(" ")[0] : ""}`,
          left: Math.round(r.left), right: Math.round(r.right),
          paneLeft: Math.round(p.left), paneRight: Math.round(p.right),
        });
      }
    }
    return out.slice(0, 8);
  });
}

interface Room { formHeight: number; room: number; actionsInside: boolean }

/**
 * Lo spazio verticale che la pane lascia al pannello: dal bordo alto della pane
 * all'alto del composer. Il pannello più alto di così deve scorrere DENTRO di sé;
 * i suoi pulsanti restano comunque nello spazio visibile.
 */
async function verticalRoom(form: Locator): Promise<Room> {
  return form.evaluate((el) => {
    const pane = el.closest<HTMLElement>("[data-chat-topic-id]")!;
    const composer = pane.querySelector<HTMLElement>('[data-testid="chat-input-area"]')!;
    const top = pane.getBoundingClientRect().top;
    const bottom = composer.getBoundingClientRect().top;
    const f = el.getBoundingClientRect();
    const actions = Array.from(el.querySelectorAll<HTMLElement>("button")).filter((b) => /Avanti|Invia|Indietro/.test(b.textContent ?? ""));
    const inside = actions.length > 0 && actions.every((b) => {
      const r = b.getBoundingClientRect();
      return r.top >= top - 0.5 && r.bottom <= bottom + 0.5;
    });
    return { formHeight: Math.round(f.height), room: Math.round(bottom - top), actionsInside: inside };
  });
}

async function shot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, `${SHOT_TAG}-${name}.png`) });
}

const CASES = [
  { w: 375, h: 667, splits: 0 },
  { w: 768, h: 700, splits: 0 },
  { w: 768, h: 700, splits: 1 },
  { w: 1440, h: 800, splits: 0 },
  { w: 1440, h: 800, splits: 1 },
] as const;

test.describe("Pannello delle domande dentro la pane", () => {
  test.setTimeout(120_000);
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = `qpf-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const { topics } = (await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> };
    sessionKey = Object.values(topics).find((t) => t.id === topicId)?.sessionKey ?? "";
    expect(sessionKey, "il topic deve avere una sessionKey").toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  for (const c of CASES) {
    test(`${c.w}px con ${c.splits + 1} pane: il pannello non esce dai bordi`, async ({ page, chatPage, request }) => {
      test.info().annotations.push({ type: "spec", description: "ASK-10" });
      {
        await resetPaneStore(request, [topicId]);

        const toolCallId = `toolu_fit_${c.w}_${c.splits}`;
        const questions = bigQuestions();
        await seedMessage(request, { sessionKey, role: "user", content: "aiutami a decidere" });
        await seedMessage(request, {
          sessionKey,
          role: "assistant",
          content: "Ho bisogno di quattro scelte:",
          toolCalls: [
            {
              id: toolCallId,
              name: "mcp__topics__ask_user_question",
              args: { questions },
              status: "waiting_for_input",
              startedAt: Date.now() - 4_000,
              userInputSchema: { kind: "questions", questions },
            },
          ],
        });

        await page.setViewportSize({ width: c.w, height: c.h });
        await goToApp(page);
        await page.keyboard.press("Escape");
        await openTopic(page, new RegExp(topicName));
        await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
        for (let i = 0; i < c.splits; i++) {
          await splitViaContextMenu(page, "Dividi a destra", i);
        }

        const forms = page.locator(`[data-testid="tool-input-form-${toolCallId}"]`);
        await expect(forms.first()).toBeVisible({ timeout: 15_000 });

        // Composer APERTO: ci scriviamo dentro prima di misurare.
        const composer = forms.first().locator("xpath=ancestor::*[@data-chat-topic-id][1]").getByTestId("chat-message-input");
        await composer.click();
        await composer.fill("una bozza che tiene il composer aperto e alto\ncon due righe");

        await forms.first().scrollIntoViewIfNeeded();
        await shot(page, `${c.w}-${c.splits + 1}pane`);

        const count = await forms.count();
        for (let i = 0; i < count; i++) {
          const form = forms.nth(i);
          await form.scrollIntoViewIfNeeded();
          const bad = await overflowsOf(form);
          expect(bad, `larghezza ${c.w}, pane ${i + 1}/${count}: elementi fuori dalla pane`).toEqual([]);
          // Verticale: il pannello sta nello spazio tra il bordo alto della pane
          // e il composer (se il contenuto è di più, scorre dentro di sé) e i
          // suoi pulsanti sono raggiungibili senza scorrere la chat.
          await form.scrollIntoViewIfNeeded();
          const v = await verticalRoom(form);
          expect(v.formHeight, `larghezza ${c.w}, pane ${i + 1}/${count}: pannello alto ${v.formHeight}px in ${v.room}px di pane`).toBeLessThanOrEqual(v.room);
          expect(v.actionsInside, `larghezza ${c.w}, pane ${i + 1}/${count}: pulsanti fuori dalla pane`).toBe(true);
        }
      }
    });
  }
});
