/**
 * A GROUP card goes dark once you have read the chat inside it, and it STAYS
 * dark until a new turn.
 *
 * THE BUG. A Claude phase like `awaiting-user` does not clear by itself: it sits
 * there until the next turn. For a single chat the blue fill is put out by the
 * "seen" mark (SEEN_DWELL_MS in front of it, with the window awake), so the
 * sidebar row and the tab both went quiet as soon as you read it. The GROUP
 * rollup in `spaceAttentionTier` read the RAW awaiting sets instead, with no
 * `seenSubjects` gate, so the card kept its blue dot on a child you had already
 * read. Nothing put it out short of the next message: you could open the chat,
 * read it, walk away, and the group header was still shouting.
 *
 * The handle is `data-attention` on the group row, not a Tailwind class. A class
 * is a rendering detail, and renaming one would turn this into a dead locator
 * that passes because it finds nothing. The attribute is the AGGREGATE of what
 * is still worth looking at inside the group, which is why its disappearance is
 * the proof.
 *
 * The video earns its place here: the thing under test is a blue field that
 * lights, dies on its own, stays dead across a focus change, and lights again.
 * A still screenshot cannot say any of that.
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import {
  createTopic,
  deleteTopic,
  seedPaneStore,
  unarchiveTopic,
} from "./helpers/api-fixtures";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);
test.use({ video: "on" });

const BASE = E2E_BASE;

/** The group under test. A literal id, not a generated one: the locator has to
 *  be written down in this file to be readable, and the pane-store is reseeded
 *  from scratch in `beforeEach` so nothing can collide with it. */
const SPACE_ID = "space:card-seen";
const SPACE_NAME = "Gruppo Visto";

/** The implicit default group, which is always drawn and is never a registry
 *  record (`DEFAULT_SPACE_ID` / `DEFAULT_SPACE_LABEL` in the client). */
const DEFAULT_SPACE_ID = "space:default";
const DEFAULT_SPACE_NAME = "Principale";

test.describe("Card di un gruppo: si spegne quando hai letto la chat dentro", () => {
  /** The chat that lives INSIDE the group. It is the one that finishes a turn. */
  let insideId: string;
  let insideSessionKey: string;
  /** A chat in the default group. It is what the user is looking at when the
   *  turn ends, so the chat inside the group is NOT the active pane and cannot
   *  be marked seen before the test has lit the card. */
  let outsideId: string;
  let outsideSessionKey: string;

  /**
   * The sessionKey the SERVER assigned. Never guessed from the naming
   * convention: a change of format would seed a phase for a session nobody is
   * watching, and the test would go green on an empty screen instead of red.
   */
  async function sessionKeyOf(
    request: import("@playwright/test").APIRequestContext,
    topicId: string,
  ): Promise<string> {
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const body = await res.json();
    const map: Record<string, { id: string; sessionKey?: string }> = body.topics ?? {};
    const found = map[topicId];
    if (!found?.sessionKey) {
      throw new Error(`la topic ${topicId} non ha sessionKey: il seed della fase non puo' funzionare`);
    }
    return found.sessionKey;
  }

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now();
    const inside = await createTopic(request, `card-visto-dentro-${stamp}`);
    insideId = inside.id;
    insideSessionKey = await sessionKeyOf(request, insideId);
    const outside = await createTopic(request, `card-visto-fuori-${stamp}`);
    outsideId = outside.id;
    outsideSessionKey = await sessionKeyOf(request, outsideId);
  });

  test.afterAll(async ({ request }) => {
    for (const id of [insideId, outsideId]) {
      if (id) await deleteTopic(request, id).catch(() => {});
    }
  });

  test.beforeEach(async ({ request }) => {
    // Asking for a chat pane IS declaring the topic open: the client filters
    // panes of archived topics, so a pane seeded for an archived topic writes a
    // state the UI is required to ignore.
    await Promise.all([insideId, outsideId].map((id) => unarchiveTopic(request, id)));
    // Through `seedPaneStore`, never a bare PUT: a late beacon from the
    // previous spec's dying page would otherwise land on top of the seed and
    // leave this test with an empty workspace.
    await seedPaneStore(request, () => {
      const openedAt = Date.now();
      const pane = (id: string, spaceId?: string) => ({
        id,
        type: "chat",
        title: "",
        topicId: id,
        openedAt,
        ...(spaceId ? { spaceId } : {}),
      });
      return {
        panes: {
          [outsideId]: pane(outsideId),
          [insideId]: pane(insideId, SPACE_ID),
        },
        groups: {
          "group:default": {
            id: "group:default",
            paneIds: [outsideId, insideId],
            splitRatio: 1,
            splitAxis: "horizontal",
          },
        },
        projects: {},
        groupOrder: ["group:default"],
        closedStack: [],
        // A group is drawn as long as it HOLDS something, so the registry entry
        // alone is not enough: the pane above carries the `spaceId` that gives
        // this card its one tab.
        spaces: { [SPACE_ID]: { id: SPACE_ID, name: SPACE_NAME, order: 1, updatedAt: openedAt } },
      };
    });
  });

  test("un turno finito dentro il gruppo accende la card, leggerlo la spegne per sempre", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "SEEN-01" });
    // The intercept goes in BEFORE the goto, or the initial connection escapes it.
    const ws = await interceptWebSocket(page);
    await goToApp(page);

    // `role="tab"` is part of the locator on purpose. `data-space-id` is carried
    // by TWO elements: the outer card (the drop target for a tab dragged into
    // the group) and the header row inside it. Only the row is a tab, and only
    // the row carries the tier.
    const groupCard = page.locator(`[role="tab"][data-space-id="${SPACE_ID}"]`);
    const mainCard = page.locator(`[role="tab"][data-space-id="${DEFAULT_SPACE_ID}"]`);
    await expect(groupCard).toBeVisible({ timeout: 20000 });

    // Clean start: no tier on the group.
    await expect(groupCard).not.toHaveAttribute("data-attention", /input|done/);

    // The turn of the chat INSIDE the group ends.
    ws.send({
      type: "session:state",
      sessionKey: insideSessionKey,
      state: { phase: "awaiting-user", rev: 1, claudeSessionId: insideSessionKey },
    });

    // The card says it: "there is something in here waiting for you". This is
    // the only thing that says so while the group is closed.
    await expect(groupCard).toHaveAttribute("data-attention", "done", { timeout: 15000 });

    // The user goes into the group and stays on the chat past the "seen"
    // threshold (SEEN_DWELL_MS = 1200 ms). Switching group makes that chat the
    // active pane, which is what arms the threshold. The fill must fall BY
    // ITSELF, with no further click. This is the assertion that was red.
    await groupCard.getByRole("button", { name: SPACE_NAME, exact: true }).click();
    await expect(groupCard).not.toHaveAttribute("data-attention", /input|done/, { timeout: 15000 });

    // And here is the bug: move the focus elsewhere. The old rollup lit up
    // again, because the only thing hiding it was "this card is the active one
    // right now", which is transitory.
    await mainCard.getByRole("button", { name: DEFAULT_SPACE_NAME, exact: true }).click();
    await expect(mainCard).toHaveAttribute("aria-selected", "true", { timeout: 10000 });

    // A CLOCK, not a sleep. A negative assertion is true of this instant too,
    // so it needs a window in which the card WOULD have had the time to light
    // up again. That window is bought here with an ORDERED FRAME instead of a
    // fixed wait: frames travel and are applied in order, so once the default
    // group has answered to the chat OUTSIDE, the app has demonstrably taken in
    // new attention state and re-rendered on it.
    //
    // `awaiting-approval` and not `awaiting-user`, because the 'input' tier is
    // NOT gated by "seen": the outside chat is the active pane now, so a 'done'
    // tier would be put out by its own threshold halfway through the assertion.
    ws.send({
      type: "session:state",
      sessionKey: outsideSessionKey,
      state: { phase: "awaiting-approval", rev: 1, claudeSessionId: outsideSessionKey },
    });
    await expect(mainCard).toHaveAttribute("data-attention", "input", { timeout: 15000 });

    // Still dark, with the app awake and busy around it. The phase inside is
    // still `awaiting-user`, so it is the "seen" mark holding, not the absence
    // of state.
    await expect(groupCard).not.toHaveAttribute("data-attention", /input|done/);

    // A NEW turn has to light it again: going dark forever is the opposite bug,
    // and a gate with no reset is exactly how you get there. The "seen" mark
    // falls on the RISING EDGE (`resetSeenOnNewAttention`), so it takes TWO
    // distinct derivations: the session must first LEAVE the awaiting sets and
    // then come back into them. Sent in one breath they collapse into a single
    // pass over the store, where the edge does not exist at all.
    ws.send({
      type: "session:state",
      sessionKey: insideSessionKey,
      state: { phase: "running", rev: 2, claudeSessionId: insideSessionKey },
    });
    // The same clock separates the two halves of the edge. The outside chat
    // leaves the awaiting sets on the frame right AFTER the inside one, so when
    // the default card goes dark the falling half has already been applied.
    // This is the ordering doing the work, not an interval anybody guessed.
    ws.send({
      type: "session:state",
      sessionKey: outsideSessionKey,
      state: { phase: "running", rev: 2, claudeSessionId: outsideSessionKey },
    });
    await expect(mainCard).not.toHaveAttribute("data-attention", /input|done/, { timeout: 15000 });

    ws.send({
      type: "session:state",
      sessionKey: insideSessionKey,
      state: { phase: "awaiting-user", rev: 3, claudeSessionId: insideSessionKey },
    });
    await expect(groupCard).toHaveAttribute("data-attention", "done", { timeout: 15000 });
  });
});
