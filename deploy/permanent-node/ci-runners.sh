#!/bin/bash
# GitHub runners of armonia/topics-app on the permanent node (topics-permanent-node), next to the Topics node.
#
#   node-pool permanent-ci    from the Mac: asks GitHub for a registration and a removal token
#                             and runs this file as root over ssh with REG_TOKEN, REMOVE_TOKEN
#                             and N in the environment
#
# Idempotent: a runner already configured is only (re)started. The registration token
# is used once by config.sh and never written to disk; afterwards each runner holds only
# its own runner credentials.
#
# Why each piece:
# - one Linux user per runner (group `ci`), never root: the Topics node on this box
#   trusts loopback as its owner, and a CI job must not reach it, nor the Mac's model
#   proxy behind the ssh tunnel (3301), its agent browser (CDP 19222), nor
#   /home/topics (iptables by group, home 0700). Nor TAKE its ports: a job holding
#   3333 when topics.service restarts would push the node onto a random port outside
#   the firewall and answer the Mac's tunnel itself, so every port below 3342 is
#   privileged (SocketBindDeny would do it per unit, but Ubuntu 24.04's systemd has
#   no BPF and ignores it in silence: measured on topics-permanent-node, 11/11);
# - persistent runners: caches in each HOME (bun, Playwright browsers) survive between
#   jobs, and no admin token lives here to re-register ephemeral ones;
# - HOME=/srv/rh-<i>: ci.yml derives the e2e port band from it (13910 + (i-1)*10);
# - ci.slice with a low CPU weight and a memory ceiling: Topics cards come first;
# - a job-completed hook kills what a job left running in the runner's cgroup.
set -euo pipefail
: "${REG_TOKEN:?registration token}"
pending=0
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

# Firewall: the ci group cannot reach the Topics node (3333 http, 3341 tunnel listener,
# 3302 its agent browser, 3303-3340 its previews), the reverse tunnel to the Mac's model
# proxy (3301), 19222 nor the metadata service. The e2e test servers use 13910-13949, CDP 19910-19949 and the
# preview pool 3400-3450, which must stay open (run 42930031047, RECAPTURE-01).
cat > /usr/local/sbin/ci-firewall <<'EOS'
#!/bin/bash
for t in iptables ip6tables; do
  $t -N CI-OUT 2>/dev/null || $t -F CI-OUT
  $t -C OUTPUT -m owner --gid-owner ci -j CI-OUT 2>/dev/null || $t -I OUTPUT -m owner --gid-owner ci -j CI-OUT
  $t -A CI-OUT -o lo -p tcp -m multiport --dports 3301:3341,19222 -j REJECT
done
iptables -A CI-OUT -d 169.254.169.254 -j REJECT
# From the internet only ssh comes in: the e2e test servers listen on *:139xx.
for t in iptables ip6tables; do
  $t -N PERMANENT-IN 2>/dev/null || $t -F PERMANENT-IN
  $t -C INPUT -j PERMANENT-IN 2>/dev/null || $t -I INPUT -j PERMANENT-IN
  $t -A PERMANENT-IN -i lo -j RETURN
  $t -A PERMANENT-IN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  $t -A PERMANENT-IN -p tcp --dport 22 -j RETURN
  $t -A PERMANENT-IN -p tcp -j DROP
done
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
# The node answers only on loopback (the Mac comes through the ssh tunnel): a server made
# from an older recipe listened on *:3333, on the public address.
printf '[Service]\nEnvironment=SERVER_HOST=127.0.0.1\n' > /etc/systemd/system/topics.service.d/locale.conf
# Its agent browser and its previews below 3342 too: privileged ports the runners can
# neither take nor reach. The e2e servers keep CDP 199xx and previews 3400-3450.
printf '[Service]\nEnvironment=TOPICS_CDP_PORT=3302\nEnvironment=TOPICS_PREVIEW_PORTS=3303-3340\n' > /etc/systemd/system/topics.service.d/porte-nodo.conf

# Kills what the job left behind: every process of this runner's cgroup that is not
# an ancestor of this hook (run.sh, Runner.Listener, Runner.Worker).
cat > /usr/local/bin/ci-job-done.sh <<'EOS'
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
chmod 755 /usr/local/bin/ci-job-done.sh

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
Environment=ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/usr/local/bin/ci-job-done.sh
ExecStart=/srv/runner-%i/run.sh
KillMode=control-group
# A /tmp of its own: the test servers use fixed paths there (/tmp/topics-mcp), and one
# runner user creating them locks the others out with EACCES (run 42926274612, shard 1).
PrivateTmp=yes
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
EOS

V=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed 's/^v//')
tgz=/opt/actions-runner-$V.tar.gz
[ -f "$tgz" ] || curl -fsSL -o "$tgz" "https://github.com/actions/runner/releases/download/v$V/actions-runner-linux-x64-$V.tar.gz"

# i = 0 is the prep runner (label permanent-prep, one light job per run), 1..N take shards.
for i in 0 $(seq 1 "$N"); do
  u=ci$i
  id "$u" >/dev/null 2>&1 || useradd -M -d "/srv/rh-$i" -g ci -s /bin/bash "$u"
  mkdir -p "/srv/rh-$i" "/srv/runner-$i"
  chown "$u:ci" "/srv/rh-$i" "/srv/runner-$i"; chmod 700 "/srv/rh-$i" "/srv/runner-$i"
  name="topics-permanent-node-$i"
  # A runner registered under another name (the server had an Italian name until 12/11):
  # GitHub cannot rename a runner, so the old registration goes and a new one comes.
  # A busy runner keeps its job; the next run of this script renames it.
  if [ -f "/srv/runner-$i/.runner" ] && [ "$(jq -r .agentName "/srv/runner-$i/.runner")" != "$name" ]; then
    if pgrep -u "$u" -x Runner.Worker >/dev/null; then
      echo "runner $i busy: not renamed, run this again" >&2; pending=1; continue
    fi
    systemctl stop "ci-runner@$i.service"
    (cd "/srv/runner-$i" && ACTIONS_RUNNER_INPUT_TOKEN=${REMOVE_TOKEN:-} runuser -u "$u" -- ./config.sh remove) >>"/var/log/ci-runner-$i.log" 2>&1 \
      || rm -f "/srv/runner-$i/.runner" "/srv/runner-$i/.credentials" "/srv/runner-$i/.credentials_rsaparams"
  fi
  if [ ! -f "/srv/runner-$i/.runner" ]; then
    [ -x "/srv/runner-$i/config.sh" ] || tar xzf "$tgz" -C "/srv/runner-$i"
    [ "$i" = 0 ] && /srv/runner-0/bin/installdependencies.sh >/var/log/ci-runner-deps.log 2>&1
    chown -R "$u:ci" "/srv/runner-$i"
    l=permanent; [ "$i" = 0 ] && l=permanent-prep
    # The token goes through the environment (ACTIONS_RUNNER_INPUT_TOKEN), not argv:
    # /proc/<pid>/environ is readable only by that user, a command line by everybody.
    (cd "/srv/runner-$i" && ACTIONS_RUNNER_INPUT_TOKEN=$REG_TOKEN runuser -u "$u" -- ./config.sh --unattended \
      --url "$URL" --name "$name" --labels "$l" --no-default-labels --replace) >"/var/log/ci-runner-$i.log" 2>&1
  fi
done
systemctl daemon-reload
systemctl enable ci-firewall.service >/dev/null
systemctl restart ci-firewall.service  # a re-run must apply the rules it just wrote
systemctl set-property --runtime topics.service CPUWeight=500 2>/dev/null || true
# A unit changed by a re-run of this script takes effect on restart: only idle runners,
# a busy one would lose its job (the next re-run catches it).
for i in 0 $(seq 1 "$N"); do
  systemctl enable "ci-runner@$i.service" >/dev/null
  pgrep -u "ci$i" -x Runner.Worker >/dev/null || systemctl restart "ci-runner@$i.service"
done

# Ports below 3342 privileged (3301, 3333, 3341 are the node's), Topics with the
# capability to bind its own. The proof binds a FREE port of the range as a runner
# would: probing 3333 itself says nothing, the node already holds it (EADDRINUSE).
echo 'net.ipv4.ip_unprivileged_port_start=3342' > /etc/sysctl.d/60-ci-ports.conf
sysctl -q -p /etc/sysctl.d/60-ci-ports.conf
printf '[Service]\nAmbientCapabilities=CAP_NET_BIND_SERVICE\n' > /etc/systemd/system/topics.service.d/porte.conf
systemctl daemon-reload
if runuser -u ci1 -- python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 3340))' 2>/dev/null; then
  echo "un runner può prendere le porte del nodo Topics: fermo" >&2; exit 1
fi
if ! runuser -u ci1 -- python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 3449))' 2>/dev/null; then
  echo "un runner non può aprire le porte delle anteprime (3400-3450): fermo" >&2; exit 1
fi
echo "porte del nodo Topics chiuse ai runner"
[ "$pending" = 0 ] || exit 3
