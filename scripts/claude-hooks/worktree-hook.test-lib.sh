# Shared by worktree-hook.test.sh and topics-worktree.test.sh (sourced, not run).
# A sandbox: temporary TOPICS_HOME, isolated git config, a repo with one commit,
# and a fake Topics server (bun, plain HTTP) that logs every request it gets.
# The caller sets `tmp` (a mktemp -d folder) before sourcing.

export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$tmp/gitconfig"
printf '[user]\n\tname = Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n' > "$GIT_CONFIG_GLOBAL"
unset TOPICS_WORKTREES_DIR TOPICS_WORKTREE_CREATOR TOPICS_WORKTREE_REGISTER
export TOPICS_HOME="$tmp/home"
# A closed port: "Topics is down" unless a test starts the fake server.
export TOPICS_APP_URL="http://127.0.0.1:9"
mkdir -p "$TOPICS_HOME/claude-hooks"
printf 'abcdef0123456789abcdef0123456789' > "$TOPICS_HOME/claude-hooks/hook-token"
fail=0
ok() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got [$2] want [$3]"; fail=1; fi; }
# A path as the hook prints and sends it: native on Git for Windows (`cygpath -m`,
# `C:/Users/...`), unchanged elsewhere. Expected values go through it; `tmp`
# itself stays in the shell's spelling, or a `PATH="$tmp/...:$PATH"` shim would
# break on the colon of `C:`.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

# A repository with one commit, at $1 (physical path printed).
make_repo() {
  mkdir -p "$1" && git -C "$1" init -q && echo one > "$1/a.txt" && git -C "$1" add a.txt && git -C "$1" commit -qm one
  (cd "$1" && pwd -P)
}

# The fake server. Placement answers root=$FAKE_ROOT slug=demo projectId=p1 (and
# repo=$FAKE_REPO for ?project=demo); register and unregister answer 200. Every
# request with the right token is one line of $tmp/requests.log.
start_fake() {
  cat > "$tmp/fake.ts" <<'EOS'
import { appendFileSync, writeFileSync } from "node:fs";
const log = process.env.FAKE_LOG!;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    if (req.headers.get("authorization") !== "Bearer abcdef0123456789abcdef0123456789") return new Response("no", { status: 401 });
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.text() : "";
    appendFileSync(log, `${req.method} ${url.pathname}${url.search} ${body}\n`);
    if (url.pathname === "/api/worktrees/placement") {
      const project = url.searchParams.get("project");
      if (project && project !== "demo") return Response.json({ error: "unknown" }, { status: 404 });
      return Response.json({ root: process.env.FAKE_ROOT, slug: "demo", projectId: "p1", ...(project ? { repo: process.env.FAKE_REPO } : {}) });
    }
    if (url.pathname === "/api/worktrees/register") return Response.json({ id: "w1", class: "tracked", inRoot: true, created: true });
    if (url.pathname === "/api/worktrees/unregister") return Response.json({ removed: true, id: "w1" });
    return new Response("not found", { status: 404 });
  },
});
writeFileSync(process.env.FAKE_PORT_FILE!, String(server.port));
EOS
  : > "$tmp/requests.log"
  FAKE_LOG="$tmp/requests.log" FAKE_PORT_FILE="$tmp/port" bun "$tmp/fake.ts" >/dev/null 2>&1 &
  fake_pid=$!
  i=0; while [ ! -s "$tmp/port" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
  export TOPICS_APP_URL="http://127.0.0.1:$(cat "$tmp/port")"
}

stop_fake() {
  [ -n "${fake_pid:-}" ] && kill "$fake_pid" 2>/dev/null
  wait "${fake_pid:-}" 2>/dev/null
  fake_pid=""
  : > "$tmp/port"
  export TOPICS_APP_URL="http://127.0.0.1:9"
}
