set -x
export PATH=/opt/node20/bin:$PATH
cd /home/user/topics-app
S=$(date +%s)
bun install --frozen-lockfile --ignore-scripts && npm rebuild node-pty && bun run scripts/fix-node-pty-exec-bit.ts && (cd client && bun install --frozen-lockfile) && git fetch --no-tags --depth=1 origin +main:refs/remotes/origin/main
echo "DEPS_EXIT=$? secs=$(( $(date +%s)-S ))"
npm i --prefix /tmp/bun138 bun@1.3.8; /tmp/bun138/node_modules/.bin/bun --version
echo "BUN138 secs=$(( $(date +%s)-S ))"
npx playwright install --with-deps chromium; echo "PW_EXIT=$? secs=$(( $(date +%s)-S ))"
