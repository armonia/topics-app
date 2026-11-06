/* Claude Code TUI transcripts for the acme scenario (ANSI). \x1b = ESC; xterm
 * needs CRLF, which the socket stub adds at emit time. Generic acme work, no
 * real project or user data.
 *
 * The mascot is the REAL Claude Code logo (v2.1.x): three rows of block-art in
 * brand orange (#D97757 foreground), the exact glyphs the CLI paints: full block
 * U+2588, right/left half U+2590/U+258C, quadrant blocks U+259B-U+259D. They are
 * SUB-CELL glyphs drawn by xterm's DOM renderer, the same one the app uses (the
 * canvas addon crashes on xterm v6 when a terminal remounts, which is exactly
 * what switching group does). Each row is padded to 9 cells so the trailing
 * text aligns across all three lines. */

const CC_FG = "\x1b[38;2;217;119;87m", CC_RST = "\x1b[0m";
const M1 = CC_FG + " ▐▛███▜▌ " + CC_RST;
const M2 = CC_FG + "▝▜█████▛▘" + CC_RST;
const M3 = CC_FG + "  ▘▘ ▝▝  " + CC_RST;

/** The three header rows every session opens with: logo, model, project. */
function header(model: string, where: string): string[] {
  return [
    M1 + "   \x1b[1mClaude Code\x1b[0m \x1b[2mv2.1.172\x1b[0m\n",
    M2 + "   \x1b[2m" + model + "\x1b[0m\n",
    M3 + "   \x1b[2m" + where + "\x1b[0m\n",
    "\n",
  ];
}

const CLAUDE_CC1 = [
  ...header("Fable 5 (1M context)", "acme-web · main"),
  "\x1b[1;36m❯\x1b[0m Wire up release signing for v1.1 and run the smoke test\n",
  "\n",
  "\x1b[38;2;217;119;87m⏺\x1b[0m I'll add the signing step to the release script, then verify.\n",
  "\n",
  "\x1b[38;2;217;119;87m⏺\x1b[0m \x1b[1mRead\x1b[0m(scripts/release.ts)\n",
  "\x1b[2m  ⎿  read 84 lines\x1b[0m\n",
  "\n",
  "\x1b[38;2;217;119;87m⏺\x1b[0m \x1b[1mEdit\x1b[0m(scripts/release.ts)\n",
  "\x1b[2m  ⎿  \x1b[0m\x1b[32m+12\x1b[0m \x1b[31m−2\x1b[0m \x1b[2m· codesign + notarize step\x1b[0m\n",
  "\n",
  "\x1b[38;2;217;119;87m⏺\x1b[0m \x1b[1mBash\x1b[0m(npm run build && npm run release:sign)\n",
  "\x1b[2m  ⎿  \x1b[0m\x1b[32m✓\x1b[0m built in 2.3s \x1b[2m· signed acme-web-1.1.0.dmg\x1b[0m\n",
  "\n",
  "\x1b[38;2;217;119;87m⏺\x1b[0m Signing works end-to-end. Running the release smoke test now…\n",
  "\n",
  "\x1b[2m──────────────────────────────────────────────\x1b[0m\n",
  "\x1b[36m✻\x1b[0m \x1b[2mWorking…  (esc to interrupt · ⏵⏵ bypass permissions on)\x1b[0m\n",
];
const CLAUDE_CC2 = [
  ...header("Fable 5 (1M context)", "acme-web · main"),
  "\x1b[1;36m❯\x1b[0m Add empty states to the dashboard lists\n",
  "\n",
  "\x1b[38;2;217;119;87m⏺\x1b[0m Scanning the dashboard route for lists missing an empty state.\n",
  "\n",
  "\x1b[38;2;217;119;87m⏺\x1b[0m \x1b[1mGrep\x1b[0m(\"\\.map(\" in src/routes/dashboard.tsx)\n",
  "\x1b[2m  ⎿  3 matches\x1b[0m\n",
  "\n",
  "\x1b[38;2;217;119;87m⏺\x1b[0m Adding <EmptyState/> to the channels, sessions and errors lists.\n",
  "\x1b[2m   esc to interrupt\x1b[0m\n",
];
const CLAUDE_CC3 = [
  ...header("Fable 5 (1M context)", "acme-api · main"),
  "\x1b[1;36m❯\x1b[0m Add a token-bucket rate limiter to the public API\n",
  "\n",
  "\x1b[38;2;217;119;87m⏺\x1b[0m Adding middleware and wiring it into the router.\n",
  "\n",
  "\x1b[38;2;217;119;87m⏺\x1b[0m \x1b[1mWrite\x1b[0m(src/middleware/rateLimit.ts)\n",
  "\x1b[2m  ⎿  38 lines\x1b[0m\n",
  "\n",
  "\x1b[38;2;217;119;87m⏺\x1b[0m \x1b[1mBash\x1b[0m(bun test rate-limit)\n",
  "\x1b[2m  ⎿  \x1b[0m\x1b[32m✓\x1b[0m 12 passed \x1b[2m(248ms)\x1b[0m\n",
  "\n",
  "\x1b[38;2;217;119;87m⏺\x1b[0m Limiter live: 100 req/min per key. Verifying the 429 headers…\n",
  "\x1b[2m   esc to interrupt\x1b[0m\n",
];
/** A COMPLETED turn: the agent finished, the prompt is idle again (no "Working…"). */
const CLAUDE_CC4 = [
  ...header("Fable 5 (1M context)", "acme-mobile · main"),
  "\x1b[1;36m❯\x1b[0m Fix the offline-sync race in the upload queue\n",
  "\n",
  "\x1b[38;2;217;119;87m⏺\x1b[0m Reproduced it — the flush wasn't awaiting the write lock.\n", // allow-emdash: shipped landing copy, kept identical
  "\n",
  "\x1b[38;2;217;119;87m⏺\x1b[0m \x1b[1mEdit\x1b[0m(src/sync/queue.ts)\n",
  "\x1b[2m  ⎿  \x1b[0m\x1b[32m+6\x1b[0m \x1b[31m−3\x1b[0m\n",
  "\n",
  "\x1b[38;2;217;119;87m⏺\x1b[0m \x1b[1mBash\x1b[0m(bun test sync)\n",
  "\x1b[2m  ⎿  \x1b[0m\x1b[32m✓\x1b[0m 28 passed \x1b[2m(1.1s)\x1b[0m\n",
  "\n",
  "\x1b[32m⏺\x1b[0m \x1b[1mDone\x1b[0m — offline sync is race-free and the full suite is green.\n", // allow-emdash: shipped landing copy, kept identical
  "\n",
  "\x1b[1;36m❯\x1b[0m \x1b[7m \x1b[0m\n",
];
/* acme-docs' session: a different KIND of work on purpose. The group holds
 * three projects and three agents, and three identical transcripts would read
 * as one screenshot pasted three times. */
const CLAUDE_CC6 = [
  ...header("Sonnet 5", "acme-docs · main"),
  "\x1b[1;36m❯\x1b[0m Document the new webhook payload, with an example\n",
  "\n",
  "\x1b[38;2;217;119;87m⏺\x1b[0m \x1b[1mRead\x1b[0m(server/routes/webhooks.ts)\n",
  "\x1b[2m  ⎿  \x1b[0m162 lines\n",
  "\n",
  "\x1b[38;2;217;119;87m⏺\x1b[0m \x1b[1mWrite\x1b[0m(docs/webhooks.md)\n",
  "\x1b[2m  ⎿  \x1b[0m\x1b[32m+48\x1b[0m \x1b[31m−0\x1b[0m\n",
  "\n",
  "\x1b[38;2;217;119;87m⏺\x1b[0m Added the signature header and a curl example that verifies it.\n",
  "\n",
  "\x1b[1;36m❯\x1b[0m \x1b[7m \x1b[0m\n",
];
const SHELL_LINES = [
  "\x1b[2m~/code/acme-web\x1b[0m \x1b[32m✔\x1b[0m\n",
  "\x1b[1;36m❯\x1b[0m git status -sb\n",
  "## \x1b[32mmain\x1b[0m\n",
  " \x1b[31mM\x1b[0m src/components/Hero.tsx\n",
  " \x1b[31mM\x1b[0m src/lib/analytics.ts\n",
  "\x1b[1;36m❯\x1b[0m npm run dev\n",
  "\x1b[2m> acme-web@1.1.0 dev\x1b[0m\n",
  "\x1b[32m➜\x1b[0m Local:   http://localhost:5173/\n",
  "\x1b[1;36m❯\x1b[0m █\n",
];

/** cc1/cc2 are acme-web's agent sessions, sh1 its plain shell; any other id replays cc1. */
export const ACME_TRANSCRIPTS = { cc2: CLAUDE_CC2, cc3: CLAUDE_CC3, cc4: CLAUDE_CC4, cc6: CLAUDE_CC6, sh1: SHELL_LINES };
export const ACME_FALLBACK_TRANSCRIPT = CLAUDE_CC1;

/** The vite dev server's log, for the Processes section's `dev` script. */
export const ACME_PROC_OUT =
  "\x1b[2m$ vite dev\x1b[0m\n\n  \x1b[32m\x1b[1mVITE\x1b[0m \x1b[2mv6.0.1\x1b[0m  ready in \x1b[1m287\x1b[0m ms\n\n" +
  "  \x1b[32m➜\x1b[0m  \x1b[1mLocal\x1b[0m:   http://localhost:5173/\n" +
  "  \x1b[32m➜\x1b[0m  \x1b[1mNetwork\x1b[0m: http://192.168.1.24:5173/\n\n" +
  "\x1b[2m9:30:14 AM\x1b[0m \x1b[36m[vite]\x1b[0m hmr update /src/components/Hero.tsx\n" +
  "\x1b[2m9:30:21 AM\x1b[0m \x1b[36m[vite]\x1b[0m page reload src/routes/dashboard.tsx\n" +
  "\x1b[2m9:30:32 AM\x1b[0m \x1b[32m✓\x1b[0m built client in 1.2s\n";
