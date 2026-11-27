# Running a Windows PC as a Topics node

One page, eight steps. The scripts are in this folder. Everything that varies
between installations is an environment variable, with an empty default that works:

| Variable | Meaning | Default |
|---|---|---|
| `TOPICS_NODE_SSH` | `user@host` of the PC, as seen from the paired machine | required for the scripts that run there |
| `TOPICS_NODE_DIR` | node folder on the PC | `C:\topics-node` |
| `TOPICS_NODE_WAKE_CMD` | shell command that wakes the PC before a card | empty = no wake-up |
| `TOPICS_NODE_MACHINE_ID`, `TOPICS_NODE_MAC_DB` | PC's id and the paired Topics' database, to avoid updating the node while a card runs | empty = trust the live processes |

1. **PC: install and register the node.**
   Prerequisite: the PC needs a global git identity (`git config --global user.name` and `user.email`), otherwise the node's cards cannot commit and the delivery comes out empty.
   Copy this folder to `%TOPICS_NODE_DIR%` (`node-prep --maintenance` does it for you), run `install-node.ps1 -Version <x.y.z>` from an *Interactive* scheduled task (over ssh the NSIS installer fails silently), then `register-node.ps1` (task "topics-node", at boot, no window) and `register-card-jail.ps1`.
   A release with the MCP bridge fix needs nothing else; `bin\topics-server.exe` is only for a build compiled from a branch (`build-from-branch.sh`).

2. **Paired machine: model proxy and tunnel.**
   Put `TOPICS_MODEL_PROXY_PORT=3391` in the Topics server environment (applies from its next restart).
   Keep `node-tunnel` running under your service manager: `-L 3393` to the PC's 3341, `-R 3394` from the PC to the proxy on 3391.

3. **Pairing.**
   - Paired machine: `POST /api/machines/pair {"baseUrl":"http://127.0.0.1:3393"}` returns a code.
   - PC: `GET /api/auth/pair/pending`, then `POST /api/auth/pair/approve {requestId}` on `127.0.0.1:3333` (from loopback you are the owner).
   - Paired machine: `GET /api/machines/pair/<pairingId>` returns the machine; rename it with `PATCH /api/machines/<id> {name}`.

4. **Model token.**
   From the paired machine `POST /api/machines/<id>/model-token`: it is shown once.
   Write it to `%TOPICS_NODE_DIR%\model.env` (`ANTHROPIC_BASE_URL=http://127.0.0.1:3394`, `ANTHROPIC_AUTH_TOKEN=...`) and restart the node's server.
   The token never goes into a file of the repo.

5. **Tools and version (automatic).**
   `deploy/node-tools.txt` is the single list of tools of a work machine: `pc-tools.ps1` reads it (winget/npm on the PC) and so does `deploy/cloud-node/node-pool` (apt/npm). Before every card `node-prep` installs what is missing (once a day or when the list changes) and, with no claude/codex alive on the node, updates Topics to the latest release through the Interactive task `topics-node-update` (`update-node.ps1`).
   Bar: `node-prep --bar` (exit 0 = tools complete and latest version). By hand: `node-prep --maintenance`.

6. **Hook.**
   `~/.topics/hooks.json`: event `node-run` runs `python3 <this folder>/node-prep`, `timeoutMs` 300000.
   For nodes that are not the PC (Cloud Claude) the script exits 0.

7. **Board.**
   `PATCH /api/boards/<boardId>/settings {"dispatchMachineId":"<id>"}`. It applies to new cards only.
   Set it only on git boards whose work lives on the default branch: the node always starts from origin/HEAD.

8. **Sleep and reboot.**
   Whatever keeps the PC awake or asleep should count cards in progress on the node as work. `restart-on-boot.ps1` (`-Fix` to repair) checks that the PC comes back reachable by itself after a reboot: sshd and Tailscale automatic, port 22 open on every profile, node and jail starting at boot with no logon. `win-node-watchdog*.ps1` relaunches the server if it hangs.
