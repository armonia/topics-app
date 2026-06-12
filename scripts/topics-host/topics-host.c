/*
 * topics-host — minimal signed Mach-O launcher for the Topics production
 * server LaunchAgent (com.armonia.topics-server).
 *
 * WHY THIS EXISTS (macOS TCC / computer-use):
 *   The bun server spawns the Claude sessions whose Bash tool runs "computer
 *   use" shell commands (screencapture / cliclick / osascript). macOS TCC does
 *   not authorize the process that calls those tools directly — it walks up to
 *   the "responsible process" and validates ITS code signature. A process
 *   launched by launchd via "/bin/bash <script>" has no stable, code-signed
 *   responsible app, so a Screen-Recording / Accessibility grant can never be
 *   anchored to it (and the chain otherwise resolves to NULL → silent deny).
 *
 *   This launcher is a tiny, code-SIGNED Mach-O with a stable bundle id
 *   (io.armonia.topics.host). When the LaunchAgent launches THIS (and the
 *   plist carries AssociatedBundleIdentifiers = io.armonia.topics.host), TCC
 *   attributes the whole job tree — bun → claude → zsh → screencapture — to
 *   this signed bundle. The user grants Screen Recording + Accessibility to
 *   "Topics Host" once, and the grant is stable across repo edits / hot-reload
 *   because only this ~30-line wrapper is signed/frozen.
 *
 * BEHAVIOUR:
 *   posix_spawn (NOT exec-replace) "/bin/bash START_SCRIPT" as a child and
 *   wait on it, so this signed process stays alive as the responsible-code
 *   anchor for the entire descendant tree for the lifetime of the server.
 *   START_SCRIPT is baked at build time (-DSTART_SCRIPT=...) by
 *   scripts/build-topics-host.sh. The job's EnvironmentVariables (PATH, HOME,
 *   PORT) are set by launchd and inherited here, so nothing else is needed.
 */
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
#include <signal.h>

extern char **environ;

#ifndef START_SCRIPT
#error "START_SCRIPT must be defined at compile time (absolute path to start-prod.sh)"
#endif

static pid_t child_pid = 0;

/* Forward SIGTERM/SIGINT (launchd stop) to the whole child process group so
 * the bun server + its children shut down cleanly instead of being orphaned. */
static void forward_signal(int sig) {
  if (child_pid > 0) {
    kill(-child_pid, sig);
    kill(child_pid, sig);
  }
}

int main(void) {
  signal(SIGTERM, forward_signal);
  signal(SIGINT, forward_signal);

  char *const argv[] = { "/bin/bash", (char *)START_SCRIPT, (char *)0 };

  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);
  /* New process group so we can signal the whole tree on stop. */
  posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETPGROUP);
  posix_spawnattr_setpgroup(&attr, 0);

  int rc = posix_spawn(&child_pid, "/bin/bash", NULL, &attr, argv, environ);
  posix_spawnattr_destroy(&attr);
  if (rc != 0) {
    return 127; /* failed to launch the server script */
  }

  int status = 0;
  pid_t w;
  do {
    w = waitpid(child_pid, &status, 0);
  } while (w < 0); /* retry on EINTR */

  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return 1;
}
