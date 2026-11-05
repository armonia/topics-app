/**
 * THE SCENE OF THE APPROVED MOCKUPS, for the specs that shoot `vero-*.png`.
 *
 * The mockups of hub-smistamento are drawn on one workspace: projects with
 * their chats open in the sidebar (acme-web, studio-x, ...), a chat with a
 * few messages in the main area. A screenshot of the built surface is set
 * beside its mockup, so it has to be taken in that same workspace, not on the
 * bench's empty one («No chats open», a lone baseline chat).
 *
 * `seedScene` makes the folders and the chats, writes a few messages into the
 * first chat, and opens every project's pane with its chats as inner tabs, so
 * each project row is expanded on its chats. The names are placeholders.
 */
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createTopic, deleteTopic, seedProjectInnerChats, seedProjectPane, waitForPaneStoreQuiet } from "./api-fixtures";
import { removeTmpDir } from "./file-project";
import { E2E_BASE } from "./test-server";

export interface SceneProject {
  name: string;
  chats: string[];
}

/** The projects and chats of the mockups' sidebar. */
export const MOCK_PROJECTS: SceneProject[] = [
  { name: "acme-web", chats: ["Firma della release v1.1", "Revisione checkout"] },
  { name: "studio-x", chats: ["Triage dei bug di ottobre", "Piano del rilascio"] },
];

/** The exchange the mockups show in the open chat. */
const MOCK_MESSAGES = [
  "Prepara la firma della release v1.1 e lancia lo smoke test.",
  "Aggiungo il passo di firma allo script di release, poi verifico.\n\n- Modificato `scripts/release.ts` · +12 −2\n- `npm run release:sign` · firmato acme-web-1.1.0.dmg",
  "La firma funziona da capo a fondo. Lancio lo smoke test.",
];

export interface Scene {
  root: string;
  dirOf: (name: string) => string;
  /** Chat ids per project name, in the order given. */
  chats: Record<string, string[]>;
  /** The chat that carries the messages: the first chat of the first project. */
  mainChat: { id: string; name: string };
  /** Takes the caller's own `request`: a fixture of `beforeAll` cannot be reused in `afterAll`. */
  cleanup: (request: APIRequestContext) => Promise<void>;
}

/**
 * Seed the projects under `root`, their chats, and their panes. Call it with
 * the page closed or before `goToApp`: the pane store is written on the server.
 * With `open: false` only the folders and the chats are made (a spec that
 * resets the pane store itself calls `openSceneInSidebar` after).
 */
export async function seedScene(
  request: APIRequestContext,
  root: string,
  projects: SceneProject[] = MOCK_PROJECTS,
  opts: { open?: boolean } = {},
): Promise<Scene> {
  const chats: Record<string, string[]> = {};
  const dirOf = (name: string) => `${root}/${name}`;
  for (const p of projects) {
    mkdirSync(dirOf(p.name), { recursive: true });
    chats[p.name] = [];
    for (const name of p.chats) chats[p.name].push((await createTopic(request, name, { projectPath: dirOf(p.name) })).id);
  }
  const first = projects[0];
  const mainChat = { id: chats[first.name][0], name: first.chats[0] };
  for (const content of MOCK_MESSAGES) {
    await request.post(`${E2E_BASE}/api/topics/${mainChat.id}/system-message`, { data: { content } });
  }
  const scene: Scene = {
    root,
    dirOf,
    chats,
    mainChat,
    cleanup: async (request) => {
      for (const ids of Object.values(chats)) for (const id of ids) await deleteTopic(request, id).catch(() => {});
      removeTmpDir(root);
    },
  };
  if (opts.open !== false) await openSceneInSidebar(request, scene);
  return scene;
}

/** Every project's pane open, with its chats as inner tabs: the rows come up expanded on their chats. */
export async function openSceneInSidebar(request: APIRequestContext, scene: Scene): Promise<void> {
  for (const [name, ids] of Object.entries(scene.chats)) {
    await seedProjectPane(request, scene.dirOf(name));
    await seedProjectInnerChats(request, scene.dirOf(name), ids);
  }
  await waitForPaneStoreQuiet(request);
}

/** Open the scene's main chat from its sidebar row, and wait for its messages. */
export async function openMainChat(page: Page, scene: Scene): Promise<void> {
  const row = page.getByRole("treeitem", { name: new RegExp(scene.mainChat.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  // In the transcript, not the row's preview, which carries the same words.
  await expect(page.locator('[role="main"]').getByText("La firma funziona da capo a fondo").first()).toBeVisible({ timeout: 20_000 });
}
