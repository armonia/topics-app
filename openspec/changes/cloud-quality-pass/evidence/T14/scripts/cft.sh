set -e
export PATH=/opt/node20/bin:$PATH
cd /home/user/topics-app
S=$(date +%s)
B=./node_modules/playwright-core/browsers.json
V=$(node -p "require('$B').browsers.find(b=>b.name==='chromium').browserVersion")
R=$(node -p "require('$B').browsers.find(b=>b.name==='chromium').revision")
U=https://storage.googleapis.com/chrome-for-testing-public/$V/linux64
P=$HOME/.cache/ms-playwright; mkdir -p $P/chromium-$R $P/chromium_headless_shell-$R
D=/tmp/claude-0/-home-user-topics-app/2b119615-6f17-574c-b329-77893cf501ff/scratchpad
curl -fsSLo $D/c.zip $U/chrome-linux64.zip && unzip -qo $D/c.zip -d $P/chromium-$R
curl -fsSLo $D/h.zip $U/chrome-headless-shell-linux64.zip && unzip -qo $D/h.zip -d $P/chromium_headless_shell-$R
touch $P/chromium-$R/INSTALLATION_COMPLETE $P/chromium_headless_shell-$R/INSTALLATION_COMPLETE
rm -f $D/c.zip $D/h.zip
PLAYWRIGHT_BROWSERS_PATH=$P npx playwright install-deps chromium >/dev/null 2>&1 || echo "install-deps failed"
echo "CFT_DONE V=$V R=$R secs=$(( $(date +%s)-S ))"
