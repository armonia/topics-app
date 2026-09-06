/**
 * A PAIRED APP WITH PEOPLE IN IT, stubbed at the routes it really reads.
 *
 * Three specs need the same thing before they can look at the foot of the
 * column: a session that says `paired` (the band is drawn behind that flag and
 * nothing else), an address book, a friendship graph with somebody here and
 * somebody away, and a couple of organisations. Written once, here, because
 * the shapes are the REAL ones of the routes rather than something already
 * chewed, and three hand-made copies of a server shape are three servers that
 * disagree the day a field moves.
 */
import { expect, type Page } from "@playwright/test";

/** A member as the route sends it: raw milliseconds, not a boolean. */
export function member(id: string, name: string, lastSeenAt: number | null) {
  return { id, name, email: `${id}@example.test`, role: "member", lastSeenAt };
}

export interface Population {
  /** What `/api/auth/orgs` answers. */
  orgs: Array<{ id: string; name: string }>;
  /** What every organisation answers for its members. */
  members: ReturnType<typeof member>[];
  /** The address book: this is where the client learns who YOU are. */
  people: Array<{ id: string; displayName: string; isMe: boolean }>;
  /** Your FRIENDS, which is what the chips draw: the friendship graph, not
   *  the organisation address book. `lastSeenAt` is what puts a person on the
   *  row, and takes them off it. */
  friends: Array<{ id: string; displayName: string; lastSeenAt: number | null }>;
}

/**
 * The minimum identity data needed for the band to be drawn at all.
 *
 * Shared in shape with `org-presence.spec.ts`, and the shapes are the REAL ones
 * of the routes rather than something already chewed. `/api/auth/session` has
 * to say `paired`: the whole band sits behind `session.status !== 'paired'`, so
 * an invented stub leaves it unmounted and the red blames the layout instead of
 * the fake server.
 *
 * Calling it twice on the same page is deliberate and supported: a later
 * `page.route` for the same pattern takes precedence, which is how one test
 * moves from the populated state to the empty one without a second context.
 */
export async function stubIdentity(page: Page, population: Population): Promise<void> {
  await page.route("**/api/auth/session", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ paired: true, as: "loopback", name: "Questo computer",
                             role: "owner", personId: "io" }) }));
  await page.route("**/api/auth/devices", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ devices: [{ connected: true, revokedAt: null }] }) }));
  await page.route("**/api/auth/orgs", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ orgs: population.orgs.map((o, i) => ({ ...o, installation: i === 0 })) }) }));
  await page.route("**/api/auth/orgs/*/members", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ members: population.members }) }));
  // The WHOLE shape of a person, `stats` and the follow fields included: a half
  // stub is not a smaller stub, it is a different server.
  const person = (p: { id: string; displayName: string; isMe: boolean }) => ({
    email: null,
    githubLogin: null,
    github: null,
    stats: { prompts: 0, inputTokens: 0, outputTokens: 0, costCents: 0, ultimoPrompt: null },
    counts: { followers: 0, following: 0 },
    viewerFollows: false,
    followsViewer: false,
    lastSeenAt: null,
    ...p,
  });
  await page.route("**/api/people", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ people: population.people.map(person) }) }));
  await page.route("**/api/people/*/follow*", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ people: [] }) }));
  // A chip is a door to ONE person, and that person's page asks for them by
  // id. Unrouted it would reach the real server, which knows none of these
  // ids, and the pane would open on an error screen while the test believed
  // it was looking at a person.
  await page.route(/\/api\/people\/[^/?]+$/, (r) => {
    const id = new URL(r.request().url()).pathname.split("/").pop() ?? "";
    const p = population.people.find((x) => x.id === id);
    return p
      ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(person(p)) })
      : r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
  });
  // The friendship graph: three lists from one read, the shape `friendsApi`
  // expects. Unrouted it would reach the real server, which knows none of
  // these ids, and the row would be measured empty while the test believed it
  // was measuring three people.
  await page.route("**/api/friendships", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({
        friends: population.friends.map((p) => ({
          email: null,
          githubLogin: null,
          github: null,
          stats: null,
          isMe: false,
          counts: null,
          viewerFollows: false,
          followsViewer: false,
          since: 0,
          ...p,
        })),
        incoming: [],
        outgoing: [],
      }) }));
  // THE WORST CASE FOR THE MENU HEADER, not a quiet machine. Three signals is
  // the cap `workSignals` enforces; they ride on the menu's title now, not on
  // the card, and the card has to stay the same width either way.
  await page.route("**/api/system/presence", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ openSessions: 12, workingSessions: 3, activeTasks: 2, focusProject: null }) }));
}

/**
 * THE MACHINE'S NUMBERS, so the card has something to say. The shell command
 * the dot samples is `perf_metrics`, and without a shell (plain Chromium) the
 * card would show no memory and no CPU: a green on an empty span would prove
 * the layout of nothing.
 */
export async function withMachineNumbers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" } },
      invoke: async (cmd: string) => {
        if (cmd !== "perf_metrics") throw new Error(`unmocked command: ${cmd}`);
        return {
          version: "e2e", total_mb: 1989, resident_mb: 594,
          renderer_mb: 1400, gpu_mb: 130, other_mb: 459,
          cpu_percent: 8, cpu_renderer: 4, cpu_gpu: 1,
          cpu_sampled: 3, cpu_pids: 3, process_count: 8, partial: false,
        };
      },
    };
  });
}

/** The address book every population shares. The display names are
 *  placeholders on purpose and stay ones: the repository is public, and a
 *  plausible first-name-plus-surname in a tracked file is what
 *  `tests/unit/no-personal-data-tracked.test.ts` exists to refuse. */
export const PEOPLE = [
  { id: "io", displayName: "Utente Locale", isMe: true },
  { id: "a", displayName: "Anna Prova", isMe: false },
  { id: "b", displayName: "Bruno Prova", isMe: false },
  { id: "c", displayName: "Carla Prova", isMe: false },
];

/** Two friends here now and one who is not: the ordinary morning. */
export function populated(orgCount = 1): Population {
  const now = Date.now();
  return {
    orgs: Array.from({ length: orgCount }, (_, i) => ({ id: `org${i + 1}`, name: `Gruppo ${i + 1}` })),
    members: [
      member("io", "Io", now),               // you do not count yourself
      member("a", "Anna", now - 30_000),
      member("b", "Bruno", now - 60_000),
      member("c", "Carla", now - 3_600_000), // an hour ago: past the threshold
    ],
    people: PEOPLE,
    friends: [
      { id: "a", displayName: "Anna Prova", lastSeenAt: now - 30_000 },
      { id: "b", displayName: "Bruno Prova", lastSeenAt: now - 60_000 },
      { id: "c", displayName: "Carla Prova", lastSeenAt: now - 3_600_000 },
    ],
  };
}

/** Three friends here at once: more chips than a 180px row can show. */
export function crowd(): Population {
  const now = Date.now();
  return {
    ...populated(),
    friends: [
      { id: "a", displayName: "Anna Prova", lastSeenAt: now - 30_000 },
      { id: "b", displayName: "Bruno Prova", lastSeenAt: now - 60_000 },
      { id: "c", displayName: "Carla Prova", lastSeenAt: now - 90_000 },
    ],
  };
}

/** Friends, none of whom is here: the row must not be drawn, the menu must
 *  still list them. */
export function friendsAway(): Population {
  const now = Date.now();
  return {
    ...populated(),
    friends: [
      { id: "a", displayName: "Anna Prova", lastSeenAt: now - 3_600_000 },
      { id: "b", displayName: "Bruno Prova", lastSeenAt: null },
    ],
  };
}

/** In no group and knowing nobody: the card alone. */
export function alone(): Population {
  return {
    orgs: [],
    members: [],
    people: [PEOPLE[0]!],
    friends: [],
  };
}

/**
 * Put the column at `width` and come back with what it actually measures.
 *
 * The width lives in `app-settings` under `sidebarWidth`, one of the three
 * DEVICE-LOCAL keys the server strips out of the settings it hydrates
 * (`DEVICE_LOCAL_SETTING_KEYS`): localStorage is therefore the only authority,
 * so writing it and reloading is not a race with the network. Written and
 * reloaded rather than pushed through `addInitScript` because init scripts
 * accumulate on a page, and three of them disagreeing about one number is a
 * worse way to be wrong than one reload.
 */
export async function setSidebarWidth(page: Page, width: number): Promise<number> {
  await page.evaluate((w) => {
    const raw = localStorage.getItem("app-settings");
    const base: Record<string, unknown> = raw ? JSON.parse(raw) : {};
    // `sidebarWidthExpanded` too: it is the width a reopen restores to, and
    // leaving it behind lets a collapse round trip undo the seed.
    localStorage.setItem("app-settings", JSON.stringify({
      ...base, sidebarWidth: w, sidebarWidthExpanded: w, sidebarCollapsed: false,
    }));
  }, width);
  await page.reload();
  const column = page.locator('[aria-label="Topics sidebar"]');
  await expect(column).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("identity-me-profile")).toBeVisible({ timeout: 20000 });
  const box = await column.boundingBox();
  return Math.round(box?.width ?? 0);
}

/** Open the one door of the chrome and hand back the menu. */
export async function openMenu(page: Page) {
  await page.getByTestId("identity-me-profile").click();
  const menu = page.getByTestId("profile-menu");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  return menu;
}
