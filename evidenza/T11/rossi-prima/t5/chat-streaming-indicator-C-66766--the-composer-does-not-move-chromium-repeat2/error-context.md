# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: chat-streaming-indicator.spec.ts >> Chat waiting on background work >> at the bottom the line comes and goes as the transcript's last row, and the composer does not move
- Location: tests/e2e/chat-streaming-indicator.spec.ts:426:7

# Error details

```
Error: expect(locator).toHaveCount(expected) failed

Locator:  locator('[data-virtuoso-scroller]').first().getByTestId('background-work-line')
Expected: 1
Received: 0
Timeout:  10000ms

Call log:
  - Expect "toHaveCount" with timeout 10000ms
  - waiting for locator('[data-virtuoso-scroller]').first().getByTestId('background-work-line')
    14 × locator resolved to 0 elements
       - unexpected value "0"

```

# Test source

```ts
  345 |   /** Publishes the status as the attention state, once the socket's snapshot is in. */
  346 |   let publishStatus: (() => Promise<void>) | null = null;
  347 |   /** The server's frame after it stopped the work: the tier back to idle. */
  348 |   let publishStopped: (() => Promise<void>) | null = null;
  349 | 
  350 |   /**
  351 |    * The background work, switchable by the test: the chat in background with
  352 |    * `tasks` and the last news `newsAgeMs` ago, or nothing at all. Two sources,
  353 |    * as the client reads them since notifications-redesign: the PRESENCE of
  354 |    * the work and its tasks are the attention state (`attention:updated` with
  355 |    * the state `working` and its tasks, staged as the server writes it), the DETAILS
  356 |    * (the last news, a stale job) are still the status poll. Before `goToApp`.
  357 |    */
  358 |   async function armBackgroundStatus(page: Page): Promise<BackgroundStatus> {
  359 |     const ws = await interceptWebSocket(page, /\/ws(?:\?|$)/);
  360 |     let background = true;
  361 |     let tasks: typeof TASKS = TASKS;
  362 |     const publish = async (): Promise<void> => {
  363 |       await stageAttention(ws, attentionUpdated(`topic:${bgTopicId}`, background
  364 |         ? {
  365 |             state: "working",
  366 |             // No task listed: one reported and the CLI is about to wake, which
  367 |             // the server writes as a task of kind `wake` (`attentionBackground`).
  368 |             background: tasks.length
  369 |               ? tasks.map((t, i) => ({ id: `bg-${i}`, kind: t.type === "local_agent" ? "agent" : "bash", label: t.description, startedAt: new Date().toISOString() }))
  370 |               : [{ id: "wake", kind: "wake", label: "Verifica build", startedAt: new Date().toISOString() }],
  371 |           }
  372 |         : { state: "idle" }));
  373 |     };
  374 |     publishStatus = publish;
  375 |     publishStopped = () => stageAttention(ws, attentionUpdated(`topic:${bgTopicId}`, { state: "idle" }));
  376 |     const status: BackgroundStatus = {
  377 |       get background() { return background; },
  378 |       set background(v: boolean) { background = v; void publish(); },
  379 |       get tasks() { return tasks; },
  380 |       set tasks(v: typeof TASKS) { tasks = v; void publish(); },
  381 |       newsAgeMs: 0,
  382 |     };
  383 |     await page.route("**/api/topics/streaming", (route) =>
  384 |       route.fulfill({
  385 |         status: 200,
  386 |         contentType: "application/json",
  387 |         body: JSON.stringify({
  388 |           sessions: background
  389 |             ? [{
  390 |                 topicId: bgTopicId, sessionKey: bgSessionKey, state: "background",
  391 |                 tasks, lastSignalAt: Date.now() - status.newsAgeMs,
  392 |               }]
  393 |             : [],
  394 |         }),
  395 |       }),
  396 |     );
  397 |     return status;
  398 |   }
  399 | 
  400 |   async function openBackgroundChat(page: Page, chatPage: ChatPage) {
  401 |     await goToApp(page);
  402 |     await publishStatus?.();
  403 |     await page.keyboard.press("Escape");
  404 |     await openTopic(page, new RegExp(bgTopicName));
  405 |     await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
  406 |   }
  407 | 
  408 |   /** How far the chat scroller is from its true bottom, in px. */
  409 |   async function distanceFromBottom(page: Page): Promise<number> {
  410 |     return page.locator("[data-virtuoso-scroller]").first()
  411 |       .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  412 |   }
  413 | 
  414 |   /** The box of the whole block at the foot of the chat: the composer plus whatever strips sit in it. */
  415 |   async function composerBox(page: Page) {
  416 |     const box = await page.getByTestId("chat-input-area").boundingBox();
  417 |     if (!box) throw new Error("the composer block has no box");
  418 |     return box;
  419 |   }
  420 | 
  421 |   function expectSameBox(after: { y: number; height: number }, before: { y: number; height: number }) {
  422 |     expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(0.5);
  423 |     expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(0.5);
  424 |   }
  425 | 
  426 |   test("at the bottom the line comes and goes as the transcript's last row, and the composer does not move", async ({ page, chatPage }) => {
  427 |     // Each change of the work waits for the next 15 s poll: two of them do not fit the default 30 s.
  428 |     test.setTimeout(90_000);
  429 |     test.info().annotations.push({ type: "spec", description: "BGVIS-04" });
  430 |     const status = await armBackgroundStatus(page);
  431 |     status.background = false;
  432 |     await openBackgroundChat(page, chatPage);
  433 |     const line = page.getByTestId("background-work-line");
  434 |     await expect.poll(() => distanceFromBottom(page), { timeout: 15_000 }).toBeLessThanOrEqual(8);
  435 |     const before = await composerBox(page);
  436 | 
  437 |     // Work starts: the next poll (every 15 s) brings it.
  438 |     status.background = true;
  439 |     await expect(line).toBeVisible({ timeout: 20_000 });
  440 |     await expect.poll(() => distanceFromBottom(page), { timeout: 5_000 }).toBeLessThanOrEqual(8);
  441 |     const withLine = await composerBox(page);
  442 |     expectSameBox(withLine, before);
  443 |     // THE LAST ROW OF THE TRANSCRIPT: inside the scroller, under the last
  444 |     // message, and above the composer rather than behind it.
> 445 |     await expect(page.locator("[data-virtuoso-scroller]").first().getByTestId("background-work-line")).toHaveCount(1);
      |                                                                                                        ^ Error: expect(locator).toHaveCount(expected) failed
  446 |     const geometry = await line.evaluate((el) => {
  447 |       const scroller = el.closest("[data-virtuoso-scroller]")!;
  448 |       const rows = [...scroller.querySelectorAll<HTMLElement>("[data-index]")];
  449 |       const lastRow = rows.reduce((a, b) => (Number(b.dataset.index) > Number(a.dataset.index) ? b : a));
  450 |       return { lineTop: el.getBoundingClientRect().top, lineBottom: el.getBoundingClientRect().bottom, lastRowBottom: lastRow.getBoundingClientRect().bottom };
  451 |     });
  452 |     expect(geometry.lineTop).toBeGreaterThanOrEqual(geometry.lastRowBottom - 0.5);
  453 |     expect(geometry.lineBottom).toBeLessThanOrEqual(withLine.y + 0.5);
  454 | 
  455 |     // Work ends: the line goes, the composer stays put, the view stays at the bottom.
  456 |     status.background = false;
  457 |     await expect(line).toHaveCount(0, { timeout: 20_000 });
  458 |     await expect.poll(() => distanceFromBottom(page), { timeout: 5_000 }).toBeLessThanOrEqual(8);
  459 |     expectSameBox(await composerBox(page), before);
  460 |   });
  461 | 
  462 |   test("scrolled up reading, the line appearing does not move what is on screen", async ({ page, chatPage }) => {
  463 |     // Each change of the work waits for the next 15 s poll: two of them do not fit the default 30 s.
  464 |     test.setTimeout(90_000);
  465 |     test.info().annotations.push({ type: "spec", description: "BGVIS-04" });
  466 |     const status = await armBackgroundStatus(page);
  467 |     status.background = false;
  468 |     await openBackgroundChat(page, chatPage);
  469 |     const scroller = page.locator("[data-virtuoso-scroller]").first();
  470 |     await expect.poll(() => distanceFromBottom(page), { timeout: 15_000 }).toBeLessThanOrEqual(8);
  471 |     // A wheel, not a `scrollTop` write: only a gesture hands the scroll to the reader.
  472 |     await scroller.hover();
  473 |     await page.mouse.wheel(0, -1500);
  474 |     await expect.poll(() => distanceFromBottom(page), { timeout: 5_000 }).toBeGreaterThan(600);
  475 |     // Watched in the page, frame by frame: the reference is the first message
  476 |     // fully on screen in the LAST frame before the line lands, so a list still
  477 |     // settling earlier is not blamed on the line; then thirty frames with the
  478 |     // line in, so a late pin would be caught too.
  479 |     // The watch starts FIRST, and the work arrives only once it has seen a
  480 |     // frame without the line: the attention frame lands within a frame, not
  481 |     // after a 15 s poll, and the reference must be taken before it.
  482 |     const watching = scroller.evaluate((el) => new Promise<{ drift: number; index: string }>((done) => {
  483 |       let ref = { index: "", top: NaN };
  484 |       let worst = 0;
  485 |       let framesWithLine = 0;
  486 |       const firstOnScreen = () => {
  487 |         const box = el.getBoundingClientRect();
  488 |         const row = [...el.querySelectorAll<HTMLElement>("[data-index]")]
  489 |           .filter((r) => r.getBoundingClientRect().top >= box.top && r.getBoundingClientRect().bottom <= box.bottom)
  490 |           .sort((x, y) => x.getBoundingClientRect().top - y.getBoundingClientRect().top)[0];
  491 |         return { index: row?.dataset.index ?? "", top: row?.getBoundingClientRect().top ?? NaN };
  492 |       };
  493 |       const tick = () => {
  494 |         if (!document.querySelector('[data-testid="background-work-line"]')) {
  495 |           ref = firstOnScreen();
  496 |           (window as unknown as { __bgWatchReady?: boolean }).__bgWatchReady = true;
  497 |           requestAnimationFrame(tick);
  498 |           return;
  499 |         }
  500 |         const row = el.querySelector<HTMLElement>(`[data-index="${ref.index}"]`);
  501 |         worst = Math.max(worst, row ? Math.abs(row.getBoundingClientRect().top - ref.top) : Infinity);
  502 |         if (++framesWithLine < 30) requestAnimationFrame(tick);
  503 |         else done({ drift: worst, index: ref.index });
  504 |       };
  505 |       requestAnimationFrame(tick);
  506 |     }));
  507 |     await page.waitForFunction(() => (window as unknown as { __bgWatchReady?: boolean }).__bgWatchReady === true, undefined, { timeout: 10_000 });
  508 |     status.background = true;
  509 |     const { drift, index } = await watching;
  510 |     expect(index).not.toBe("");
  511 |     expect(drift).toBeLessThanOrEqual(0.5);
  512 |   });
  513 | 
  514 |   test("the row, the tab and the line say what the chat waits on, and a message still goes out at once", async ({ page, chatPage }) => {
  515 |     for (const id of ["BGVIS-01", "BGVIS-02", "BGVIS-04"]) test.info().annotations.push({ type: "spec", description: id });
  516 |     await armBackgroundStatus(page);
  517 |     await openBackgroundChat(page, chatPage);
  518 | 
  519 |     // THE WORKING RING, on the sidebar row and on the tab: a job the chat
  520 |     // waits for is work in progress, like a reply (one state since 2026-10-04).
  521 |     const row = page.getByRole("treeitem", { name: new RegExp(bgTopicName) }).first();
  522 |     const glyph = row.locator('[data-loader-state="working"]');
  523 |     await expect(glyph).toBeVisible({ timeout: 15_000 });
  524 |     await expect(row.locator('[data-loader-state="waiting"]')).toHaveCount(0);
  525 |     // The tooltip says how many jobs run and that the chat is free.
  526 |     await expect(glyph).toHaveAttribute("title", /2 lavori in background\. La chat è libera/);
  527 |     // The suite runs with reduced motion: the arc stands still
  528 |     // (`index.css`, the `prefers-reduced-motion` branch).
  529 |     expect(await glyph.locator("svg").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  530 |     const tab = page.locator(`[data-pane-id="${bgTopicId}"]`).first();
  531 |     await expect(tab.locator('[data-loader-state="working"]')).toBeVisible({ timeout: 10_000 });
  532 |     // No turn is open, so the row offers no Stop: that one is the composer's.
  533 |     await row.hover();
  534 |     await expect(row.getByTestId("topic-row-stop")).toHaveCount(0);
  535 | 
  536 |     // THE LINE at the end of the transcript names both tasks.
  537 |     const line = page.getByTestId("background-work-line");
  538 |     await expect(line).toBeVisible({ timeout: 10_000 });
  539 |     await expect(line).toContainText("Verifica build");
  540 |     await expect(line).toContainText("Monitor deploy");
  541 | 
  542 |     // THE COMPOSER IS FREE: with text it SENDS (never queues), and the request
  543 |     // leaves at once, as in a chat at rest.
  544 |     await page.route("**/api/chat", async (route) => {
  545 |       if (route.request().method() !== "POST") return route.fallback();
```