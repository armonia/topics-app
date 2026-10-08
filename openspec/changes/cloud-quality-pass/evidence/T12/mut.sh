#!/usr/bin/env bash
# T12 · B3 mutations, in a scratch worktree of the fix commit (never the real files).
# Usage: mut.sh <commit>
set -u
C=$1; M=/home/user/t12-mut
SP=/tmp/claude-0/-home-user-topics-app/affbdc18-0dbd-502d-80eb-3382b653a1e1/scratchpad
B138=/tmp/bun138/node_modules/.bin/bun
git -C /home/user/topics-app worktree remove --force $M 2>/dev/null
git -C /home/user/topics-app worktree add --detach $M $C >/dev/null 2>&1
ln -sfn /home/user/topics-app/node_modules $M/node_modules
cd $M
echo "== control (fix intact)"
$B138 test server/db/embedded-fallback-fresh-process.test.ts 2>&1 | grep -E "embedded-fresh\]|^ *[0-9]+ (pass|fail)"
bun test server/guest-media-sizes.test.ts 2>&1 | grep -E "guest-media-sizes\]|^ *[0-9]+ (pass|fail)"
echo "== M1: manifest back to text imports (the head's), Bun 1.3.8"
git checkout origin/cloud/t12-base -- server/db/migrations-embedded.ts
$B138 test server/db/embedded-fallback-fresh-process.test.ts 2>&1 | grep -E "embedded-fresh\]|^ *[0-9]+ (pass|fail)"
echo "== M1 same mutation, latest Bun"
bun test server/db/embedded-fallback-fresh-process.test.ts 2>&1 | grep -E "embedded-fresh\]|^ *[0-9]+ (pass|fail)"
git checkout $C -- server/db/migrations-embedded.ts
echo "== M2: guest payload = owner payload"
sed -i 's/guestPayloadOf(presentedMessage, payload)/payload/' server/utils.ts
grep -c "guestPayload ??= payload)" server/utils.ts
bun test server/guest-media-sizes.test.ts 2>&1 | grep -E "guest-media-sizes\]|^ *[0-9]+ (pass|fail)"
git checkout -- server/utils.ts
echo "== status after restore"; git status --short
cd /home/user/topics-app && git worktree remove --force $M
