#!/bin/bash
# GitHub runners of armonia/topics-app on the fixed server (topics-fisso), next to the Topics node.
#
#   node-pool fisso-ci    from the Mac: asks GitHub for a registration token and runs
#                         this file as root over ssh with REG_TOKEN and N in the environment
#
# Idempotent: a runner already configured is only (re)started. The registration token
# is used once by config.sh and never written to disk; afterwards each runner holds only
# its own runner credentials.
#
# Why each piece:
# - one Linux user per runner (group `ci`), never root: the Topics node on this box
#   trusts loopback as its owner, and a CI job must not reach it, nor the Mac's model
#   proxy behind the ssh tunnel, nor /home/topics (iptables by group, home 0700);
# - persistent runners: caches in each HOME (bun, Playwright browsers) survive between
#   jobs, and no admin token lives here to re-register ephemeral ones;
# - HOME=/srv/rh-<i>: ci.yml derives the e2e port band from it (13910 + (i-1)*10);
# - ci.slice with a low CPU weight and a memory ceiling: Topics cards come first;
# - a job-completed hook kills what a job left running in the runner's cgroup.
set -euo pipefail
: "${REG_TOKEN:?registration token}"
N=${N:-4}
URL=${URL:-https://github.com/armonia/topics-app}
PW_VERSION=${PW_VERSION:-1.59.1}
export DEBIAN_FRONTEND=noninteractive

apt-get -o DPkg::Lock::Timeout=600 update -qq
apt-get -o DPkg::Lock::Timeout=600 install -y -qq jq curl git unzip build-essential python3 zsh sqlite3 tmux lsof iptables >/var/log/ci-apt.log 2>&1
command -v npx >/dev/null || { echo "node manca: la ricetta del nodo Topics non è finita" >&2; exit 1; }
npx -y "playwright@$PW_VERSION" install-deps chromium webkit >/var/log/ci-pw-deps.log 2>&1

getent group ci >/dev/null || groupadd ci
chmod 700 /home/topics 2>/dev/null || true

# Firewall: the ci group cannot reach the Topics node (3333 http, 3341 tunnel listener),
# the reverse tunnel to the Mac's model proxy (3411-3413) nor the metadata service.
cat > /usr/local/sbin/ci-firewall <<'EOS'
#!/bin/bash
for t in iptables ip6tables; do
  $t -N CI-OUT 2>/dev/null || $t -F CI-OUT
  $t -C OUTPUT -m owner --gid-owner ci -j CI-OUT 2>/dev/null || $t -I OUTPUT -m owner --gid-owner ci -j CI-OUT
  $t -A CI-OUT -o lo -p tcp -m multiport --dports 3333,3341,3391,3400:3420 -j REJECT
done
iptables -A CI-OUT -d 169.254.169.254 -j REJECT
EOS
chmod 755 /usr/local/sbin/ci-firewall
cat > /etc/systemd/system/ci-firewall.service <<'EOS'
[Unit]
Description=Firewall of the CI runners
Before=ci-runner@.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/ci-firewall
[Install]
WantedBy=multi-user.target
EOS

cat > /etc/systemd/system/ci.slice <<'EOS'
[Unit]
Description=CI runners (Topics comes first)
[Slice]
CPUWeight=20
MemoryHigh=22G
MemoryMax=26G
EOS
mkdir -p /etc/systemd/system/topics.service.d
printf '[Service]\nCPUWeight=500\n' > /etc/systemd/system/topics.service.d/precedenza.conf

# Kills what the job left behind: every process of this runner's cgroup that is not
# an ancestor of this hook (run.sh, Runner.Listener, Runner.Worker).
cat > /usr/local/bin/ci-job-done <<'EOS'
#!/bin/bash
cg=$(cut -d: -f3 /proc/self/cgroup)
keep=" "; p=$$
while [ "${p:-1}" -gt 1 ]; do keep="$keep$p "; p=$(awk '/^PPid/{print $2}' "/proc/$p/status" 2>/dev/null); done
for pid in $(cat "/sys/fs/cgroup$cg/cgroup.procs" 2>/dev/null); do
  case "$keep" in *" $pid "*) continue ;; esac
  kill -9 "$pid" 2>/dev/null || true
done
exit 0
EOS
chmod 755 /usr/local/bin/ci-job-done

cat > /etc/systemd/system/ci-runner@.service <<'EOS'
[Unit]
Description=GitHub runner %i of armonia/topics-app
After=network-online.target ci-firewall.service
Requires=ci-firewall.service
[Service]
User=ci%i
Group=ci
Slice=ci.slice
WorkingDirectory=/srv/runner-%i
Environment=HOME=/srv/rh-%i
Environment=SHELL=/bin/bash
Environment=ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/usr/local/bin/ci-job-done
ExecStart=/srv/runner-%i/run.sh
KillMode=control-group
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
EOS

V=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed 's/^v//')
tgz=/opt/actions-runner-$V.tar.gz
[ -f "$tgz" ] || curl -fsSL -o "$tgz" "https://github.com/actions/runner/releases/download/v$V/actions-runner-linux-x64-$V.tar.gz"

# i = 0 is the prep runner (label fisso-prep, one light job per run), 1..N take shards.
for i in 0 $(seq 1 "$N"); do
  u=ci$i
  id "$u" >/dev/null 2>&1 || useradd -M -d "/srv/rh-$i" -g ci -s /bin/bash "$u"
  mkdir -p "/srv/rh-$i" "/srv/runner-$i"
  chown "$u:ci" "/srv/rh-$i" "/srv/runner-$i"; chmod 700 "/srv/rh-$i" "/srv/runner-$i"
  if [ ! -f "/srv/runner-$i/.runner" ]; then
    tar xzf "$tgz" -C "/srv/runner-$i"
    [ "$i" = 0 ] && /srv/runner-0/bin/installdependencies.sh >/var/log/ci-runner-deps.log 2>&1
    chown -R "$u:ci" "/srv/runner-$i"
    l=fisso; [ "$i" = 0 ] && l=fisso-prep
    su -s /bin/bash "$u" -c "cd /srv/runner-$i && ./config.sh --unattended --url '$URL' --token '$REG_TOKEN' \
      --name topics-fisso-$i --labels $l --no-default-labels --replace" >"/var/log/ci-runner-$i.log" 2>&1
  fi
done
systemctl daemon-reload
systemctl enable --now ci-firewall.service >/dev/null
systemctl set-property --runtime topics.service CPUWeight=500 2>/dev/null || true
for i in 0 $(seq 1 "$N"); do systemctl enable --now "ci-runner@$i.service" >/dev/null; done
echo "runner pronti: 0 (prep) e 1..$N"
