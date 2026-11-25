#!/usr/bin/env sh
# Topics App: where a worktree is born when Topics did not make it.
#
# One file, three users (change worktree-standard, tracks T9 and T11):
#   - Claude Code, as the WorktreeCreate / WorktreeRemove hook:
#       worktree-hook.sh create   < payload {session_id, transcript_path, cwd, name}
#       worktree-hook.sh remove   < payload {worktree_path}
#   - scripts/topics-worktree, for any other tool or a person:
#       worktree-hook.sh add <repo path|project> [name]
#       worktree-hook.sh register <path>
#       worktree-hook.sh list
#   - scripts/git-hooks/post-checkout-register, which calls `register`.
#
# CONTRACT WITH CLAUDE CODE. A WorktreeCreate hook replaces the CLI's own git
# logic entirely: no `.worktreeinclude`, no branch, no lock, no base ref unless
# the hook does them, so this script does them. The LAST non-empty line of
# stdout is the worktree path; everything else goes to stderr. Exit != 0 means
# the creation failed. WorktreeRemove: exit 0 means the folder is gone; a
# non-zero exit with the folder still there means the removal failed.
#
# THE FILESYSTEM IS THE PROTOCOL, THE SERVER AN ACCELERATOR. With Topics up the
# script asks where to put the checkout (`/api/worktrees/placement`) and
# registers it (`/api/worktrees/register`), so it has its row at once. With
# Topics down it still creates the worktree, under the default root, with the
# owner marker in its admin folder: the GC finds and registers it on its own.
# The hook never takes from Claude Code the ability to create a worktree: when
# the root is not writable it falls back to `<repo>/.claude/worktrees/<name>`.
#
# Layout: `{root}/{slug}/{name}`, branch `worktree-<name>`, base `origin/HEAD`
# after a fetch capped at 5 s (HEAD when there is no remote). Marker
# `.git/worktrees/<id>/topics-owner` (v2: creator, session, machine), lock
# `claude-code:<session id>`. Remove writes the tag `archive/wt-<name>` on HEAD
# first (with any uncommitted change on top of it) and removes nothing when the
# tag does not read back, when HEAD has no commit yet but the folder holds
# something, or when the lock names another session.
#
# ONE FOLDER, ONE SESSION. A name is claimed with `mkdir`, which is atomic: two
# creates asking for the same name at once get two folders. A folder already
# there is handed back only to the Claude Code session its lock names (a
# resume); any other caller gets the next free suffix (`name-2`, `name-3`...), so
# no session ever exits with the removal of another session's live folder.
#
# OWNERSHIP, THE GC'S ONLY PROOF. Inside the root every folder made here also
# gets Topics' ledger entry, `{root}/.topics-owned/{slug}/{name}` (and the root
# its sentinel `{root}/.topics-worktree-root`), the same files
# `server/services/worktree-root-ledger.ts` writes for Topics' own worktrees.
# Without it the cleanup only lists a folder: a checkout whose `.git` went
# missing would stay forever, and one a person made by hand next to it must
# never be moved. So the entry is written only once `git worktree add` succeeded
# and the lock holds: a hook killed halfway leaves no entry that a folder made
# by hand under that name could pass for. `register` writes the same proof for
# a checkout it is told about inside the root; `remove` refuses a worktree that
# carries no proof at all.
#
# POSIX sh (macOS, Linux, Git Bash on Windows), git 2.17 or later (`worktree
# remove`; no flag of a newer one) and curl; jq when present, sed otherwise.
# No path or name of a person in here: everything comes from the environment
# or the server.
#   TOPICS_HOME            Topics' home (default ~/.topics): token and default root
#   TOPICS_WORKTREES_DIR   the root when the server does not answer
#   TOPICS_APP_URL         the server (default https://127.0.0.1:3333)
#   TOPICS_WORKTREE_CREATOR  who `add` and `register` say they are (default adopted)

set -u

WT_HOME="${TOPICS_HOME:-$HOME/.topics}"

wt_log() { printf 'topics-worktree: %s\n' "$*" >&2; }
wt_die() { wt_log "$*"; exit 1; }

# ---------------------------------------------------------------------------
# JSON, both ways, with jq when present and sed otherwise.
# ---------------------------------------------------------------------------

# The string value of a top-level key ($2) of the JSON text $1. Empty when absent.
wt_json_field() {
  if [ "${TOPICS_HOOK_NO_JQ:-}" != 1 ] && command -v jq >/dev/null 2>&1; then
    printf '%s' "$1" | jq -r --arg k "$2" '.[$k] // empty | strings' 2>/dev/null
    return 0
  fi
  # Greedy prefix: the last occurrence of "key": wins. Keys here are fixed
  # names, and `"name"` does not match inside `"hook_event_name"`.
  printf '%s' "$1" | tr '\n\r' '  ' \
    | sed -nE "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"(([^\"\\\\]|\\\\.)*)\".*/\\1/p" \
    | sed -e 's/\\"/"/g' -e 's/\\\//\//g' -e 's/\\\\/\\/g'
}

# $1 as a JSON string literal, control characters dropped.
wt_json_str() {
  printf '"%s"' "$(printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
}

# ---------------------------------------------------------------------------
# The server: token next to the Claude hooks, 2 s per call, never required.
# ---------------------------------------------------------------------------

wt_token() {
  f="$WT_HOME/claude-hooks/hook-token"
  [ -r "$f" ] || return 1
  tr -d ' \n\r' < "$f"
}

# One call against one base: $1 base, $2 method, $3 path, then curl's own
# data arguments. Prints the body on a 2xx. The token goes in on stdin
# (`--header @-`, printf is a builtin): in an argument it would be readable by
# every user of the machine through ps or /proc/<pid>/cmdline.
wt_curl_once() {
  _cb="$1"; _cmethod="$2"; _cpath="$3"; shift 3
  printf 'Authorization: Bearer %s\n' "$WT_TOKEN" | curl --silent --insecure --fail --max-time 2 --retry 0 \
    --request "$_cmethod" \
    --header @- \
    --header "Content-Type: application/json" \
    "$@" "$_cb$_cpath" 2>/dev/null
}

# A call to Topics: HTTPS first (the server is TLS-only on its port), then the
# other scheme, like the post hook. Fails when there is no token or no server.
wt_http() {
  WT_TOKEN="$(wt_token)" || return 1
  [ -n "$WT_TOKEN" ] || return 1
  command -v curl >/dev/null 2>&1 || return 1
  _url="${TOPICS_APP_URL:-https://127.0.0.1:3333}"
  wt_curl_once "$_url" "$@" && return 0
  case "$_url" in
    https://*) wt_curl_once "http://${_url#https://}" "$@" ;;
    http://*) wt_curl_once "https://${_url#http://}" "$@" ;;
    *) return 1 ;;
  esac
}

wt_register() { # path creator session_id transcript branch name
  _body="{\"path\":$(wt_json_str "$(wt_native "$1")"),\"creator\":$(wt_json_str "$2")"
  if [ -n "$3" ]; then
    _body="$_body,\"session\":{\"id\":$(wt_json_str "$3")"
    [ -n "$4" ] && _body="$_body,\"transcript\":$(wt_json_str "$4")"
    _body="$_body}"
  fi
  [ -n "$5" ] && _body="$_body,\"branch\":$(wt_json_str "$5")"
  [ -n "$6" ] && _body="$_body,\"name\":$(wt_json_str "$6")"
  wt_http POST /api/worktrees/register --data "$_body}"
}

wt_unregister() { wt_http POST /api/worktrees/unregister --data "{\"path\":$(wt_json_str "$(wt_native "$1")")}" >/dev/null 2>&1 || true; }

# ---------------------------------------------------------------------------
# Paths and names.
# ---------------------------------------------------------------------------

wt_physical() { (cd "$1" 2>/dev/null && pwd -P); }

# A path in the host's native form: on Git for Windows `pwd -P` says
# `/c/Users/x`, which the server reads as `C:\c\Users\x`. Every path sent to the
# server or printed for Claude Code goes through this.
wt_native() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

# Git's common dir of the repository holding $1, physical. Fails outside a repo.
# Git may print it relative to $1, so it is resolved from there:
# `--path-format=absolute` would do it, but only from git 2.31 on.
wt_common_dir() {
  _c="$(git -C "$1" rev-parse --git-common-dir 2>/dev/null)" || return 1
  [ -n "$_c" ] || return 1
  (cd "$1" 2>/dev/null && cd "$_c" 2>/dev/null && pwd -P)
}

# The main checkout of a common dir (`<repo>/.git` -> `<repo>`), empty for a bare one.
wt_main_of() {
  case "$1" in
    */.git) printf '%s' "${1%/.git}" ;;
    *) printf '' ;;
  esac
}

# git on the repository of common dir $1, from its main checkout when there is one.
wt_git_repo() {
  _cd="$1"; shift
  _m="$(wt_main_of "$_cd")"
  if [ -n "$_m" ] && [ -d "$_m" ]; then git -C "$_m" "$@"; else git --git-dir="$_cd" "$@"; fi
}

# The name rule of Topics (`isValidWorktreeName`): ^[a-z][a-z0-9-]{0,63}$.
# Feature/X+Y -> feature-x-y; a name that does not start with a letter gets `wt-`.
wt_sanitize_name() {
  _n="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E -e 's/[^a-z0-9-]+/-/g' -e 's/-+/-/g' -e 's/^-+//' -e 's/-+$//')"
  case "$_n" in
    [a-z]*) ;;
    '') _n="wt" ;;
    *) _n="wt-$_n" ;;
  esac
  printf '%s' "$_n" | cut -c1-64 | sed -E 's/-+$//'
}

# The folder name of a repository, as the server spells a slug it does not know.
wt_fallback_slug() {
  _s="$(basename "$1" | tr '[:upper:]' '[:lower:]' | sed -E -e 's/[^a-z0-9-]+/-/g' -e 's/^-+//' -e 's/-+$//')"
  printf '%s' "${_s:-repo}"
}

wt_default_root() { printf '%s' "${TOPICS_WORKTREES_DIR:-$WT_HOME/worktrees}"; }

# Sets WT_ROOT, WT_SLUG, WT_PROJECT_ID for the repository of common dir $1:
# the server's placement when it answers, the default root otherwise.
wt_placement() {
  WT_ROOT=""; WT_SLUG=""; WT_PROJECT_ID=""
  _resp="$(wt_http GET /api/worktrees/placement --get --data-urlencode "repo=$(wt_native "$1")")" || _resp=""
  if [ -n "$_resp" ]; then
    WT_ROOT="$(wt_json_field "$_resp" root)"
    WT_SLUG="$(wt_json_field "$_resp" slug)"
    WT_PROJECT_ID="$(wt_json_field "$_resp" projectId)"
  fi
  [ -n "$WT_ROOT" ] || WT_ROOT="$(wt_default_root)"
  if [ -z "$WT_SLUG" ]; then
    _m="$(wt_main_of "$1")"
    WT_SLUG="$(wt_fallback_slug "${_m:-$1}")"
  fi
}

# The worktree at $1 belongs to the repository of common dir $2.
wt_is_worktree_of() {
  [ -f "$1/.git" ] || return 1
  _o="$(wt_common_dir "$1")" || return 1
  [ "$_o" = "$2" ]
}

# The admin folder of the worktree at $1 (`<common>/worktrees/<id>`), physical,
# resolved from $1 like the common dir.
wt_admin_dir() {
  _g="$(git -C "$1" rev-parse --git-dir 2>/dev/null)" || return 1
  [ -n "$_g" ] || return 1
  (cd "$1" 2>/dev/null && cd "$_g" 2>/dev/null && pwd -P)
}

# The lock reason in admin folder $1, one line. Only meaningful when `$1/locked` exists.
wt_lock_reason() { tr -d '\r\n' < "$1/locked" 2>/dev/null; }

wt_marker_creator() {
  _a="$(wt_admin_dir "$1")" || return 0
  [ -r "$_a/topics-owner" ] || return 0
  wt_json_field "$(cat "$_a/topics-owner")" creator
}

wt_write_marker() { # path creator session_id transcript project_id
  _a="$(wt_admin_dir "$1")" || return 1
  [ -d "$_a" ] || return 1
  _m="{\"worktreeId\":\"\",\"projectId\":$(wt_json_str "$5"),\"createdAt\":$(wt_json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)"),\"creator\":$(wt_json_str "$2")"
  if [ -n "$3" ]; then
    _m="$_m,\"session\":{\"id\":$(wt_json_str "$3")"
    [ -n "$4" ] && _m="$_m,\"transcript\":$(wt_json_str "$4")"
    _m="$_m}"
  fi
  _host="$(hostname 2>/dev/null || uname -n)"
  printf '%s,"machine":%s}\n' "$_m" "$(wt_json_str "$_host")" > "$_a/topics-owner"
}

# Topics' ledger under a root (see the header): sentinel of the root, then the
# entry of `{slug}/{name}`. An entry already there is kept as it is.
wt_mark_owned() { # root slug name creator
  mkdir -p "$1/.topics-owned/$2" 2>/dev/null || return 1
  _now="$(wt_json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
  [ -e "$1/.topics-worktree-root" ] || printf '{"createdAt":%s}\n' "$_now" > "$1/.topics-worktree-root" 2>/dev/null
  [ -e "$1/.topics-owned/$2/$3" ] && return 0
  printf '{"creator":%s,"createdAt":%s}\n' "$(wt_json_str "$4")" "$_now" > "$1/.topics-owned/$2/$3" 2>/dev/null
}

# The ledger entry of a worktree folder $1 (`{root}/{slug}/{name}`), printed when it is a file.
wt_owned_entry() {
  _e="$(dirname "$(dirname "$1")")/.topics-owned/$(basename "$(dirname "$1")")/$(basename "$1")"
  [ -f "$_e" ] && printf '%s' "$_e"
}

# $1 sits exactly at `{root}/{slug}/{name}` of the physical root $2.
wt_in_root() {
  [ -n "$2" ] || return 1
  [ "$(dirname "$(dirname "$1")")" = "$2" ] || return 1
  case "$(basename "$(dirname "$1")")/$(basename "$1")" in
    .*|*/.*|_*|*/_*) return 1 ;;
  esac
  return 0
}

# The path as Claude Code reads it: native form on Git for Windows.
wt_print_path() { printf '%s\n' "$(wt_native "$1")"; }

# The base of a new branch: origin's default after a fetch capped at 5 s, HEAD
# when there is no remote or the fetch did not bring it.
wt_base_ref() {
  git -C "$1" remote get-url origin >/dev/null 2>&1 || { printf 'HEAD'; return 0; }
  _def="$(git -C "$1" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)"
  _def="${_def#origin/}"
  [ -n "$_def" ] || { printf 'HEAD'; return 0; }
  GIT_TERMINAL_PROMPT=0 git -C "$1" fetch --quiet --no-tags origin "$_def" >/dev/null 2>&1 &
  _fp=$!
  # The watchdog writes nowhere: Claude Code reads stdout to EOF.
  (sleep 5; kill "$_fp" 2>/dev/null) >/dev/null 2>&1 &
  _kp=$!
  wait "$_fp" 2>/dev/null || true
  kill "$_kp" 2>/dev/null || true
  if git -C "$1" rev-parse --verify --quiet "refs/remotes/origin/$_def^{commit}" >/dev/null 2>&1; then
    printf 'origin/%s' "$_def"
  else
    printf 'HEAD'
  fi
}

# `.worktreeinclude`: files that match it AND are gitignored, copied from the
# checkout the session started in (Claude Code skips this when a hook exists).
wt_copy_includes() { # src_top dst
  [ -f "$1/.worktreeinclude" ] || return 0
  git -C "$1" ls-files --others --ignored --exclude-from=.worktreeinclude 2>/dev/null \
    | git -C "$1" check-ignore --stdin 2>/dev/null \
    | while IFS= read -r _f; do
        [ -n "$_f" ] && [ -f "$1/$_f" ] && [ ! -e "$2/$_f" ] || continue
        mkdir -p "$2/$(dirname "$_f")" 2>/dev/null || continue
        cp -c "$1/$_f" "$2/$_f" 2>/dev/null || cp -p "$1/$_f" "$2/$_f" 2>/dev/null || wt_log "could not copy $_f"
      done
}

# ---------------------------------------------------------------------------
# Create: the one path shared by the hook and `topics-worktree add`.
# ---------------------------------------------------------------------------

# The folder $1 is a worktree of common dir $2 that Claude Code session $3 made:
# claude-code marker, and a lock naming that very session. Only then is it handed
# back (a resume); a folder of another session is never shared.
wt_held_by_session() { # path common session
  [ -n "$3" ] || return 1
  wt_is_worktree_of "$1" "$2" || return 1
  [ "$(wt_marker_creator "$1")" = claude-code ] || return 1
  _ha="$(wt_admin_dir "$1")" || return 1
  [ -f "$_ha/locked" ] && [ "$(wt_lock_reason "$_ha")" = "claude-code:$3" ]
}

# `git worktree add` of the folder $2 on branch $3, for the repository at $1:
# the branch when it exists, else a new one from the base ref. WT_MADE_BRANCH
# says which: a rollback may delete only a branch this run made, never one that
# was there before (it may carry somebody's unpushed commits).
wt_add() { # cwd path branch
  WT_MADE_BRANCH=""
  if git -C "$1" rev-parse --verify --quiet "refs/heads/$3" >/dev/null 2>&1; then
    git -C "$1" worktree add "$2" "$3" >&2
  else
    WT_MADE_BRANCH=1
    git -C "$1" worktree add -b "$3" "$2" "$(wt_base_ref "$1")" >&2
  fi
}

# A worktree of this hook's whose folder vanished without the remove hook (rm,
# Finder) stays "missing but locked" for git, and its name with it, forever.
# Its folder holds nothing left to lose, the commits stay on its branch: the
# lock is lifted and the entry pruned, so the name can be made again. Only for
# a `claude-code:` lock in an admin folder whose marker says claude-code; fails,
# touching nothing, for anything else. $3 is the empty folder just claimed, so
# the registered path resolves (git may store it relative to the admin folder).
wt_lift_vanished() { # cwd common path
  [ -e "$3/.git" ] && return 1
  for _vg in "$2"/worktrees/*/gitdir; do
    [ -f "$_vg" ] || continue
    _va="$(dirname "$_vg")"
    _vt="$(cd "$_va" 2>/dev/null && cd "$(dirname "$(tr -d '\r\n' < "$_vg")")" 2>/dev/null && pwd -P)" || continue
    [ "$_vt" = "$3" ] || continue
    [ -f "$_va/locked" ] && [ -r "$_va/topics-owner" ] || return 1
    case "$(wt_lock_reason "$_va")" in claude-code:*) ;; *) return 1 ;; esac
    [ "$(wt_json_field "$(cat "$_va/topics-owner")" creator)" = claude-code ] || return 1
    wt_log "the claude-code worktree registered at $3 vanished: unlocking and pruning it"
    git -C "$1" worktree unlock "$3" >/dev/null 2>&1 || return 1
    git -C "$1" worktree prune >/dev/null 2>&1
    return 0
  done
  return 1
}

# $1 cwd, $2 wanted name, $3 creator, $4 session id, $5 transcript. Prints the path.
wt_create() {
  _cwd="$1"; _creator="$3"; _sid="$4"; _tr="$5"
  _common="$(wt_common_dir "$_cwd")" || wt_die "not inside a git repository: $_cwd"
  _main="$(wt_main_of "$_common")"
  _name="$(wt_sanitize_name "$2")"
  wt_placement "$_common"

  _parent="$WT_ROOT/$WT_SLUG"
  _owned_root=""
  if mkdir -p "$_parent" 2>/dev/null && [ -w "$_parent" ]; then
    _parent="$(wt_physical "$_parent")"
    _owned_root="$(dirname "$_parent")"
  else
    # Last resort: Claude Code's own place. Never leave the session without a worktree.
    [ -n "$_main" ] || wt_die "root $WT_ROOT is not writable and the repository has no main checkout"
    wt_log "root $WT_ROOT is not writable: falling back to $_main/.claude/worktrees"
    mkdir -p "$_main/.claude/worktrees" || wt_die "cannot create $_main/.claude/worktrees"
    _parent="$(wt_physical "$_main/.claude/worktrees")"
  fi

  # The post-checkout hook of the new worktree must not register it under
  # another creator before this script does.
  TOPICS_WORKTREE_REGISTER=skip
  export TOPICS_WORKTREE_REGISTER

  # The name, claimed with `mkdir` (see the header): git takes the empty folder
  # as its target. A folder already there goes back only to the Claude Code
  # session its lock names; anything else takes the next free suffix.
  _base="$_name"; _i=2
  while :; do
    _path="$_parent/$_name"
    if mkdir "$_path" 2>/dev/null; then
      wt_add "$_cwd" "$_path" "worktree-$_name" && break
      wt_lift_vanished "$_cwd" "$_common" "$_path" && wt_add "$_cwd" "$_path" "worktree-$_name" && break
      rmdir "$_path" 2>/dev/null
      wt_die "git worktree add failed for $_path"
    fi
    [ -e "$_path" ] || wt_die "cannot create $_path"
    if [ "$_creator" = claude-code ] && wt_held_by_session "$_path" "$_common" "$_sid"; then
      wt_print_path "$_path"
      return 0
    fi
    _name="$_base-$_i"; _i=$((_i + 1))
  done
  _branch="worktree-$_name"

  _top="$(git -C "$_cwd" rev-parse --show-toplevel 2>/dev/null)"
  [ -n "$_top" ] && wt_copy_includes "$_top" "$_path"
  wt_write_marker "$_path" "$_creator" "$_sid" "$_tr" "$WT_PROJECT_ID" || wt_log "owner marker not written for $_path"
  # Only a creator the GC has a rule for gets a lock: a lock nobody can lift
  # would keep the folder forever.
  if [ "$_creator" = "claude-code" ]; then
    if ! git -C "$_cwd" worktree lock --reason "claude-code:${_sid:-unknown}" "$_path" >&2; then
      git -C "$_cwd" worktree remove --force "$_path" >/dev/null 2>&1
      [ -n "$WT_MADE_BRANCH" ] && git -C "$_cwd" branch -D "$_branch" >/dev/null 2>&1
      wt_die "could not lock $_path: removed the half-made worktree"
    fi
  fi
  # The proof the cleanup asks before it ever moves this folder, only now that
  # the checkout exists and holds (the fallback under the repository is not a root).
  if [ -n "$_owned_root" ]; then
    wt_mark_owned "$_owned_root" "$WT_SLUG" "$_name" "$_creator" || wt_log "ledger entry not written for $_path"
  fi
  wt_register "$_path" "$_creator" "$_sid" "$_tr" "$_branch" "$_name" >/dev/null 2>&1 \
    || wt_log "Topics did not answer: the cleanup registers $_path on its own"
  wt_print_path "$_path"
}

# ---------------------------------------------------------------------------
# Remove: archive first, then folder and branch.
# ---------------------------------------------------------------------------

# Tags HEAD of the worktree as `archive/wt-<name>`, or `-<epoch>` when that tag
# already names another commit. Prints the tag; fails when it does not read back.
wt_archive_tag() { # common name head
  _t="archive/wt-$2"
  _have="$(wt_git_repo "$1" rev-parse --verify --quiet "refs/tags/$_t^{commit}" 2>/dev/null)"
  if [ -n "$_have" ] && [ "$_have" != "$3" ]; then _t="$_t-$(date +%s)"; _have=""; fi
  [ -n "$_have" ] || wt_git_repo "$1" tag "$_t" "$3" >/dev/null 2>&1
  [ "$(wt_git_repo "$1" rev-parse --verify --quiet "refs/tags/$_t^{commit}" 2>/dev/null)" = "$3" ] || return 1
  printf '%s' "$_t"
}

# The commit to archive: HEAD when the tree is clean, otherwise a commit on top
# of HEAD holding the tree as it is (modified and untracked files; ignored ones
# stay out, as in any commit). Built in a scratch index, so neither the
# worktree's index nor any branch moves. Fails when the snapshot cannot be made.
wt_snapshot() { # path head
  [ -z "$(git -C "$1" status --porcelain 2>/dev/null)" ] && { printf '%s' "$2"; return 0; }
  _sd="$(mktemp -d 2>/dev/null)" || return 1
  _si="$_sd/index"
  _st="$(GIT_INDEX_FILE="$_si" git -C "$1" read-tree "$2" 2>/dev/null \
    && GIT_INDEX_FILE="$_si" git -C "$1" add -A 2>/dev/null \
    && GIT_INDEX_FILE="$_si" git -C "$1" write-tree 2>/dev/null)"
  rm -rf "$_sd"
  [ -n "$_st" ] || return 1
  _un="$(git -C "$1" config user.name 2>/dev/null)"; _ue="$(git -C "$1" config user.email 2>/dev/null)"
  git -C "$1" -c user.name="${_un:-topics-worktree}" -c user.email="${_ue:-topics-worktree@localhost}" \
    commit-tree "$_st" -p "$2" -m "worktree removed with uncommitted changes" 2>/dev/null
}

wt_remove() { # path session_id
  _p="$1"; _sid="$2"
  [ -n "$_p" ] || return 0
  if [ ! -e "$_p" ]; then wt_unregister "$_p"; return 0; fi
  [ -d "$_p/.git" ] && wt_die "refusing: $_p is a main checkout"
  [ -f "$_p/.git" ] || wt_die "refusing: $_p is not a git worktree"
  _p="$(wt_physical "$_p")"
  _common="$(wt_common_dir "$_p")" || wt_die "cannot read the repository of $_p"
  _admin="$(wt_admin_dir "$_p")" || wt_die "cannot read the admin folder of $_p"
  # The hook's lock is lifted only by the session it names: the folder of a
  # session still at work is never removed because another one exits.
  if [ -f "$_admin/locked" ]; then
    _lock="$(wt_lock_reason "$_admin")"
    case "$_lock" in
      "claude-code:${_sid:-unknown}") ;;
      claude-code:*) wt_die "refusing: $_p belongs to another Claude Code session ($_lock)" ;;
      *) wt_die "refusing: $_p is locked by somebody else ($_lock)" ;;
    esac
  fi
  # Nothing reaches deletion without Topics' proof: the owner marker a creator
  # wrote in the admin folder, or the ledger entry under the root.
  _entry="$(wt_owned_entry "$_p")"
  [ -r "$_admin/topics-owner" ] || [ -n "$_entry" ] \
    || wt_die "refusing: $_p carries no Topics marker (not made through Topics' doors)"
  _head="$(git -C "$_p" rev-parse --verify --quiet HEAD 2>/dev/null)"
  _branch="$(git -C "$_p" symbolic-ref --quiet --short HEAD 2>/dev/null)"
  if [ -n "$_head" ]; then
    # Uncommitted work goes into the archive too: `remove --force` below drops it.
    _keep="$(wt_snapshot "$_p" "$_head")" && [ -n "$_keep" ] \
      || wt_die "uncommitted changes in $_p could not be archived: nothing removed"
    _tag="$(wt_archive_tag "$_common" "$(wt_sanitize_name "$(basename "$_p")")" "$_keep")" \
      || wt_die "archive tag not written for $_p: nothing removed"
    wt_log "archived $_keep as $_tag"
  else
    # No commit yet (`git checkout --orphan`): nothing to archive on, so anything
    # in the index or the folder, ignored files included, would go unarchived.
    _unborn="$(git -C "$_p" status --porcelain --ignored 2>/dev/null)" \
      || wt_die "cannot read the state of $_p: nothing removed"
    [ -z "$_unborn" ] || wt_die "$_p has no commit yet and holds files that cannot be archived: nothing removed"
  fi
  wt_git_repo "$_common" worktree unlock "$_p" >/dev/null 2>&1
  wt_git_repo "$_common" worktree remove --force "$_p" >&2
  wt_git_repo "$_common" worktree prune >/dev/null 2>&1
  if [ -e "$_p" ]; then wt_die "the folder is still there: $_p"; fi
  [ -n "$_entry" ] && rm -f "$_entry"
  # Only the branch this script names, and only while it still points at what
  # was archived: a branch that moved on is somebody's work.
  case "$_branch" in
    worktree-*)
      if [ "$(wt_git_repo "$_common" rev-parse --verify --quiet "refs/heads/$_branch" 2>/dev/null)" = "$_head" ]; then
        wt_git_repo "$_common" branch -D "$_branch" >/dev/null 2>&1 || wt_log "branch $_branch kept"
      fi
      ;;
  esac
  wt_unregister "$_p"
  return 0
}

# ---------------------------------------------------------------------------
# topics-worktree: add, register, list.
# ---------------------------------------------------------------------------

wt_cmd_add() { # repo-path|project [name]
  [ -n "${1:-}" ] || wt_die "usage: topics-worktree add <repo path|project> [name]"
  if [ -d "$1" ]; then
    _repo="$1"
  else
    _resp="$(wt_http GET /api/worktrees/placement --get --data-urlencode "project=$1")" \
      || wt_die "Topics did not answer: pass the repository path instead of the project name"
    _repo="$(wt_json_field "$_resp" repo)"
    [ -n "$_repo" ] && [ -d "$_repo" ] || wt_die "no project named $1"
  fi
  wt_create "$_repo" "${2:-wt-$(date +%m%d-%H%M%S)}" "${TOPICS_WORKTREE_CREATOR:-adopted}" "" ""
}

wt_cmd_register() { # path
  [ -n "${1:-}" ] && [ -d "$1" ] || wt_die "usage: topics-worktree register <path>"
  _p="$(wt_physical "$1")"
  _b="$(git -C "$_p" symbolic-ref --quiet --short HEAD 2>/dev/null)"
  wt_mark_registered "$_p"
  _resp="$(wt_register "$_p" "${TOPICS_WORKTREE_CREATOR:-adopted}" "" "" "$_b" "")" \
    || wt_die "Topics did not answer: the cleanup registers $_p on its own within a day"
  printf '%s\n' "$_resp"
}

# A linked worktree told about through `register`, inside the root (the one
# Topics places in, or the default one): the ledger entry and, when the admin
# folder has none, the owner marker naming its creator. What the door writes
# with Topics up, written here too so a checkout registered while Topics is down
# is still provably made through Topics. Outside the root nothing is marked.
wt_mark_registered() { # physical path
  [ -f "$1/.git" ] || return 0
  _rc="$(wt_common_dir "$1")" || return 0
  wt_placement "$_rc"
  _creator="${TOPICS_WORKTREE_CREATOR:-adopted}"
  for _r in "$WT_ROOT" "$(wt_default_root)"; do
    _rp="$(wt_physical "$_r")" || continue
    wt_in_root "$1" "$_rp" || continue
    wt_mark_owned "$_rp" "$(basename "$(dirname "$1")")" "$(basename "$1")" "$_creator" || wt_log "ledger entry not written for $1"
    _a="$(wt_admin_dir "$1")" && [ -e "$_a/topics-owner" ] \
      || wt_write_marker "$1" "$_creator" "" "" "$WT_PROJECT_ID" || wt_log "owner marker not written for $1"
    return 0
  done
}

wt_cmd_list() {
  if _c="$(wt_common_dir "$PWD")"; then wt_placement "$_c"; else WT_ROOT="$(wt_default_root)"; fi
  [ -d "$WT_ROOT" ] || return 0
  for _d in "$WT_ROOT"/*/*; do
    [ -f "$_d/.git" ] || continue
    _b="$(git -C "$_d" symbolic-ref --quiet --short HEAD 2>/dev/null || printf 'detached')"
    _cr="$(wt_marker_creator "$_d")"
    printf '%s/%s\t%s\t%s\t%s\n' "$(basename "$(dirname "$_d")")" "$(basename "$_d")" "$_b" "${_cr:--}" "$_d"
  done
}

wt_main() {
  _cmd="${1:-}"
  [ $# -gt 0 ] && shift
  case "$_cmd" in
    create)
      _in="$(cat)"
      _cwd="$(wt_json_field "$_in" cwd)"
      _nm="$(wt_json_field "$_in" name)"
      [ -n "$_nm" ] || wt_die "WorktreeCreate payload without a name"
      wt_create "${_cwd:-$PWD}" "$_nm" claude-code "$(wt_json_field "$_in" session_id)" "$(wt_json_field "$_in" transcript_path)"
      ;;
    remove)
      _in="$(cat)"
      wt_remove "$(wt_json_field "$_in" worktree_path)" "$(wt_json_field "$_in" session_id)"
      ;;
    add) wt_cmd_add "$@" ;;
    register) wt_cmd_register "$@" ;;
    list) wt_cmd_list ;;
    *) wt_die "usage: worktree-hook.sh create|remove (Claude Code) | add <repo|project> [name] | register <path> | list" ;;
  esac
}

wt_main "$@"
