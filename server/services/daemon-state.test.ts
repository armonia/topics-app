import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { worktreeIsolationEnv, worktreeIsolationHome } from "./daemon-state";

describe("worktreeIsolationHome", () => {
  const HOME = "/Users/x";
  const wt = (name: string) => join(HOME, ".topics", "worktrees", "topics-app", name);

  it("isolates a dispatch-worktree checkout onto its own .topics-daemon home", () => {
    const base = wt("ancient-needle");
    expect(worktreeIsolationHome(base, HOME)).toBe(join(base, ".topics-daemon"));
  });

  it("keeps production defaults (null) for a normal checkout", () => {
    expect(worktreeIsolationHome("/Users/x/Projects/topics-app", HOME)).toBeNull();
  });

  it("keeps production defaults for the packaged app bundle path", () => {
    expect(
      worktreeIsolationHome("/Users/x/Applications/Topics Host.app/Contents/Resources/server", HOME),
    ).toBeNull();
  });

  it("does not false-match a project literally named 'worktrees' outside ~/.topics", () => {
    expect(worktreeIsolationHome("/Users/x/Projects/worktrees/app", HOME)).toBeNull();
  });

  it("does not match ~/.topics itself (only nested worktree checkouts)", () => {
    expect(worktreeIsolationHome(join(HOME, ".topics"), HOME)).toBeNull();
  });

  it("handles a trailing separator on baseDir", () => {
    const base = wt("serene-bulb");
    expect(worktreeIsolationHome(base + "/", HOME)).toBe(join(base + "/", ".topics-daemon"));
  });
});

describe("worktreeIsolationEnv", () => {
  const ISO = "/Users/x/.topics/worktrees/repo/ramo/.topics-daemon";

  it("sposta casa, porta principale E porta del tunnel", () => {
    // LA TERZA E' QUELLA CHE MANCAVA. Il 18/08 un `bun run start` partito da un
    // worktree si isolava sulla porta principale e si prendeva lo stesso la
    // 3334: la produzione e' rimasta giu' in crash-loop con
    // «Failed to start server. Is port 3334 in use?» finche' qualcuno non se
    // n'e' accorto a mano.
    expect(worktreeIsolationEnv({ TOPICS_TUNNEL_PORT: "3334" }, ISO)).toEqual({
      TOPICS_HOME: ISO,
      PORT: "0",
      TOPICS_TUNNEL_PORT: null,
    });
  });

  it("cio' che e' gia' scelto non si tocca", () => {
    // Chi ha dichiarato una porta o una casa sa quel che fa: l'isolamento e' un
    // default, non un sequestro.
    expect(worktreeIsolationEnv({ TOPICS_HOME: "/gia/scelta", PORT: "4100" }, ISO)).toEqual({});
    expect(worktreeIsolationEnv({ BUN_PORT: "4100" }, ISO)).toEqual({ TOPICS_HOME: ISO });
  });

  it("senza tunnel configurato non si inventa niente da togliere", () => {
    expect(worktreeIsolationEnv({}, ISO)).toEqual({ TOPICS_HOME: ISO, PORT: "0" });
  });
});
