"""logind-stale-sessions --check against stubbed loginctl/systemctl (card e809a470).

Run: python3 -m unittest test_logind_stale_sessions (from deploy/cloud-node).
"""
import os
import stat
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "logind-stale-sessions")

SESSIONS = """SESSION  UID USER SEAT TTY STATE   IDLE SINCE
   7201    0 root -    -   closing no   -
  25439    0 root -    -   closing no   -
  26322    0 root -    -   active  no   -
"""


def stub(d, name, body):
    p = os.path.join(d, name)
    with open(p, "w") as f:
        f.write("#!/bin/sh\n" + body)
    os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)


class Check(unittest.TestCase):
    def run_check(self, active_scopes):
        with tempfile.TemporaryDirectory() as d:
            stub(d, "loginctl", f"cat <<'EOF'\n{SESSIONS}EOF\n")
            units = "".join(f"session-{s}.scope loaded active running Session {s}\n" for s in active_scopes)
            stub(d, "systemctl", f"printf '%s' '{units}'\n")
            env = {**os.environ, "PATH": f"{d}:{os.environ['PATH']}"}
            return subprocess.run(["bash", SCRIPT, "--check"], capture_output=True, text=True, env=env)

    def test_closing_session_whose_scope_is_gone_fails(self):
        r = self.run_check(["7201", "26322"])
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn("stale closing sessions: 1", r.stdout)
        self.assertIn("25439", r.stdout)

    def test_closing_session_with_a_live_scope_is_not_stale(self):
        # a closing session that still runs processes (e.g. a mount helper) is legitimate
        r = self.run_check(["7201", "25439", "26322"])
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("stale closing sessions: 0", r.stdout)


if __name__ == "__main__":
    unittest.main()
