#!/usr/bin/env sh
# Bar of scripts/claude-hooks/worktree-hook.sh as the Claude Code
# WorktreeCreate / WorktreeRemove hook. Exit 0 = every case holds.
# A temporary repo and TOPICS_HOME, a fake Topics server for the cases that
# need one; nothing outside the temp folder is read or written.
# @covers WORKTREE-STD-13, WORKTREE-STD-16
set -u
here="$(cd "$(dirname "$0")" && pwd)"
hook="$here/worktree-hook.sh"
tmp="$(mktemp -d)"; tmp="$(cd "$tmp" && pwd -P)"
trap 'stop_fake; rm -rf "$tmp"' EXIT
. "$here/worktree-hook.test-lib.sh"

repo="$(make_repo "$tmp/Demo_Repo")"
printf '.env\nnotes.local\n' > "$repo/.worktreeinclude"
printf '.env\n' > "$repo/.gitignore"
echo secret > "$repo/.env"
echo mine > "$repo/notes.local"
git -C "$repo" add .gitignore .worktreeinclude && git -C "$repo" commit -qm include
root="$TOPICS_HOME/worktrees"

payload() { # name [session]
  printf '{"session_id":"%s","transcript_path":"%s","cwd":"%s","hook_event_name":"WorktreeCreate","name":"%s"}' \
    "${2:-s-1}" "$tmp/t.jsonl" "$repo" "$1"
}
create() { payload "$@" | sh "$hook" create 2>"$tmp/err"; }

# --- create with Topics down -------------------------------------------------
out="$(create 'Feature/X+Y')"; code=$?
want="$root/demo-repo/feature-x-y"
ok "server down: still created, exit 0" "$code" 0
ok "the last stdout line is {root}/{slug}/{name}" "$(printf '%s\n' "$out" | tail -n 1)" "$want"
ok "stdout carries the path only" "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" 1
ok "branch worktree-<name>" "$(git -C "$want" symbolic-ref --short HEAD)" "worktree-feature-x-y"
admin="$(git -C "$want" rev-parse --path-format=absolute --git-dir)"
ok "marker v2 names the creator" "$(jq -r .creator "$admin/topics-owner")" "claude-code"
ok "marker v2 names the session" "$(jq -r .session.id "$admin/topics-owner")" "s-1"
ok "marker v2 names the transcript" "$(jq -r .session.transcript "$admin/topics-owner")" "$tmp/t.jsonl"
ok "git worktree list has it, locked claude-code:" \
  "$(git -C "$repo" worktree list --porcelain | awk -v p="$want" '/^worktree /{c=substr($0,10)} /^locked/{if(c==p)print substr($0,8)}')" "claude-code:s-1"
ok ".worktreeinclude: ignored file copied" "$(cat "$want/.env" 2>/dev/null)" "secret"
ok ".worktreeinclude: a file that is not ignored stays behind" "$([ -e "$want/notes.local" ] && echo copied || echo absent)" "absent"
ok "ledger: the root carries Topics' sentinel" "$([ -f "$root/.topics-worktree-root" ] && echo yes || echo no)" "yes"
ok "ledger: the folder has its entry, naming the creator" "$(jq -r .creator "$root/.topics-owned/demo-repo/feature-x-y" 2>/dev/null)" "claude-code"

# --- idempotent ---------------------------------------------------------------
before="$(git -C "$repo" worktree list | wc -l | tr -d ' ')"
out2="$(create 'Feature/X+Y')"
ok "re-run: same path" "$(printf '%s\n' "$out2" | tail -n 1)" "$want"
ok "re-run: no second worktree" "$(git -C "$repo" worktree list | wc -l | tr -d ' ')" "$before"

# --- a folder of somebody else's under the same name: next suffix -------------
mkdir -p "$root/demo-repo/taken"
ok "a foreign folder takes -2" "$(create taken | tail -n 1)" "$root/demo-repo/taken-2"

# --- the sed reader, for machines without jq ----------------------------------
ok "without jq: same contract" "$(payload 'Plain' | TOPICS_HOOK_NO_JQ=1 sh "$hook" create 2>/dev/null | tail -n 1)" "$root/demo-repo/plain"

# --- create with Topics up: placement and registration ------------------------
export FAKE_ROOT="$tmp/root2"
start_fake
out="$(create srv s-2)"
ok "server up: placement's root and slug" "$(printf '%s\n' "$out" | tail -n 1)" "$tmp/root2/demo/srv"
ok "server up: asked placement for the repo" "$(/usr/bin/grep -c '^GET /api/worktrees/placement?repo=' "$tmp/requests.log")" 1
reg="$(/usr/bin/grep '^POST /api/worktrees/register ' "$tmp/requests.log" | sed 's/^POST \/api\/worktrees\/register //')"
ok "server up: registered through the door" "$(printf '%s' "$reg" | jq -r '.creator + " " + .session.id + " " + .path')" "claude-code s-2 $tmp/root2/demo/srv"
ok "server up: marker carries the project id" "$(jq -r .projectId "$(git -C "$tmp/root2/demo/srv" rev-parse --path-format=absolute --git-dir)/topics-owner")" "p1"
ok "server up: the ledger entry sits under placement's root" "$([ -f "$tmp/root2/.topics-owned/demo/srv" ] && echo yes || echo no)" "yes"
stop_fake

# --- remove -------------------------------------------------------------------
head="$(git -C "$want" rev-parse HEAD)"
printf '{"worktree_path":"%s"}' "$want" | sh "$hook" remove 2>"$tmp/err"; code=$?
ok "remove: exit 0" "$code" 0
ok "remove: the folder is gone" "$([ -e "$want" ] && echo there || echo gone)" "gone"
ok "remove: tag archive/wt-<name> on HEAD" "$(git -C "$repo" rev-parse --verify --quiet 'refs/tags/archive/wt-feature-x-y^{commit}')" "$head"
ok "remove: the branch is gone" "$(git -C "$repo" rev-parse --verify --quiet refs/heads/worktree-feature-x-y || echo none)" "none"
ok "remove: the ledger entry goes with the folder" "$([ -e "$root/.topics-owned/demo-repo/feature-x-y" ] && echo there || echo gone)" "gone"
printf '{"worktree_path":"%s"}' "$want" | sh "$hook" remove 2>/dev/null
ok "remove again: nothing to do, exit 0" "$?" 0

printf '{"worktree_path":"%s"}' "$repo" | sh "$hook" remove 2>/dev/null
ok "remove: a main checkout is refused" "$?" 1
ok "remove: the main checkout is untouched" "$([ -d "$repo/.git" ] && echo kept || echo lost)" "kept"

git -C "$repo" worktree add -q -b other "$tmp/codex-wt" >/dev/null 2>&1
git -C "$repo" worktree lock --reason "codex:x" "$tmp/codex-wt"
printf '{"worktree_path":"%s"}' "$tmp/codex-wt" | sh "$hook" remove 2>/dev/null
ok "remove: a foreign lock is refused" "$?" 1
ok "remove: the foreign worktree stays" "$([ -d "$tmp/codex-wt" ] && echo kept || echo lost)" "kept"

# --- remove: a worktree with no Topics proof is never removed ----------------
# Made by hand next to the hook's ones, no lock, no marker, no ledger entry, and
# an ignored file `remove --force` would take with it.
byhand="$root/demo-repo/by-hand"
git -C "$repo" worktree add -q -b by-hand "$byhand" >/dev/null 2>&1
echo mine > "$byhand/.env"
printf '{"worktree_path":"%s"}' "$byhand" | sh "$hook" remove 2>/dev/null
ok "remove: a worktree without a Topics marker is refused" "$?" 1
ok "remove: it stays, its ignored .env intact" "$(cat "$byhand/.env" 2>/dev/null)" "mine"

# --- remove keeps uncommitted work in the archive -----------------------------
dirty_path="$(create dirty | tail -n 1)"
echo changed > "$dirty_path/a.txt"
echo fresh > "$dirty_path/new.txt"
printf '{"worktree_path":"%s"}' "$dirty_path" | sh "$hook" remove 2>/dev/null
ok "remove dirty: exit 0" "$?" 0
ok "remove dirty: a modified file is in the archive" "$(git -C "$repo" show 'archive/wt-dirty:a.txt' 2>/dev/null)" "changed"
ok "remove dirty: an untracked file is in the archive" "$(git -C "$repo" show 'archive/wt-dirty:new.txt' 2>/dev/null)" "fresh"

# --- Git for Windows: the server gets native paths, never MSYS ones -----------
mkdir -p "$tmp/fakebin"
printf '#!/bin/sh\n[ "$1" = -m ] && shift\nprintf "C:%%s\\n" "$1"\n' > "$tmp/fakebin/cygpath"
chmod +x "$tmp/fakebin/cygpath"
export FAKE_ROOT="$tmp/root3"
start_fake
PATH="$tmp/fakebin:$PATH" create winpath >/dev/null
ok "windows: placement asked with the native repo path" "$(/usr/bin/grep -ci '^GET /api/worktrees/placement?repo=C%3A' "$tmp/requests.log")" 1
ok "windows: registered with the native path" \
  "$(/usr/bin/grep '^POST /api/worktrees/register ' "$tmp/requests.log" | sed 's/^POST \/api\/worktrees\/register //' | jq -r .path)" "C:$tmp/root3/demo/winpath"
stop_fake

# --- the token never sits in a command line (ps, /proc/<pid>/cmdline) ---------
real_curl="$(command -v curl)"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s/curl-argv.log"\nexec "%s" "$@"\n' "$tmp" "$real_curl" > "$tmp/fakebin/curl"
rm -f "$tmp/fakebin/cygpath"
chmod +x "$tmp/fakebin/curl"
: > "$tmp/curl-argv.log"
start_fake
PATH="$tmp/fakebin:$PATH" create argv >/dev/null
ok "token: the server still got the calls" "$(/usr/bin/grep -c '^POST /api/worktrees/register ' "$tmp/requests.log")" 1
ok "token: absent from curl's arguments" "$(/usr/bin/grep -c abcdef0123456789 "$tmp/curl-argv.log")" 0
stop_fake

# --- mutation: without the archive tag the bar must go red --------------------
sed 's/wt_git_repo "\$1" tag "\$_t" "\$3"/true/' "$hook" > "$tmp/mutant.sh"
if cmp -s "$hook" "$tmp/mutant.sh"; then echo "FAIL mutation not applied"; fail=1; fi
mut_path="$(create mutant | tail -n 1)"
printf '{"worktree_path":"%s"}' "$mut_path" | sh "$tmp/mutant.sh" remove 2>/dev/null
mut_code=$?
if [ "$mut_code" = 0 ] && [ ! -e "$mut_path" ]; then
  echo "FAIL mutation survived: removed without an archive tag"; fail=1
else
  echo "ok   mutation (no archive tag) is caught"
fi

# --- mutation: without the proof gate the by-hand worktree must be lost -------
sed '/carries no Topics marker/d; s/\[ -r "\$_admin\/topics-owner" \] || \[ -n "\$_entry" \] \\/true/' "$hook" > "$tmp/mutant2.sh"
if cmp -s "$hook" "$tmp/mutant2.sh"; then echo "FAIL mutation (proof gate) not applied"; fail=1; fi
printf '{"worktree_path":"%s"}' "$byhand" | sh "$tmp/mutant2.sh" remove 2>/dev/null
if [ -e "$byhand" ]; then
  echo "FAIL mutation survived: the by-hand worktree was kept without the proof gate"; fail=1
else
  echo "ok   mutation (no proof gate) is caught"
fi

exit $fail
