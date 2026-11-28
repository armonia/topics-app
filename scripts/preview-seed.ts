/**
 * The example data a card's preview is photographed on, and the page to shoot.
 *
 * WHY IT IS A MODULE OF ITS OWN. The deep link (`/?topic=<id>`) is the only
 * thing that tells the preview manager WHICH page is worth a photo: without it
 * the manager is left with the bare `/`, the app with no topic open, and the
 * empty-shell gate retires every shot of that card (measured on three cards,
 * 27/11). So the order of the seeding steps is a contract, not a detail, and a
 * contract needs a test that does not boot a server.
 *
 * THE REPRODUCED CAUSE (card 79ab687d). The old seed also registered a project
 * (`POST /api/projects`, fixed name and path) before creating the topic.
 * `preview-worktree.ts` never clears its `/tmp/topics-preview-<port>` root
 * between runs on the same port, so a second run reused the first run's
 * `topics.db` and hit the project's slug a second time: the insert answers a
 * slug-conflict 409 (reproduced directly against `project-store.ts`, see
 * `project-store.slug-conflict.test.ts`), the seed threw before the topic
 * existed, and the deep link was never written. Removing the project (the
 * topic is standalone, see `cf1d1656ea`) also removed the only call that could
 * conflict across runs.
 *
 * THE ORDER, KEPT AS DEFENSE IN DEPTH. The page is still announced AS SOON AS
 * the topic exists, before the example messages, so a failure in the optional
 * content can never cost the announcement. The messages are best effort: they
 * make the shot nicer, they do not decide whether there is a shot.
 *
 * Kanban spec: KANBAN-126.
 */

export interface PreviewSeedIo {
  /** Calls the preview server through its own http api. Throws when the answer is not ok. */
  api(method: string, path: string, body?: unknown): Promise<unknown>;
  /** Publishes the page the manager should photograph, as an app path. */
  announce(deepLink: string): void;
  log?(line: string): void;
}

/** Invented content: nothing real ever goes into a preview. */
const EXAMPLE_MESSAGES = [
  "Here is a **short summary** of the example topic.\n\n- First point\n- Second point",
  "A follow-up with `inline code` and a link: [example](https://example.com).",
];

function topicIdOf(answer: unknown): string | null {
  const body = answer as { topic?: { id?: unknown }; id?: unknown } | null;
  const id = body?.topic?.id ?? body?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Creates the example topic, announces its page, then fills it. Returns the
 * topic id. Throws only when there is nothing to photograph at all.
 */
export async function seedPreviewData(io: PreviewSeedIo): Promise<string> {
  const log = io.log ?? ((line: string) => console.log(line));
  await io.api("PUT", "/api/app-settings", { firstRunDoneAt: new Date().toISOString() });

  // The topic is STANDALONE (no `projectPath`): the deep link opens it in a
  // detached window, and there a project-bound topic is never promoted to its
  // project pane, so it would be shown as a loose chat anyway.
  const created = await io.api("POST", "/api/topics", { name: "Example topic", type: "chat" });
  const id = topicIdOf(created);
  if (!id) throw new Error("topic id missing in the answer");

  // ANNOUNCED HERE, not at the end: from this line on there is a real page to
  // photograph, whatever happens to the example messages below.
  io.announce(`/?topic=${id}`);
  log(`▸ example topic ready, page announced (topic ${id})`);

  for (const content of EXAMPLE_MESSAGES) {
    try {
      await io.api("POST", `/api/topics/${id}/system-message`, { content });
    } catch (err) {
      log(`▸ example message skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return id;
}
