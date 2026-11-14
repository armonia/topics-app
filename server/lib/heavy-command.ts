/**
 * THE ONE RECOGNISER OF HEAVY SHELL COMMANDS.
 *
 * Mirrors the pattern the external-harness hook uses (suites, builds, type
 * checks, lint, ffmpeg), so a command is "heavy" the same way whoever launches
 * it. Topics sessions put a heavy command in the machine-wide line
 * (`services/heavy-slot-default.ts`) before it starts; a light one (`ls`,
 * `git status`) never touches the line.
 */

const END = String.raw`([\s;&|)\`]|$)`;
const PKG = String.raw`(pnpm|npm|yarn|bun)\s+(run\s+)?`;

const HEAVY: RegExp[] = [
  /playwright\s+test/,
  new RegExp(String.raw`(^|[^\w-])(vitest|jest)${END}`),
  /cypress\s+run/,
  new RegExp(`${PKG}(test|e2e|build|typecheck|type-check|lint|knip|check:deadcode)([:\\s;&|)\`]|$)`),
  /(^|[\s;&|(])spec-flow\s/,
  /pytest/,
  /cargo\s+(test|build|check|clippy)/,
  /go\s+test/,
  new RegExp(String.raw`(^|[^\w-])(astro|vite|next|nuxt)\s+build${END}`),
  new RegExp(String.raw`(^|[^\w.-])(tsc|tsgo|eslint|knip|ffmpeg)${END}`),
  /(^|[\s;&|(])bun\s+test(\s|$)/,
];

/** A language server is not a check: `tsc --lsp` stays light. */
export function isHeavyCommand(command: string): boolean {
  const text = command.replace(/(tsgo|tsc)\s+--lsp/g, "");
  return HEAVY.some((re) => re.test(text));
}

/** A short line for the queue: the command's first 80 characters. */
export function heavyLabel(command: string): string {
  return command.replace(/\s+/g, " ").trim().slice(0, 80);
}
