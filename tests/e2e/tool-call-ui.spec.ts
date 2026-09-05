/**
 * @covers CHAT-TOOL-04
 *
 * Partial: formatted code inside tool bodies.
 */
import { expect, test } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * Slice 7 verification — tool-call rendering rewrite.
 *
 * The new visual stack: ReasoningRow → ToolCallRow(s) → prose → MetaFooter.
 * The old `ToolCallBadge` (boxed card) is no longer rendered for legacy
 * tool calls; inline tool calls inside the prose still use the badge.
 */
test.describe.serial("Tool-call UI rewrite (Slice 7)", () => {
  let topicId: string;
  let topicName: string;
  let sessionKey: string;

  test.beforeAll(async ({ request }) => {
    topicName = "Tool UI " + Date.now();
    const t = await createTopic(request, topicName);
    topicId = t.id;
    // The server derives sessionKey as `topic:${id.slice(0, 8)}` (see
    // server/routes/topics.ts) — createTopic doesn't return it.
    sessionKey = `topic:${t.id.slice(0, 8)}`;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  // Deterministic workspace: THIS topic open, nothing else. This file seeded no
  // pane state at all, so its behaviour depended on what ran before it — it
  // failed when run ALONE (empty workspace: the topic opens as a replaceable
  // PREVIEW tab) and passed after a spec that left pinned panes behind. Seeding
  // the pane-store makes the tab permanent and the only one, so the global
  // `page.locator('[data-testid="tool-call-row-…"]')` queries can only ever
  // resolve inside this topic's pane.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("renders ReasoningRow + ToolCallRow + footer in order", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "THINK-04" });
    // Seed a user message + an assistant message with thinking, two legacy
    // tool calls, prose content, and footer metadata. parentId chains the
    // assistant onto the user so loadActiveThread() returns both.
    const userMsg = await seedMessage(request, {
      sessionKey,
      role: "user",
      content: "Show me what files exist",
      timestamp: new Date(Date.now() - 5000).toISOString(),
    });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      parentId: userMsg.id,
      content: "Here are the files in your project.",
      thinking: "I should list the files using a Bash command.",
      timestamp: new Date(Date.now() - 4000).toISOString(),
      toolCalls: [
        {
          id: "tc-bash-1",
          name: "Bash",
          args: { command: "ls -la" },
          status: "success",
          result: "total 24\ndrwxr-xr-x  3 user  staff   96 Apr 28 10:00 .",
        },
        {
          id: "tc-read-1",
          name: "Read",
          args: { file_path: "/tmp/example.txt" },
          status: "success",
          result: "Hello world",
        },
      ],
      latencyMs: 3900,
      usagePromptTokens: 432,
      usageCompletionTokens: 354,
      costCents: 2, // $0.02
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));

    // Wait for the assistant message bubble to render.
    const assistant = page.locator('[data-testid="message-content-assistant"]').last();
    await assistant.waitFor({ state: "visible", timeout: 10_000 });

    // Reasoning row is present (collapsed by default).
    const reasoning = assistant.locator('[data-testid="reasoning-row"]');
    await expect(reasoning).toBeVisible();
    await expect(reasoning).toContainText("Reasoning");

    // Both tool-call rows are present, each labelled with the tool name.
    const bashRow = assistant.locator('[data-testid="tool-call-row-tc-bash-1"]');
    const readRow = assistant.locator('[data-testid="tool-call-row-tc-read-1"]');
    await expect(bashRow).toBeVisible();
    await expect(readRow).toBeVisible();
    // A Bash tool call renders under its canonical display label "Shell"
    // (buildToolDisplayLabel → { name: 'Shell' } for a shell detail, toolDetail.ts:195),
    // not the raw tool name "Bash".
    await expect(bashRow).toContainText("Shell");
    await expect(readRow).toContainText("Read");

    // Lo stato è una proprietà della RIGA: da quando l'esito buono non ha più
    // un simbolo (la spunta verde confermava la norma su ogni riga riuscita),
    // la colonna di destra può essere vuota, e un contenitore vuoto non è
    // «visibile» per nessuno.
    await expect(assistant.locator('[data-testid="tool-call-row-tc-bash-1"]')).toHaveAttribute("data-status", "success");
    await expect(assistant.locator('[data-testid="tool-call-row-tc-read-1"]')).toHaveAttribute("data-status", "success");

    // La striscia di chiusura non sta più DENTRO il contenuto del messaggio:
    // vive nella riga di servizio che <MessageBubble> apre sotto la bolla,
    // insieme all'ora. Ci si aggancia quindi alla RIGA del messaggio.
    const bubble = page.locator('[data-testid="chat-message"][data-role="assistant"]').last();
    const footer = bubble.locator('[data-testid="message-meta-footer"]');
    await expect(footer).toBeVisible();
    await expect(footer).toContainText("3.9s");
    await expect(footer).toContainText("786 tokens");
    await expect(footer).toContainText("$0.02");

    // Old ToolCallBadge cards are NOT rendered for legacy tool calls (the
    // new ToolCallRow replaced them). The badge testid is `tool-call-${id}`.
    const oldBadge = assistant.locator('[data-testid="tool-call-tc-bash-1"]');
    await expect(oldBadge).toHaveCount(0);
  });

  test("la striscia dice IN CHIARO quanti token erano rilettura e quanti nuovi", async ({ page, request }) => {
    // La contabilità c'era, ma solo nel `title`: dietro un hover che su una
    // striscia di metadati nessuno va a cercare. In chiaro restava il costo
    // della cache — la conseguenza — e non la causa.
    const fresh = await createTopic(request, "Token Split " + Date.now());
    const sk = `topic:${fresh.id.slice(0, 8)}`;
    try {
      const u = await seedMessage(request, {
        sessionKey: sk, role: "user", content: "Hi",
        timestamp: new Date(Date.now() - 3000).toISOString(),
      });
      await seedMessage(request, {
        sessionKey: sk, role: "assistant", parentId: u.id,
        content: "Turno lungo.",
        timestamp: new Date(Date.now() - 2000).toISOString(),
        usagePromptTokens: 1_000_000,
        usageCompletionTokens: 4_000,
        costCents: 40,
        cacheReadTokens: 900_000,
        cacheCreationTokens: 60_000,
        cacheCreation1hTokens: 10_000,
      });

      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(fresh.name));

      const split = page.locator('[data-testid="message-token-split"]').last();
      await expect(split).toBeVisible({ timeout: 15_000 });
      // 900k riletti; nuovi = 30k freschi + 60k scritti + 10k a un'ora = 100k.
      // Le scritture stanno coi nuovi: erano token freschi, pagati DI PIÙ per
      // essere memorizzati — contarle come cache spaccerebbe per risparmio un
      // anticipo. Le due voci sommano al prompt: 900k + 100k = 1M.
      await expect(split).toContainText("900k da cache");
      await expect(split).toContainText("100k nuovi");
      // La striscia ora si RIVELA passandoci sopra, e sta su UNA riga sola
      // insieme all'ora. Va provato che sia davvero così, o il verde non
      // vorrebbe dire niente: Playwright considera visibile anche un elemento a
      // opacity 0, quindi senza queste due misure la suite resterebbe verde con
      // la striscia invisibile o spezzata su due righe.
      const bubble = page.locator('[data-testid="chat-message"][data-role="assistant"]').last();
      const row = bubble.locator('[data-testid="message-meta-row"]');
      const opacity = () => row.evaluate((el) => getComputedStyle(el).opacity);
      expect(Number(await opacity())).toBeLessThan(0.5);
      await bubble.hover();
      await expect.poll(async () => Number(await opacity()), { timeout: 4000 }).toBeGreaterThan(0.9);

      // Una riga sola: l'altezza della riga di servizio non supera quella di una
      // singola riga di testo a 11px (line-height 1.5 ≈ 16,5px, con margine).
      const h = await row.evaluate((el) => el.getBoundingClientRect().height);
      expect(h).toBeLessThan(24);

      // La prova durevole è l'immagine della riga come si legge, sotto il mouse.
      await row.screenshot({ path: "test-results/message-meta-row.png" });
    } finally {
      await deleteTopic(request, fresh.id);
    }
  });

  test("footer hidden when no usage data is present", async ({ page, request }) => {
    // Fresh topic so we can seed a footer-less assistant message.
    const fresh = await createTopic(request, "Footer Hidden " + Date.now());
    const sk = `topic:${fresh.id.slice(0, 8)}`;
    try {
      const u = await seedMessage(request, {
        sessionKey: sk, role: "user", content: "Hi",
        timestamp: new Date(Date.now() - 3000).toISOString(),
      });
      await seedMessage(request, {
        sessionKey: sk,
        role: "assistant",
        parentId: u.id,
        content: "Plain reply with no tool calls and no metrics.",
        timestamp: new Date(Date.now() - 2000).toISOString(),
      });

      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(fresh.name));

      const assistant = page.locator('[data-testid="message-content-assistant"]').last();
      await assistant.waitFor({ state: "visible", timeout: 10_000 });

      // Nessuna striscia. Agganciata alla RIGA del messaggio e non al suo
      // contenuto: dentro `message-content-assistant` la striscia non c'è più
      // per costruzione, quindi questo conteggio sarebbe passato SEMPRE — un
      // guardiano che non può fallire non è un guardiano.
      const bubble = page.locator('[data-testid="chat-message"][data-role="assistant"]').last();
      await expect(bubble).toBeVisible();
      await expect(bubble.locator('[data-testid="message-meta-footer"]')).toHaveCount(0);
      // L'ora invece c'è: la riga di servizio esiste, è la striscia a mancare.
      await expect(bubble.locator('[data-testid="message-meta-row"]')).toHaveCount(1);
    } finally {
      await deleteTopic(request, fresh.id);
    }
  });

  test("clicking a tool row reveals args + result", async ({ page, request }) => {
    const fresh = await createTopic(request, "Tool Expand " + Date.now());
    const sk = `topic:${fresh.id.slice(0, 8)}`;
    try {
      const u = await seedMessage(request, {
        sessionKey: sk, role: "user", content: "Hi",
        timestamp: new Date(Date.now() - 3000).toISOString(),
      });
      await seedMessage(request, {
        sessionKey: sk,
        role: "assistant",
        parentId: u.id,
        content: "Done.",
        timestamp: new Date(Date.now() - 2000).toISOString(),
        toolCalls: [{
          id: "tc-expand",
          name: "Bash",
          args: { command: "echo hello" },
          status: "success",
          result: "hello",
        }],
      });

      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(fresh.name));

      const row = page.locator('[data-testid="tool-call-row-tc-expand"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });

      // The collapsed header shows the tool name + a command *preview* ("Shell"
      // + "echo hello", buildToolDisplayLabel summary). The ShellCard body —
      // the "$ command" line + output block (ToolCards.tsx) — only mounts once
      // the row expands, so the pre-expand invariant is "no expanded body".
      await expect(row.locator('[data-testid="tool-call-result"]')).toHaveCount(0);
      await row.locator("button").first().click();
      await expect(row).toContainText("$ echo hello");
      await expect(row.locator('[data-testid="tool-call-result"]')).toContainText("hello");
    } finally {
      await deleteTopic(request, fresh.id);
    }
  });

  test("a tool call with 30 KB of args arrives as its head and opens whole", async ({ page, request }) => {
    // WIRE-09: the history wire carries of a tool call only what the CLOSED
    // row draws. A 30 KB script travels as its first 512 characters (the
    // closed row shows its first line), a 30 KB Write as its path; the whole
    // text comes back from the detail route the first time the row opens.
    test.info().annotations.push({ type: "spec", description: "WIRE-09" });
    const fresh = await createTopic(request, "Tool Lean " + Date.now());
    const sk = `topic:${fresh.id.slice(0, 8)}`;
    // Head and tail markers: the head must be on the closed row, the tail
    // must NOT be on the wire and MUST be in the open body.
    const SHELL_HEAD = "echo lean-shell-head";
    const SHELL_TAIL = "echo lean-shell-tail-marker";
    const WRITE_TAIL = "// lean-write-tail-marker";
    const command = [SHELL_HEAD, ...Array.from({ length: 700 }, (_, i) => `echo filler-${i} ${"x".repeat(32)}`), SHELL_TAIL].join("\n");
    const content = `// lean-write-head\n${"const filler = 1;\n".repeat(1800)}${WRITE_TAIL}\n`;
    expect(command.length).toBeGreaterThan(30_000);
    expect(content.length).toBeGreaterThan(30_000);
    try {
      const u = await seedMessage(request, {
        sessionKey: sk, role: "user", content: "Hi",
        timestamp: new Date(Date.now() - 3000).toISOString(),
      });
      await seedMessage(request, {
        sessionKey: sk,
        role: "assistant",
        parentId: u.id,
        content: "Done.",
        timestamp: new Date(Date.now() - 2000).toISOString(),
        toolCalls: [
          { id: "tc-lean-shell", name: "Bash", args: { command }, status: "success", result: "ok" },
          { id: "tc-lean-write", name: "Write", args: { file_path: "/tmp/lean/big-file.ts", content }, status: "success", result: "File created successfully at: /tmp/lean/big-file.ts" },
        ],
      });

      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(fresh.name));

      const shell = page.locator('[data-testid="tool-call-row-tc-lean-shell"]');
      await shell.waitFor({ state: "visible", timeout: 10_000 });
      const write = page.locator('[data-testid="tool-call-row-tc-lean-write"]');
      await expect(write).toBeVisible();

      // CLOSED: the head of the command and the path are drawn; the tails are
      // not even in the DOM, because the wire did not carry them.
      await expect(shell).toContainText(SHELL_HEAD);
      await expect(shell).not.toContainText(SHELL_TAIL);
      await expect(write).toContainText("big-file.ts");
      await expect(write).not.toContainText(WRITE_TAIL);

      // OPEN: the whole text is fetched and drawn, tail included.
      await shell.locator("button").first().click();
      await expect(shell.locator('[data-testid="tool-call-args"]')).toContainText(SHELL_TAIL, { timeout: 10_000 });
      await write.locator("button").first().click();
      await expect(write.locator('[data-testid="tool-call-result"]')).toContainText(WRITE_TAIL, { timeout: 10_000 });
      // The Write card also counts the characters of the WHOLE content, not of
      // the preview. The card formats the number with the browser's locale, so
      // the digit groups may be split by any separator (or none).
      const grouped = String(content.length).replace(/\B(?=(\d{3})+(?!\d))/g, "[^\\d]?");
      await expect(write.locator('[data-testid="tool-call-args"]')).toContainText(new RegExp(`${grouped} chars`));
    } finally {
      await deleteTopic(request, fresh.id);
    }
  });
});

/**
 * chat-tool-experience — CHAT-TOOL-02 (grouping) + CHAT-TOOL-04 (highlighting).
 *
 * Runs of ≥3 consecutive settled tool calls collapse into ONE summary row
 * with per-tool counts + wall-clock duration; click expands the classic
 * per-call rows. waiting_for_input / sub-agent rows never aggregate. Tool
 * card bodies highlight code through the same hljs facade as markdown fences.
 */
test.describe.serial("Tool grouping + highlighting (chat-tool-experience)", () => {
  test("TOOLROW-02: run of 5 settled calls collapses into a summary row with counts, errors and duration", async ({ page, request }) => {
    const fresh = await createTopic(request, "Tool Group " + Date.now());
    const sk = `topic:${fresh.id.slice(0, 8)}`;
    const base = Date.now() - 120_000;
    try {
      const u = await seedMessage(request, {
        sessionKey: sk, role: "user", content: "do five things",
        timestamp: new Date(Date.now() - 3000).toISOString(),
      });
      await seedMessage(request, {
        sessionKey: sk,
        role: "assistant",
        parentId: u.id,
        content: "All five done.",
        timestamp: new Date(Date.now() - 2000).toISOString(),
        toolCalls: [
          { id: "g-r1", name: "Read", args: { file_path: "/a.ts" }, status: "success", result: "aaa", startedAt: base, endedAt: base + 2_000 },
          { id: "g-r2", name: "Read", args: { file_path: "/b.ts" }, status: "success", result: "bbb", startedAt: base + 2_500, endedAt: base + 5_000 },
          { id: "g-r3", name: "Read", args: { file_path: "/c.ts" }, status: "success", result: "ccc", startedAt: base + 6_000, endedAt: base + 9_000 },
          { id: "g-b1", name: "Bash", args: { command: "bun test" }, status: "error", error: "exit 1", startedAt: base + 10_000, endedAt: base + 30_000 },
          { id: "g-e1", name: "Edit", args: { file_path: "/a.ts" }, status: "success", startedAt: base + 31_000, endedAt: base + 41_000 },
        ],
      });

      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(fresh.name));

      // ONE summary row instead of five per-call rows.
      const group = page.locator('[data-testid="tool-group-row"]');
      await expect(group).toBeVisible({ timeout: 10_000 });
      await expect(group).toContainText("5 azioni");
      await expect(group).toContainText("Read ×3");
      // Wall-clock span: first startedAt → last endedAt = 41s.
      await expect(group).toContainText("41s");
      // The errored call stays IN the aggregate but its count is surfaced
      // on the collapsed summary (red ✗ badge).
      await expect(group.locator('[data-testid="tool-group-errors"]')).toContainText("1");
      // Per-call rows are NOT mounted while collapsed.
      await expect(page.locator('[data-testid="tool-call-row-g-r1"]')).toHaveCount(0);

      // Click → the classic per-call rows, in order.
      await group.locator('[data-testid="tool-group-summary"]').click();
      for (const id of ["g-r1", "g-r2", "g-r3", "g-b1", "g-e1"]) {
        await expect(page.locator(`[data-testid="tool-call-row-${id}"]`)).toBeVisible();
      }
      // Per-call duration renders from startedAt/endedAt (g-b1: 20s).
      await expect(
        page.locator('[data-testid="tool-call-row-g-b1"] [data-testid="tool-duration"]'),
      ).toContainText("20s");
    } finally {
      await deleteTopic(request, fresh.id);
    }
  });

  test("TOOLROW-02b: sub-agent rows never aggregate — they split the run", async ({ page, request }) => {
    const fresh = await createTopic(request, "Tool Group Solo " + Date.now());
    const sk = `topic:${fresh.id.slice(0, 8)}`;
    try {
      const u = await seedMessage(request, {
        sessionKey: sk, role: "user", content: "explore then read",
        timestamp: new Date(Date.now() - 3000).toISOString(),
      });
      await seedMessage(request, {
        sessionKey: sk,
        role: "assistant",
        parentId: u.id,
        content: "Done exploring.",
        timestamp: new Date(Date.now() - 2000).toISOString(),
        toolCalls: [
          { id: "s-r1", name: "Read", args: { file_path: "/a.ts" }, status: "success", result: "aaa" },
          { id: "s-r2", name: "Read", args: { file_path: "/b.ts" }, status: "success", result: "bbb" },
          { id: "s-r3", name: "Read", args: { file_path: "/c.ts" }, status: "success", result: "ccc" },
          { id: "s-task", name: "Task", args: { subagent_type: "Explore", description: "sweep the repo" }, status: "success", result: "found it" },
        ],
      });

      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(fresh.name));

      // The three Reads aggregate; the Task stays a standalone row, visible
      // WITHOUT expanding the group (its action log is the primary signal).
      const group = page.locator('[data-testid="tool-group-row"]');
      await expect(group).toBeVisible({ timeout: 10_000 });
      await expect(group).toContainText("3 azioni");
      await expect(page.locator('[data-testid="tool-call-row-s-task"]')).toBeVisible();
      await expect(page.locator('[data-testid="tool-call-row-s-r1"]')).toHaveCount(0);
    } finally {
      await deleteTopic(request, fresh.id);
    }
  });

  test("TOOLROW-04: Read body highlights TypeScript through the hljs facade", async ({ page, request }) => {
    const fresh = await createTopic(request, "Tool Highlight " + Date.now());
    const sk = `topic:${fresh.id.slice(0, 8)}`;
    try {
      const u = await seedMessage(request, {
        sessionKey: sk, role: "user", content: "read app.ts",
        timestamp: new Date(Date.now() - 3000).toISOString(),
      });
      await seedMessage(request, {
        sessionKey: sk,
        role: "assistant",
        parentId: u.id,
        content: "Read it.",
        timestamp: new Date(Date.now() - 2000).toISOString(),
        toolCalls: [{
          id: "hl-read",
          name: "Read",
          args: { file_path: "/src/app.ts" },
          status: "success",
          result: 'export const app = "hello";',
        }],
      });

      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(fresh.name));

      const row = page.locator('[data-testid="tool-call-row-hl-read"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await row.locator("button").first().click();

      const result = row.locator('[data-testid="tool-call-result"]');
      await expect(result).toContainText("export const app");
      // hljs tokens appear once the lazy tokenizer chunk lands (language
      // derived from the .ts extension) — the same facade markdown fences use.
      await expect(result.locator(".hljs-keyword").first()).toBeVisible({ timeout: 10_000 });
    } finally {
      await deleteTopic(request, fresh.id);
    }
  });
});
