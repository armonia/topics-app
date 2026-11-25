#!/usr/bin/env sh
# Bar of scripts/claude-hooks/worktree-hook.sh as the Claude Code
# WorktreeCreate / WorktreeRemove hook. Exit 0 = every case holds.
# A temporary repo and TOPICS_HOME, a fake Topics server for the cases that
# need one; nothing outside the temp folder is read or written.
# `TOPICS_HOOK_NO_JQ=1 sh worktree-hook.test.sh` runs every hook call on the
# sed reader, the normal case on a Windows machine without jq.
# @covers WORKTREE-STD-13, WORKTREE-STD-16
set -u
here="$(cd "$(dirname "$0")" && pwd)"
hook="$here/worktree-hook.sh"
tmp="$(mktemp -d)"; tmp="$(cd "$tmp" && pwd -P)"
trap 'stop_fake; rm -rf "$tmp"' EXIT
. "$here/worktree-hook.test-lib.sh"
# Inside the sandbox: a `git -C ""` of a case gone wrong reads the sandbox, never the checkout.
cd "$tmp" || exit 1

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
remove_wt() { # path [session] [script]
  printf '{"session_id":"%s","hook_event_name":"WorktreeRemove","worktree_path":"%s"}' "${2:-s-1}" "$1" \
    | sh "${3:-$hook}" remove 2>"$tmp/err"
}
there() { if [ -e "$1" ]; then echo there; else echo gone; fi; }
lock_of() { git -C "$repo" worktree list --porcelain | awk -v p="$1" '/^worktree /{c=substr($0,10)} /^locked/{if(c==p)print substr($0,8)}'; }

# A git that fails one step on request (SHIM_FAIL), real git for everything else:
#   lock         `worktree lock` fails
#   kill-add     `worktree add` kills the hook that called it, as an Esc or a timeout would
#   path-format  `--path-format` is unknown, as on git older than 2.31
#   commit-tree  the snapshot of uncommitted work cannot be written
real_git="$(command -v git)"
mkdir -p "$tmp/gitshim"
cat > "$tmp/gitshim/git" <<EOF
#!/bin/sh
prev=""
for a in "\$@"; do
  case "\${SHIM_FAIL:-}:\$prev \$a" in
    "lock:worktree lock") exit 1 ;;
    "kill-add:worktree add") kill -TERM "\$PPID"; exit 1 ;;
  esac
  case "\${SHIM_FAIL:-}:\$a" in
    path-format:--path-format*) echo "error: unknown option" >&2; exit 129 ;;
    commit-tree:commit-tree) exit 1 ;;
  esac
  prev="\$a"
done
exec "$real_git" "\$@"
EOF
chmod +x "$tmp/gitshim/git"
with_git() { _f="$1"; shift; (PATH="$tmp/gitshim:$PATH"; SHIM_FAIL="$_f"; export PATH SHIM_FAIL; "$@"); }

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
ok "git worktree list has it, locked claude-code:" "$(lock_of "$want")" "claude-code:s-1"
ok ".worktreeinclude: ignored file copied" "$(cat "$want/.env" 2>/dev/null)" "secret"
ok ".worktreeinclude: a file that is not ignored stays behind" "$([ -e "$want/notes.local" ] && echo copied || echo absent)" "absent"
ok "ledger: the root carries Topics' sentinel" "$([ -f "$root/.topics-worktree-root" ] && echo yes || echo no)" "yes"
ok "ledger: the folder has its entry, naming the creator" "$(jq -r .creator "$root/.topics-owned/demo-repo/feature-x-y" 2>/dev/null)" "claude-code"

# --- idempotent for the session that made it (a resume) -----------------------
before="$(git -C "$repo" worktree list | wc -l | tr -d ' ')"
out2="$(create 'Feature/X+Y')"
ok "re-run: same path" "$(printf '%s\n' "$out2" | tail -n 1)" "$want"
ok "re-run: no second worktree" "$(git -C "$repo" worktree list | wc -l | tr -d ' ')" "$before"

# --- a folder of somebody else's under the same name: next suffix -------------
mkdir -p "$root/demo-repo/taken"
ok "a foreign folder takes -2" "$(create taken | tail -n 1)" "$root/demo-repo/taken-2"

# --- the sed reader, for machines without jq ----------------------------------
ok "without jq: same contract" "$(payload 'Plain' | TOPICS_HOOK_NO_JQ=1 sh "$hook" create 2>/dev/null | tail -n 1)" "$root/demo-repo/plain"

# --- one folder, one session ----------------------------------------------------
# Two sessions asking for the same name must not share a folder: when the second
# one exits, its remove would take the first one's live work (ignored .env too).
a_path="$(create shared s-a | tail -n 1)"
ok "another session asking the same name: its own folder" "$(create shared s-b | tail -n 1)" "$root/demo-repo/shared-2"
ok "the same session asking again: its folder back" "$(create shared s-a | tail -n 1)" "$a_path"
echo live > "$a_path/.env"
remove_wt "$a_path" s-b
ok "remove from another session: refused" "$?" 1
ok "remove from another session: the folder and its ignored .env intact" "$(cat "$a_path/.env" 2>/dev/null)" "live"
remove_wt "$a_path" s-a
ok "remove from the session that made it: exit 0" "$?" 0
ok "remove from the session that made it: the folder is gone" "$(there "$a_path")" "gone"

# --- two creates at once, same name: each gets a worktree ----------------------
for s in 1 2 3; do payload race "s-race-$s" | sh "$hook" create >"$tmp/race$s" 2>/dev/null & eval "race_pid$s=\$!"; done
race_codes=""; for s in 1 2 3; do eval "wait \"\$race_pid$s\""; race_codes="$race_codes$?"; done
ok "three creates at once: all exit 0" "$race_codes" "000"
ok "three creates at once: three folders" \
  "$(for s in 1 2 3; do tail -n 1 "$tmp/race$s"; done | sort | tr '\n' ' ')" \
  "$root/demo-repo/race $root/demo-repo/race-2 $root/demo-repo/race-3 "
ok "three creates at once: three worktrees, one branch each" \
  "$(for s in 1 2 3; do git -C "$(tail -n 1 "$tmp/race$s")" symbolic-ref --short HEAD 2>/dev/null; done | sort | tr '\n' ' ')" \
  "worktree-race worktree-race-2 worktree-race-3 "

# --- a failed lock rolls back only what this run made --------------------------
# worktree-keep carries a commit nobody pushed, left by an earlier session.
git -C "$repo" worktree add -q -b worktree-keep "$tmp/keep-src" >/dev/null 2>&1
echo kept > "$tmp/keep-src/k.txt" && git -C "$tmp/keep-src" add k.txt && git -C "$tmp/keep-src" commit -qm keep
keep_head="$(git -C "$tmp/keep-src" rev-parse HEAD)"
git -C "$repo" worktree remove "$tmp/keep-src"
with_git lock create keep s-k >/dev/null
ok "lock fails: create exits 1" "$?" 1
ok "lock fails: the half-made folder is gone" "$(there "$root/demo-repo/keep")" "gone"
ok "lock fails: a branch that was there before keeps its commit" \
  "$(git -C "$repo" rev-parse --verify --quiet refs/heads/worktree-keep || echo none)" "$keep_head"
ok "lock fails: no ledger entry is left for the name" "$(there "$root/.topics-owned/demo-repo/keep")" "gone"
with_git lock create lockfresh s-k >/dev/null
ok "lock fails: a branch this run made goes" \
  "$(git -C "$repo" rev-parse --verify --quiet refs/heads/worktree-lockfresh || echo none)" "none"

# --- the ledger entry is written only once the checkout exists -----------------
with_git kill-add create killed s-x >/dev/null 2>&1
code=$?
ok "killed during git worktree add: the hook did not finish" "$([ "$code" -ne 0 ] && echo stopped || echo finished)" "stopped"
ok "killed during git worktree add: no ledger entry for the name" "$(there "$root/.topics-owned/demo-repo/killed")" "gone"

# --- a claude-code worktree whose folder vanished does not block its name -------
gone_path="$(create vanish s-v | tail -n 1)"
rm -rf "$gone_path"
out="$(create vanish s-w)"; code=$?
ok "vanished folder, claude-code lock: created again, exit 0" "$code" 0
ok "vanished folder, claude-code lock: same name" "$(printf '%s\n' "$out" | tail -n 1)" "$gone_path"
ok "vanished folder, claude-code lock: now locked by the new session" "$(lock_of "$gone_path")" "claude-code:s-w"
# A lock of somebody else's on a vanished folder is not the hook's to lift.
TOPICS_WORKTREE_CREATOR=codex sh "$hook" add "$repo" foreignvanish >/dev/null 2>&1
git -C "$repo" worktree lock --reason "codex:y" "$root/demo-repo/foreignvanish"
rm -rf "$root/demo-repo/foreignvanish"
create foreignvanish s-z >/dev/null
ok "vanished folder, foreign lock: the lock is left alone" "$(lock_of "$root/demo-repo/foreignvanish")" "codex:y"

# --- git older than 2.31 (no --path-format) ---------------------------------------
with_git path-format git -C "$repo" rev-parse --path-format=absolute --git-dir >/dev/null 2>&1
ok "old git shim: --path-format is refused" "$?" 129
out="$(with_git path-format create oldgit s-o)"; code=$?
ok "old git: create exits 0" "$code" 0
ok "old git: the path" "$(printf '%s\n' "$out" | tail -n 1)" "$root/demo-repo/oldgit"
ok "old git: marker written" "$(jq -r .creator "$(git -C "$root/demo-repo/oldgit" rev-parse --path-format=absolute --git-dir)/topics-owner" 2>/dev/null)" "claude-code"
with_git path-format remove_wt "$root/demo-repo/oldgit" s-o
ok "old git: remove exits 0" "$?" 0
ok "old git: archived, then removed" "$(git -C "$repo" rev-parse --verify --quiet 'refs/tags/archive/wt-oldgit^{commit}' >/dev/null && there "$root/demo-repo/oldgit")" "gone"

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
remove_wt "$want"; code=$?
ok "remove: exit 0" "$code" 0
ok "remove: the folder is gone" "$(there "$want")" "gone"
ok "remove: tag archive/wt-<name> on HEAD" "$(git -C "$repo" rev-parse --verify --quiet 'refs/tags/archive/wt-feature-x-y^{commit}')" "$head"
ok "remove: the branch is gone" "$(git -C "$repo" rev-parse --verify --quiet refs/heads/worktree-feature-x-y || echo none)" "none"
ok "remove: the ledger entry goes with the folder" "$(there "$root/.topics-owned/demo-repo/feature-x-y")" "gone"
remove_wt "$want"
ok "remove again: nothing to do, exit 0" "$?" 0

remove_wt "$repo"
ok "remove: a main checkout is refused" "$?" 1
ok "remove: the main checkout is untouched" "$([ -d "$repo/.git" ] && echo kept || echo lost)" "kept"

# A worktree with Topics' marker, locked by another tool: only the lock check
# stands between it and the removal (the mutation at the bottom proves it).
git -C "$repo" worktree add -q -b other "$tmp/codex-wt" >/dev/null 2>&1
printf '{"worktreeId":"","projectId":"","createdAt":"2026-01-01T00:00:00Z","creator":"codex"}\n' \
  > "$(git -C "$tmp/codex-wt" rev-parse --path-format=absolute --git-dir)/topics-owner"
git -C "$repo" worktree lock --reason "codex:x" "$tmp/codex-wt"
remove_wt "$tmp/codex-wt"
ok "remove: a foreign lock is refused" "$?" 1
ok "remove: the foreign worktree stays" "$([ -d "$tmp/codex-wt" ] && echo kept || echo lost)" "kept"

# --- remove: a worktree with no Topics proof is never removed ----------------
# Made by hand next to the hook's ones, no lock, no marker, no ledger entry, and
# an ignored file `remove --force` would take with it.
byhand="$root/demo-repo/by-hand"
git -C "$repo" worktree add -q -b by-hand "$byhand" >/dev/null 2>&1
echo mine > "$byhand/.env"
remove_wt "$byhand"
ok "remove: a worktree without a Topics marker is refused" "$?" 1
ok "remove: it stays, its ignored .env intact" "$(cat "$byhand/.env" 2>/dev/null)" "mine"

# --- remove keeps uncommitted work in the archive -----------------------------
dirty_path="$(create dirty | tail -n 1)"
echo changed > "$dirty_path/a.txt"
echo fresh > "$dirty_path/new.txt"
remove_wt "$dirty_path"
ok "remove dirty: exit 0" "$?" 0
ok "remove dirty: a modified file is in the archive" "$(git -C "$repo" show 'archive/wt-dirty:a.txt' 2>/dev/null)" "changed"
ok "remove dirty: an untracked file is in the archive" "$(git -C "$repo" show 'archive/wt-dirty:new.txt' 2>/dev/null)" "fresh"

# --- remove: what cannot be archived is not removed ----------------------------
snap_path="$(create snapfail | tail -n 1)"
echo changed > "$snap_path/a.txt"
with_git commit-tree remove_wt "$snap_path"
ok "snapshot fails: remove refused" "$?" 1
ok "snapshot fails: the change is still there" "$(cat "$snap_path/a.txt" 2>/dev/null)" "changed"
orphan_path="$(create orphan | tail -n 1)"
git -C "$orphan_path" checkout -q --orphan newroot
echo work > "$orphan_path/mywork.txt" && git -C "$orphan_path" add mywork.txt
echo loose > "$orphan_path/loose.txt"
remove_wt "$orphan_path"
ok "no commit yet, files staged and untracked: remove refused" "$?" 1
ok "no commit yet: the staged file is still there" "$(cat "$orphan_path/mywork.txt" 2>/dev/null)" "work"
ok "no commit yet: the untracked file is still there" "$(cat "$orphan_path/loose.txt" 2>/dev/null)" "loose"

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

# --- the post-checkout register hook next to the worktree hook ------------------
# Both installed: the hook's own worktree is registered once, by the hook, with
# its real creator; a bare `git worktree add` (the control) is registered by
# post-checkout, which proves that hook is live.
mkdir -p "$tmp/githooks"
cp "$here/../git-hooks/post-checkout-register" "$tmp/githooks/post-checkout"
chmod +x "$tmp/githooks/post-checkout"
git -C "$repo" config core.hooksPath "$tmp/githooks"
export TOPICS_WORKTREE_LIB="$hook" FAKE_ROOT="$tmp/root4"
start_fake
create twice s-9 >/dev/null
regs="$(/usr/bin/grep '^POST /api/worktrees/register ' "$tmp/requests.log" | sed 's/^POST \/api\/worktrees\/register //')"
ok "post-checkout installed: the hook's worktree is registered once" "$(printf '%s\n' "$regs" | /usr/bin/grep -c .)" 1
ok "post-checkout installed: ... as claude-code" "$(printf '%s' "$regs" | jq -r .creator)" "claude-code"
: > "$tmp/requests.log"
git -C "$repo" worktree add -q -b bare-reg "$tmp/bare-reg" >/dev/null 2>&1
ok "post-checkout installed: a bare git worktree add registers itself (control)" \
  "$(/usr/bin/grep '^POST /api/worktrees/register ' "$tmp/requests.log" | sed 's/^POST \/api\/worktrees\/register //' | jq -r .creator)" "adopted"
stop_fake
git -C "$repo" config --unset core.hooksPath
unset TOPICS_WORKTREE_LIB

# --- mutation: without the archive tag the bar must go red --------------------
sed 's/wt_git_repo "\$1" tag "\$_t" "\$3"/true/' "$hook" > "$tmp/mutant.sh"
if cmp -s "$hook" "$tmp/mutant.sh"; then echo "FAIL mutation not applied"; fail=1; fi
mut_path="$(create mutant | tail -n 1)"
remove_wt "$mut_path" s-1 "$tmp/mutant.sh"
mut_code=$?
if [ "$mut_code" = 0 ] && [ ! -e "$mut_path" ]; then
  echo "FAIL mutation survived: removed without an archive tag"; fail=1
else
  echo "ok   mutation (no archive tag) is caught"
fi

# --- mutation: without the proof gate the by-hand worktree must be lost -------
sed '/carries no Topics marker/d; s/\[ -r "\$_admin\/topics-owner" \] || \[ -n "\$_entry" \] \\/true/' "$hook" > "$tmp/mutant2.sh"
if cmp -s "$hook" "$tmp/mutant2.sh"; then echo "FAIL mutation (proof gate) not applied"; fail=1; fi
remove_wt "$byhand" s-1 "$tmp/mutant2.sh"
if [ -e "$byhand" ]; then
  echo "FAIL mutation survived: the by-hand worktree was kept without the proof gate"; fail=1
else
  echo "ok   mutation (no proof gate) is caught"
fi

# --- mutation: without the lock check the codex worktree must be lost ---------
sed '/locked by somebody else/d' "$hook" > "$tmp/mutant3.sh"
if cmp -s "$hook" "$tmp/mutant3.sh"; then echo "FAIL mutation (lock check) not applied"; fail=1; fi
remove_wt "$tmp/codex-wt" s-1 "$tmp/mutant3.sh"
if [ -e "$tmp/codex-wt" ]; then
  echo "FAIL mutation survived: the foreign-locked worktree was kept without the lock check"; fail=1
else
  echo "ok   mutation (no lock check) is caught"
fi

exit $fail
