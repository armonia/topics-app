# Topics App — E2E Test Suite

Playwright E2E tests covering all major features (chat, sidebar, panels,
layout, tabs, terminals, browser, agents, infra). **262** `*.spec.ts` files,
1 083 tests — the count in this line said 68 until 2026-08-25, which is roughly
when it was last true.

> **Stato della suite, misurato il 25/08/2026.** Numeri che servono a chi la
> tocca, non decorazione:
>
> - **175 `waitForTimeout` in 82 file = 149,9 s di attesa a vuoto per passata.**
>   `CONVENTIONS.md` li vieta dalla prima riga; `check:sleeps` è verde perché è
>   un cricchetto e congela il debito invece di vietarlo. È il taglio più grosso
>   disponibile sui tempi senza toccare la parallelizzazione.
> - **98 test (9%) hanno come unica asserzione la visibilità**, e 70 non passano
>   nemmeno da un page-object che potrebbe asserire dentro. Violano D7 dello
>   STANDARD di spec-flow.
> - **956 usi di `.first()`/`.last()`**, che `CONVENTIONS.md` vieta su pareggi.
>   Nessun cancello li guarda.
> - **62 prefissi di nome con un solo file** e 12 gruppi di quasi-duplicati
>   (quattro file coprono «lo split interno al progetto sopravvive al reload»).
>   Non c'è una tassonomia: c'è un accumulo cronologico.
> - **Zero baseline visive** (`toHaveScreenshot` non compare in nessun file):
>   nessuna regressione puramente grafica può essere colta.
> - **273 `data-testid` su 606 non sono usati da nessun test.**
>
> La riorganizzazione dei file **non** è stata fatta di proposito: spostarli
> cambia l'assegnazione degli shard, e al 25/08 un'altra sessione stava
> lavorando proprio sui tempi e sulla pubblicazione UAT. È il primo pezzo da
> fare quando quel lavoro è finito, e va fatto in un colpo solo.
>
> Il legame fra questi test e i requisiti di `openspec/specs/` lo misura
> `bun run check:spec-coverage` (cablato in CI). Si dichiara così, sullo
> scenario — è la convenzione già in uso qui, 274 test in 45 file:
>
> ```ts
> test.info().annotations.push({ type: "spec", description: "KANBAN-01" });
> ```
>
> Nei test `bun` (dove `test.info()` non esiste) si dichiara nel commento di
> testa del file: `@covers KANBAN-01, KANBAN-02`.

For test-authoring rules (locators, waits, fixtures, test data) see
[`CONVENTIONS.md`](./CONVENTIONS.md) — the single source of truth.

## Running

```bash
# From the repo root. Tests run against http://localhost:13334
# (a dedicated test server; global-setup.ts starts/seeds it).
npx playwright test                       # all tests
npx playwright test chat.spec.ts          # a single file
npx playwright test --project=chromium    # desktop only
npx playwright test --project=mobile      # mobile-*.spec.ts at 375px
npx playwright test -g "sends message"    # by title
npx playwright show-report test-results/html-report
```

### Before landing: the specs of what you changed

```bash
bun run check:e2e-touched --list   # which specs your branch touches
bun run check:e2e-touched          # select and run them
```

None of the six delivery gates (`typecheck`, `lint`, `check:deadcode`,
`check:emdash`, `check:migrations`, `test:unit`) runs an e2e test, and a land is
a LOCAL merge: it never passes through the CI job that runs the PR tier of this
suite. On 27/08 three cards landed green on every gate and the nightly came back
with six reds, two of which were a rule and a list changed on one surface only.

This command closes part of that window without becoming the suite: it diffs the
branch against `main`, derives the related specs (a spec that changed, a spec
that imports a changed module, a spec of the same area, a spec naming one of its
testids), and runs at most eight of them, strongest link first. It is not a
replacement for the nightly, which stays the full measurement: a spec that
measures a surface without naming it is still invisible to the selection.

Config: [`../../playwright.config.ts`](../../playwright.config.ts) —
`baseURL` `http://localhost:13334`, `video: "on"`, sequential
(`fullyParallel: false`) to avoid races on the shared DB.

### La porta non è sempre 13334

Tutto (porta, `DATA_DIR`, bundle, socket del PTY-bridge, file di lock della run)
discende da `E2E_PORT`. Il default vale per il checkout principale; un **worktree
di dispatch** (`~/.topics/worktrees/…`) ne riceve una DERIVATA dal suo path —
[`helpers/worktree-port.ts`](./helpers/worktree-port.ts). Senza, due run
finivano sulla stessa porta e il `global-setup` della seconda ammazzava il server
della prima a metà suite: otto `ECONNREFUSED` che sembravano un bug del codice.
`global-setup` stampa la porta scelta quando non è quella di default.

Per darne una a mano: `E2E_PORT=13400 npx playwright test`. Se un server muore
comunque a metà run, [`helpers/server-death.ts`](./helpers/server-death.ts) lo
dice con nome e cognome invece di lasciare i rossi finti.

## Layout

- `*.spec.ts` — the test files (`testMatch: "*.spec.ts"`).
- `helpers.ts` — navigation helpers: `goToApp`, `openTopic`,
  `openTestChat`, `openTopicByClick`, `openTopicByDoubleClick`.
- `helpers/` — domain utilities: `api-fixtures` (test data + `cleanupAll`),
  `sse-helpers` (`mockChatStream`), `ws-helpers`, `dnd-helpers`,
  `seed-messages`, `gateway-health`.
- `fixtures/` — page-object fixtures; import `test` from
  `fixtures/test-fixtures.ts` (merges chat/sidebar/kanban/terminal/… via
  `mergeTests`).
- `global-setup.ts` / `global-teardown.ts` — server lifecycle + seeding.

## Writing New Tests

```typescript
import { test } from "./fixtures/test-fixtures";
import { expect } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { mockChatStream } from "./helpers/sse-helpers";

test.describe.serial("My feature", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = "My E2E Test " + Date.now(); // unique name
    ({ id: topicId } = await createTopic(request, topicName));
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test("sends a message and sees the streamed response", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible" });

    await mockChatStream(page, {
      chunks: ["Hello ", "from ", "the ", "assistant!"],
      userMessage: "test message",
    });

    await textarea.fill("test message");
    await textarea.press("Enter");

    // Semantic locator + condition-based assertion (auto-retries).
    await expect(page.locator("body")).toContainText(
      "Hello from the assistant!",
    );
  });
});
```

Note: prefer semantic locators (`getByRole`/`getByText`/`getByLabel`) and
condition-based waits. Do not use `page.waitForTimeout()` or
`waitUntil: "networkidle"` — both are banned (see `CONVENTIONS.md`).

### Common selectors
- Main area: `page.locator('[role="main"]')`
- Sidebar: `page.getByRole("treeitem", { name: /…/ })` (use the `openTopic`
  helper, which also ensures the topic is visible in the tab-driven sidebar)
- Chat input: `page.getByRole("textbox", { name: /Message input/ })`
- Buttons: `page.getByRole("button", { name: /…/ })`

## Output

Artifacts land under `test-results/` (per `playwright.config.ts`):
- `test-results/html-report/` — HTML report (`npx playwright show-report`)
- `test-results/artifacts/` — per-test video (`.webm`), screenshot on
  failure, and trace on first retry
