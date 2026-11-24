#!/usr/bin/env sh
# Bar of scripts/topics-worktree (add, register, list). Exit 0 = every case holds.
# A temporary repo and TOPICS_HOME, a fake Topics server for the cases that need one.
# @covers WORKTREE-STD-14
set -u
here="$(cd "$(dirname "$0")" && pwd)"
tw="$here/topics-worktree"
tmp="$(mktemp -d)"; tmp="$(cd "$tmp" && pwd -P)"
trap 'stop_fake; rm -rf "$tmp"' EXIT
. "$here/claude-hooks/worktree-hook.test-lib.sh"

repo="$(make_repo "$tmp/demo")"
root="$TOPICS_HOME/worktrees"
marker_of() { jq -r ".$2" "$(git -C "$1" rev-parse --path-format=absolute --git-dir)/topics-owner"; }

# --- add with Topics down ------------------------------------------------------
out="$(sh "$tw" add "$repo" 'My Task' 2>/dev/null)"; code=$?
ok "add <path>: exit 0 with Topics down" "$code" 0
ok "add <path>: {root}/{slug}/{name}" "$out" "$root/demo/my-task"
ok "add: branch worktree-<name>" "$(git -C "$out" symbolic-ref --short HEAD)" "worktree-my-task"
ok "add: creator defaults to adopted" "$(marker_of "$out" creator)" "adopted"
ok "add: no lock nobody could lift" "$(git -C "$repo" worktree list --porcelain | /usr/bin/grep -c '^locked')" 0
out2="$(TOPICS_WORKTREE_CREATOR=codex sh "$tw" add "$repo" second 2>/dev/null)"
ok "add: the creator comes from TOPICS_WORKTREE_CREATOR" "$(marker_of "$out2" creator)" "codex"
sh "$tw" add demo 2>/dev/null
ok "add <project> with Topics down: refused, exit 1" "$?" 1
sh "$tw" register "$out" >/dev/null 2>&1
ok "register with Topics down: exit 1" "$?" 1

# --- list -----------------------------------------------------------------------
listed="$(sh "$tw" list 2>/dev/null | cut -f1,3 | sort | tr '\n' ' ')"
ok "list: every worktree under the root, with its creator" "$listed" "demo/my-task	adopted demo/second	codex "

# --- with Topics up ------------------------------------------------------------
export FAKE_ROOT="$tmp/root2" FAKE_REPO="$repo"
start_fake
out3="$(sh "$tw" add demo third 2>/dev/null)"
ok "add <project>: the project's repository, placed by Topics" "$out3" "$tmp/root2/demo/third"
reg="$(/usr/bin/grep '^POST /api/worktrees/register ' "$tmp/requests.log" | sed 's/^POST \/api\/worktrees\/register //')"
ok "add: registered as adopted" "$(printf '%s' "$reg" | jq -r '.creator + " " + .path')" "adopted $tmp/root2/demo/third"
: > "$tmp/requests.log"
manual="$tmp/by-hand"
git -C "$repo" worktree add -q -b by-hand "$manual" >/dev/null 2>&1
sh "$tw" register "$manual" >/dev/null 2>&1
ok "register <path>: exit 0" "$?" 0
reg="$(/usr/bin/grep '^POST /api/worktrees/register ' "$tmp/requests.log" | sed 's/^POST \/api\/worktrees\/register //')"
ok "register <path>: path, branch and creator sent" "$(printf '%s' "$reg" | jq -r '.path + " " + .branch + " " + .creator')" "$manual by-hand adopted"
stop_fake

sh "$tw" bogus >/dev/null 2>&1
ok "unknown command: usage, exit 2" "$?" 2

exit $fail
