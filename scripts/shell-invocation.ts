/**
 * Picks the shell that runs a wrapped gate command.
 *
 * `/bin/sh` does not exist on Windows, so a wrapper that hard-codes it never
 * starts a single command there. `cmd.exe /d /s /c` is the Windows
 * equivalent of `/bin/sh -c`: `/d` skips AutoRun registry commands, for the
 * same "bare environment" reason POSIX uses `-c` and not a login `-lc`.
 *
 * The command is wrapped in its own pair of double quotes on `win32`: a
 * wrapped gate like `typecheck` is itself `'bun run parallel.ts "bun run a" "bun run b"'`,
 * nested quotes that `cmd.exe /c` only parses correctly when the whole thing
 * after `/c` is one quoted token. The caller must also pass
 * `windowsVerbatimArguments: true` to `spawn`, or Node re-escapes this
 * already-quoted string and breaks it again.
 */
export function shellInvocation(cmd: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === "win32") return { command: "cmd.exe", args: ["/d", "/s", "/c", `"${cmd}"`] };
  return { command: "/bin/sh", args: ["-c", cmd] };
}
