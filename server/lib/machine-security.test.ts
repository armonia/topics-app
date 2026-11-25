/**
 * @covers MACHINE-05
 */
import { describe, expect, test } from "bun:test";
import {
  clip, composeAccess, countFailedLogins, findDeclaredPrivate, iptablesBlocksInput, lastMacSecurityUpdate, lastXProtect, nftBlocksInput, parseAptHistory,
  parseAptSecurityPending, parseAutopatchLog, parseFileVault, parseGocryptfsMounts, parseKeyValueLines, parseMacFirewall,
  parseMacInstallHistory, parseMacPendingUpdates, parseNetstatListening, parseSshdConfig, parseSshdT, parseSsListening,
  powershellArgv, probeMachineSecurity, probeUnavailableReport, whyNoAnswer, worstStatus, DETAIL_MAX, FAILED_LOGIN_PATTERN,
  type ProbeEnv, type RunResult,
} from "./machine-security";

// Output recorded on the real machines (trimmed).
const MAC_HISTORY = `[
  0 => {
    "date" => 2022-11-10 15:35:07 +0000
    "displayName" => "macOS 13.0"
    "displayVersion" => "13.0"
    "processName" => "softwareupdated"
  }
  1 => {
    "date" => 2022-11-10 15:37:07 +0000
    "displayName" => "Setup macOS Recovery Dependencies"
    "displayVersion" => ""
    "packageIdentifiers" => [
      0 => "com.apple.pkg.RecoveryDeps"
    ]
  }
  2 => {
    "date" => 2025-12-24 14:23:03 +0000
    "displayName" => "macOS Tahoe 26.2"
    "displayVersion" => "26.2"
    "processName" => "softwareupdated"
  }
  3 => {
    "contentType" => "config-data"
    "date" => 2026-11-04 04:26:33 +0000
    "displayName" => "XProtectPlistConfigData"
    "displayVersion" => "5371"
    "processName" => "softwareupdated"
  }
  4 => {
    "contentType" => "config-data"
    "date" => 2026-11-10 22:29:15 +0000
    "displayName" => "XProtectPlistConfigData"
    "displayVersion" => "5372"
    "processName" => "softwareupdated"
  }
]`;

const MAC_SU = `{
  "AutomaticDownload" => true
  "FirstOfferDateDictionary" => {
    "MSU_UPDATE_25G332_patch_26.7.2_minor" => 2026-10-26 22:25:07 +0000
    "MSU_UPDATE_25G342_patch_26.7.3_minor" => 2026-11-09 22:26:15 +0000
    "MSU_UPDATE_26B131_patch_27.2.1_major" => 2026-11-09 22:26:15 +0000
  }
  "LastUpdatesAvailable" => 2
  "RecommendedUpdates" => [
    0 => {
      "Display Name" => "macOS Tahoe 26.7.3"
      "Identifier" => "MSU_UPDATE_25G342_patch_26.7.3_minor"
      "MobileSoftwareUpdate" => true
    }
    1 => {
      "Display Name" => "Formati video professionali"
      "Identifier" => "ProVideoFormats"
    }
    2 => {
      "Display Name" => "macOS 27.2.1"
      "Identifier" => "MSU_UPDATE_26B131_patch_27.2.1_major"
    }
  ]
}`;

const MAC_SU_CLEAN = MAC_SU.replace(/ {4}0 => \{[\s\S]*?\n {4}\}\n/, "");

const NETSTAT = `Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)
tcp4       0      0  127.0.0.1.56013        *.*                    LISTEN
tcp46      0      0  *.8100                 *.*                    LISTEN
tcp6       0      0  ::1.5421               *.*                    LISTEN
tcp4       0      0  *.22                   *.*                    LISTEN
tcp4       0      0  192.168.1.9.9100       *.*                    LISTEN
tcp4       0      0  192.168.1.9.51234      10.0.0.1.443           ESTABLISHED`;

const SS = `LISTEN 0      4096   127.0.0.53%lo:53   0.0.0.0:*
LISTEN 0      512        127.0.0.1:3303 0.0.0.0:*
LISTEN 0      4096         0.0.0.0:22   0.0.0.0:*
LISTEN 0      4096      127.0.0.54:53   0.0.0.0:*
LISTEN 0      4096            [::]:22      [::]:*
LISTEN 0      128             [::1]:631     [::]:*
LISTEN 0      128                *:8080        *:*`;

// `iptables -S` of an Ubuntu 24.04 server with ufw inactive (addresses and chain names made generic):
// INPUT jumps to NODE-IN, whose last rule drops every TCP packet not let through above; the REJECTs
// in the chains jumped from OUTPUT guard outgoing traffic and are not an input firewall.
const IPTABLES_NODE = `-P INPUT ACCEPT
-P FORWARD ACCEPT
-P OUTPUT ACCEPT
-N CI-OUT
-N APPB-OUT
-N NODE-IN
-N APPA-OUT
-N APP-PROTECT
-A INPUT -j NODE-IN
-A OUTPUT -m owner --gid-owner 1001 -j APP-PROTECT
-A OUTPUT -m owner --gid-owner 1002 -j APPA-OUT
-A OUTPUT -m owner --gid-owner 1003 -j APPB-OUT
-A OUTPUT -m owner --gid-owner 1001 -j CI-OUT
-A CI-OUT -o lo -p tcp -m multiport --dports 3301:3341,19222 -j REJECT --reject-with icmp-port-unreachable
-A CI-OUT -d 192.0.2.1/32 -j REJECT --reject-with icmp-port-unreachable
-A APPB-OUT -o lo -p tcp -m multiport --dports 3301:3341,3400:3450,13910:13979,19222,19910:19949 -j REJECT --reject-with icmp-port-unreachable
-A APPB-OUT -d 192.0.2.1/32 -j REJECT --reject-with icmp-port-unreachable
-A NODE-IN -i lo -j RETURN
-A NODE-IN -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A NODE-IN -p tcp -m tcp --dport 22 -j RETURN
-A NODE-IN -p tcp -j DROP
-A APPA-OUT -o lo -p tcp -m multiport --dports 3301:3341,3400:3450,13910:13949,19222,19910:19949 -j REJECT --reject-with icmp-port-unreachable
-A APPA-OUT -d 192.0.2.1/32 -j REJECT --reject-with icmp-port-unreachable
-A APP-PROTECT -o lo -p tcp -m tcp --dport 13960:13979 -j REJECT --reject-with icmp-port-unreachable
`;

// Eight ports bound on every address, plus SSH: what the same server lists with `ss -ltnH`.
const SS_NODE = ["LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*", ...[13910, 13911, 13920, 13921, 13930, 13931, 13940, 13941].map((p) => `LISTEN 0 511 *:${p} *:*`)].join("\n");

const NOW = Date.parse("2026-11-17T12:00:00Z");

const res = (stdout = "", over: Partial<RunResult> = {}): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false, missing: false, ...over });
const MISSING: RunResult = { code: null, stdout: "", stderr: "", timedOut: false, missing: true };
const TIMEOUT: RunResult = { code: null, stdout: "", stderr: "", timedOut: true, missing: false };

function envOf(platform: NodeJS.Platform, answers: Record<string, RunResult | ((argv: string[]) => RunResult)>, files: Record<string, string | number> = {}): ProbeEnv {
  return {
    platform,
    now: () => NOW,
    appDataDir: "/data",
    run: async (argv) => {
      const hit = Object.entries(answers).find(([k]) => argv.join(" ").startsWith(k));
      if (!hit) return MISSING;
      return typeof hit[1] === "function" ? hit[1](argv) : hit[1];
    },
    readFile: async (p) => (typeof files[p] === "string" ? (files[p] as string) : null),
    listDir: async (p) => {
      const names = Object.keys(files).filter((f) => f.startsWith(`${p}/`)).map((f) => f.slice(p.length + 1));
      return names.length ? names : null;
    },
    mtimeMs: async (p) => (typeof files[p] === "number" ? (files[p] as number) : null),
  };
}

const psOut = (...lines: string[]) => res(`#< CLIXML\n${lines.join("\n")}\n<Objs Version="1.1.0.1"><Obj S="progress"/></Objs>`);

describe("parser macOS", () => {
  test("storia delle installazioni: ultima voce di sicurezza e XProtect, senza i pacchetti di servizio", () => {
    const h = parseMacInstallHistory(MAC_HISTORY);
    expect(h).toHaveLength(5);
    expect(lastMacSecurityUpdate(h)?.name).toBe("XProtectPlistConfigData");
    expect(lastXProtect(h)).toEqual({ version: "5372", at: Date.parse("2026-11-10T22:29:15Z") });
    // "Setup macOS Recovery Dependencies" is not an update
    expect(lastMacSecurityUpdate(h.filter((x) => !/XProtect/.test(x.name)))?.name).toBe("macOS Tahoe 26.2");
  });

  test("aggiornamenti in attesa: solo le correzioni (_minor), con la data in cui sono state offerte", () => {
    expect(parseMacPendingUpdates(MAC_SU)).toEqual([
      { id: "MSU_UPDATE_25G342_patch_26.7.3_minor", offeredAt: Date.parse("2026-11-09T22:26:15Z") },
    ]);
    expect(parseMacPendingUpdates(MAC_SU_CLEAN)).toEqual([]);
  });

  test("aggiornamenti in attesa: con la versione installata l'età è la prima correzione saltata, non l'ultima offerta", () => {
    // On 26.2 the Mac skipped 26.7.2 (26/10) before 26.7.3 (09/11): behind since 26/10.
    expect(parseMacPendingUpdates(MAC_SU, "26.2\n")).toEqual([
      { id: "MSU_UPDATE_25G342_patch_26.7.3_minor", offeredAt: Date.parse("2026-10-26T22:25:07Z") },
    ]);
    // Already on 26.7.2: only 26.7.3 is missing, its own offer date. A _major never counts.
    expect(parseMacPendingUpdates(MAC_SU, "26.7.2")).toEqual([
      { id: "MSU_UPDATE_25G342_patch_26.7.3_minor", offeredAt: Date.parse("2026-11-09T22:26:15Z") },
    ]);
    // An unreadable version falls back to the pending fix's own offer.
    expect(parseMacPendingUpdates(MAC_SU, "boh")[0]?.offeredAt).toBe(Date.parse("2026-11-09T22:26:15Z"));
  });

  test("FileVault e firewall", () => {
    expect(parseFileVault("FileVault is On.\n")).toBe("on");
    expect(parseFileVault("FileVault is Off.\n")).toBe("off");
    expect(parseFileVault("Encryption in progress: Percent completed = 12")).toBe("working");
    expect(parseFileVault("boh")).toBeNull();
    expect(parseMacFirewall("Firewall is enabled. (State = 1)")).toBe(true);
    expect(parseMacFirewall("Firewall is disabled. (State = 0)")).toBe(false);
  });

  test("porte in ascolto da netstat: solo quelle raggiungibili da fuori", () => {
    expect(parseNetstatListening(NETSTAT)).toEqual([22, 8100, 9100]);
  });
});

describe("parser Linux e comuni", () => {
  test("ss: scarta loopback e resolver locale", () => {
    expect(parseSsListening(SS)).toEqual([22, 8080]);
  });

  test("sshd -T e file di configurazione", () => {
    expect(parseSshdT("port 22\npasswordauthentication no\nkbdinteractiveauthentication no")).toBe(false);
    expect(parseSshdT("passwordauthentication yes")).toBe(true);
    expect(parseSshdT("sshd: no hostkeys available -- exiting.")).toBeNull();
    expect(parseSshdConfig("# c\nPasswordAuthentication no\n")).toBe(false);
    // OpenSSH's default accepts the password; a Match block does not count
    expect(parseSshdConfig("UsePAM yes\n")).toBe(true);
    expect(parseSshdConfig("Match Group administrators\n  PasswordAuthentication no\n")).toBe(true);
    expect(parseSshdConfig("#PasswordAuthentication yes\nPasswordAuthentication no")).toBe(false);
  });

  test("registro dell'autopatch, storia di apt, pendenti di sicurezza", () => {
    const log = `2026-11-13T06:59:01+00:00 aggiornati: libc6=2.39\n2026-11-13T06:59:01+00:00 riavvio ora (in attesa da 0 min)\n2026-11-17T06:05:45+00:00 aggiornati: gstreamer=1.24\n`;
    expect(parseAutopatchLog(log)).toBe(Date.parse("2026-11-17T06:05:45+00:00"));
    expect(parseAutopatchLog("niente\n")).toBeNull();
    expect(parseAptHistory("Start-Date: 2026-11-16  19:41:48\nEnd-Date: 2026-11-16  19:41:52\n\nEnd-Date: 2026-11-17  06:05:41\n")).toBe(Date.parse("2026-11-17T06:05:41Z"));
    const apt = `Listing...\napparmor/noble-updates 4.0 amd64 [upgradable from: 4.0.7]\nopenssl/noble-security 3.0 amd64 [upgradable from: 3.0.1]\n`;
    expect(parseAptSecurityPending(apt)).toBe(1);
  });

  test("accessi falliti: conta le righe giuste e rispetta la finestra di 24 ore", () => {
    const text = [
      "Nov 16 12:11:52 host sshd[1]: Invalid user lorin from 2.57.121.112 port 41978",
      "Nov 16 12:11:53 host sshd[1]: Connection closed by invalid user lorin 2.57.121.112 port 41978 [preauth]",
      "Nov 16 12:12:00 host sshd[2]: Failed password for root from 1.2.3.4 port 22 ssh2",
      "Nov 16 12:12:01 host sshd[2]: Failed password for root from 1.2.3.4 port 22 ssh2",
      "Nov 16 12:13:00 host sshd[3]: Accepted publickey for root from 5.6.7.8",
    ].join("\n");
    expect(countFailedLogins(text)).toBe(2);
    const iso = `2026-11-15T10:00:00.000000+00:00 h sshd[1]: Failed password for x\n2026-11-17T10:00:00.000000+00:00 h sshd[1]: Failed password for y\n`;
    expect(countFailedLogins(iso, NOW - 86_400_000)).toBe(1);
  });

  test("failed logins: OpenSSH 9.8+ journal lines (sshd-session, pam_unix) count once per process", () => {
    const text = [
      "Nov 21 03:01:00 h sshd-session[901]: Invalid user admin from 203.0.113.7 port 1",
      "Nov 21 03:01:02 h sshd-session[901]: pam_unix(sshd:auth): authentication failure; logname= uid=0 rhost=203.0.113.7",
      "Nov 21 03:01:04 h sshd-session[901]: Failed password for invalid user admin from 203.0.113.7 port 1 ssh2",
      "Nov 21 03:05:00 h sshd-session[902]: Failed publickey for root from 203.0.113.8 port 2 ssh2",
      "-- No entries --",
    ].join("\n");
    expect(countFailedLogins(text)).toBe(2);
    expect(countFailedLogins("")).toBe(0);
  });

  test("gocryptfs: punti di mount e cartella dichiarata, a qualunque profondità", () => {
    expect(parseGocryptfsMounts("gocryptfs /home/u/private fuse.gocryptfs rw 0 0\n/dev/sda1 / ext4 rw 0 0\n")).toEqual(["/home/u/private"]);
    expect(findDeclaredPrivate({ targets: [{ name: "a", private: "/home/u/private" }] })).toBe("/home/u/private");
    expect(findDeclaredPrivate({ target: { private: { path: "/p" } } })).toBe("/p");
    expect(findDeclaredPrivate({ target: { private: true } })).toBe(true);
    expect(findDeclaredPrivate({ target: { x: 1 } })).toBeNull();
  });

  test("righe chiave=valore di PowerShell: il rumore si ignora", () => {
    expect(parseKeyValueLines("#< CLIXML\nhotfix=KB1|Security Update|2026-11-12\n<Objs Version=\"1\">x=y</Objs>\nreboot=False")).toEqual([["hotfix", "KB1|Security Update|2026-11-12"], ["reboot", "False"]]);
  });

  test("lo script di PowerShell viaggia in base64 UTF-16", () => {
    const argv = powershellArgv("'a=1'");
    expect(argv.slice(0, 4)).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(Buffer.from(argv[4], "base64").toString("utf16le")).toContain("'a=1'");
  });
});

describe("stato peggiore e frasi", () => {
  test("il peggiore dei check, info non conta, unknown non sporca", () => {
    expect(worstStatus([{ status: "ok" }, { status: "warn" }, { status: "problem" }])).toBe("problem");
    expect(worstStatus([{ status: "ok" }, { status: "warn" }])).toBe("warn");
    expect(worstStatus([{ status: "ok" }, { status: "info" }])).toBe("ok");
    expect(worstStatus([{ status: "ok" }, { status: "unknown" }])).toBe("ok");
    expect(worstStatus([{ status: "unknown" }, { status: "info" }])).toBe("unknown");
    expect(worstStatus([])).toBe("unknown");
  });

  test("le frasi stanno nel limite del contratto", () => {
    expect(clip("x".repeat(100)).length).toBe(DETAIL_MAX);
    expect(clip("breve")).toBe("breve");
  });

  test("perché un comando non ha risposto", () => {
    expect(whyNoAnswer(MISSING)).toBe("comando non disponibile");
    expect(whyNoAnswer(TIMEOUT)).toBe("nessuna risposta in tempo");
    expect(whyNoAnswer(res("", { code: 1, stderr: "ERROR: You need to be root" }))).toBe("permessi insufficienti");
  });

  test("accessi: la parte peggiore per prima", () => {
    const c = composeAccess({ ssh: { kind: "on", password: true }, ports: [9100], firewall: true, linuxServer: false });
    expect(c.status).toBe("problem");
    expect(c.detail.startsWith("SSH accetta la password")).toBe(true);
    expect(composeAccess({ ssh: { kind: "on", password: false }, ports: [5432], firewall: true, linuxServer: false }).status).toBe("warn");
    // a server with no open ports has nothing to filter
    const quietServer = composeAccess({ ssh: { kind: "on", password: false }, ports: [], firewall: false, linuxServer: true });
    expect(quietServer.status).toBe("ok");
    expect(composeAccess({ ssh: { kind: "off" }, ports: [8100], firewall: false, linuxServer: false }).status).toBe("warn");
  });
});

describe("giro completo per sistema", () => {
  test("macOS: aggiornamento offerto da 8 giorni = avviso, il resto ok o con la sua frase", async () => {
    const env = envOf("darwin", {
      "plutil -p /Library/Receipts": res(MAC_HISTORY),
      "plutil -p /Library/Preferences": res(MAC_SU),
      "fdesetup status": res("FileVault is On.\n"),
      netstat: res(NETSTAT),
      "/usr/libexec/ApplicationFirewall/socketfilterfw": res("Firewall is enabled. (State = 1)"),
      log: res("Timestamp Ty Process\n2026-11-17 sshd Failed password\n"),
    }, { "/etc/ssh/sshd_config": "Include /etc/ssh/sshd_config.d/*\n", "/etc/ssh/sshd_config.d/100-macos.conf": "UsePAM yes\n" });
    const r = await probeMachineSecurity(env);
    const by = Object.fromEntries(r.checks.map((c) => [c.key, c]));
    expect(r.checked_at).toBe(NOW / 1000);
    expect(by.updates.status).toBe("warn");
    expect(by.updates.detail).toBe("1 aggiornamento in attesa da 7 giorni");
    expect(by.disk.status).toBe("ok");
    // OpenSSH on without `PasswordAuthentication no`: it accepts the password
    expect(by.access.status).toBe("problem");
    expect(by.access.detail).toContain("SSH accetta la password");
    expect(by.antivirus.detail).toBe("XProtect 5372 del 10/11, 1 accessi falliti in 24 ore".replace("1 accessi", "1 accessi"));
    expect(r.status).toBe("problem");
    for (const c of r.checks) expect(c.detail.length).toBeLessThanOrEqual(DETAIL_MAX);
  });

  test("macOS senza aggiornamenti in attesa: l'ultimo di sicurezza, FileVault spento = avviso", async () => {
    const env = envOf("darwin", {
      "plutil -p /Library/Receipts": res(MAC_HISTORY),
      "plutil -p /Library/Preferences": res(MAC_SU_CLEAN),
      "fdesetup status": res("FileVault is Off.\n"),
      netstat: res(NETSTAT.replace("*.22 ", "*.2222")),
      "/usr/libexec/ApplicationFirewall/socketfilterfw": res("Firewall is disabled. (State = 0)"),
    });
    const r = await probeMachineSecurity(env);
    const by = Object.fromEntries(r.checks.map((c) => [c.key, c]));
    expect(by.updates.detail).toBe("Ultimo aggiornamento di sicurezza il 10/11");
    expect(by.disk.status).toBe("warn");
    expect(by.access.status).toBe("warn");
    expect(by.antivirus.detail).toBe("XProtect 5372 del 10/11, accesso remoto spento");
  });

  test("Linux server (utente senza privilegi): config letta dai file, log non leggibili = unknown, privato non dichiarato = info", async () => {
    const env = envOf("linux", {
      "sshd -T": res("", { code: 1, stderr: "sshd: no hostkeys available -- exiting." }),
      "ss -ltnH": res(SS.split("\n").slice(0, 5).join("\n")),
      "ufw status": res("", { code: 1, stderr: "ERROR: You need to be root to run this script" }),
      "apt list": res("Listing...\napparmor/noble-updates 4.0 amd64 [upgradable from: 4.0.7]\n"),
      journalctl: res("Hint: You are currently not seeing messages from other users and the system.\n"),
    }, {
      "/etc/ssh/sshd_config": "Include /etc/ssh/sshd_config.d/*.conf\n",
      "/etc/ssh/sshd_config.d/10-keys-only.conf": "PasswordAuthentication no\n",
      "/etc/ufw/ufw.conf": "ENABLED=no\n",
      "/var/log/security-autopatch.log": "2026-11-17T06:05:45+00:00 aggiornati: gstreamer=1\n",
    });
    const r = await probeMachineSecurity(env);
    const by = Object.fromEntries(r.checks.map((c) => [c.key, c]));
    expect(by.updates).toMatchObject({ status: "ok", detail: "Ultimo aggiornamento di sicurezza il 17/11" });
    expect(by.disk).toMatchObject({ status: "info", detail: "Disco di sistema non cifrato" });
    expect(by.access.status).toBe("ok");
    expect(by.access.detail).toBe("Solo chiave SSH, nessuna porta aperta, firewall spento");
    expect(by.antivirus.status).toBe("unknown");
    expect(by.antivirus.detail).toBe("Accessi falliti: registri non leggibili da questo utente");
    expect(r.status).toBe("ok");
  });

  test("Linux con cartella privata gocryptfs: aperta = ok, chiusa = info; password SSH aperta con tentativi = avviso", async () => {
    const base = {
      "sshd -T": res("passwordauthentication yes\n"),
      "ss -ltnH": res(SS),
      "ufw status": res("Status: active\n"),
      "apt list": res("Listing...\n"),
      journalctl: res("Nov 17 sshd[1]: Failed password for root from 1.2.3.4\n"),
    };
    const files = { "/data/harness-sync.json": JSON.stringify({ targets: [{ private: "/home/u/private" }] }), "/var/log/apt/history.log": "End-Date: 2026-11-16  06:00:00\n" };
    const open = await probeMachineSecurity(envOf("linux", base, { ...files, "/proc/mounts": "gocryptfs /home/u/private fuse.gocryptfs rw 0 0\n" }));
    expect(open.checks.find((c) => c.key === "disk")).toMatchObject({ status: "ok", detail: "Dati privati in cartella cifrata, aperta" });
    const closed = await probeMachineSecurity(envOf("linux", base, { ...files, "/proc/mounts": "/dev/sda1 / ext4 rw 0 0\n" }));
    expect(closed.checks.find((c) => c.key === "disk")?.status).toBe("info");
    expect(closed.checks.find((c) => c.key === "access")?.status).toBe("problem");
    expect(closed.checks.find((c) => c.key === "antivirus")?.status).toBe("warn");
  });

  test("Linux: avviso se ci sono correzioni di sicurezza in attesa e l'ultimo giro è vecchio, o riavvio fermo da giorni", async () => {
    const pending = res("Listing...\nopenssl/noble-security 3.0 amd64 [upgradable from: 3.0.1]\n");
    const old = { "/var/log/apt/history.log": "End-Date: 2026-11-01  06:00:00\n" };
    const a = await probeMachineSecurity(envOf("linux", { "apt list": pending }, old));
    expect(a.checks.find((c) => c.key === "updates")).toMatchObject({ status: "warn", detail: "1 aggiornamento di sicurezza in attesa da 16 giorni" });
    const b = await probeMachineSecurity(envOf("linux", { "apt list": res("Listing...\n") }, { ...old, "/var/run/reboot-required": NOW - 9 * 86_400_000 }));
    expect(b.checks.find((c) => c.key === "updates")).toMatchObject({ status: "warn", detail: "Riavvio in attesa da 9 giorni per gli aggiornamenti" });
    // SEC-01: reboot-required older than 24 h warns
    const stale = await probeMachineSecurity(envOf("linux", { "apt list": res("Listing...\n") }, { ...old, "/var/run/reboot-required": NOW - 25 * 3_600_000 }));
    expect(stale.checks.find((c) => c.key === "updates")).toMatchObject({ status: "warn", detail: "Riavvio in attesa da 1 giorno per gli aggiornamenti" }); // allow-italian: asserts the user-facing sentence
    const fresh = await probeMachineSecurity(envOf("linux", { "apt list": res("Listing...\n") }, { ...old, "/var/run/reboot-required": NOW - 23 * 3_600_000 }));
    expect(fresh.checks.find((c) => c.key === "updates")?.status).toBe("ok");
  });

  test("Windows: KB di sicurezza, BitLocker spento, SSH con password, Defender", async () => {
    const env = envOf("win32", {
      "powershell.exe": (argv) => {
        const script = Buffer.from(argv[4], "base64").toString("utf16le");
        if (script.includes("QuickFixEngineering")) return psOut("hotfix=KB5132061|Security Update|2026-11-12", "hotfix=KB5127690|Update|2026-10-15", "reboot=False");
        if (script.includes("BitLockerProtection")) return psOut("bitlocker=2");
        if (script.includes("Get-NetFirewallProfile")) return psOut("fw=Domain|True", "fw=Private|True", "fw=Public|True", "listen=445", "listen=22", "listen=47990", "sshd=present", "cfg=#PasswordAuthentication yes", "cfg=Subsystem sftp sftp-server.exe");
        if (script.includes("Get-MpComputerStatus")) return psOut("av=True|True|2026-11-17|1.463.339.0", "failed=0");
        return MISSING;
      },
    });
    const r = await probeMachineSecurity(env);
    const by = Object.fromEntries(r.checks.map((c) => [c.key, c]));
    expect(by.updates).toMatchObject({ status: "ok", detail: "Ultimo aggiornamento di sicurezza il 12/11" });
    expect(by.disk).toMatchObject({ status: "warn", detail: "Disco non cifrato (BitLocker spento)" });
    expect(by.access.status).toBe("problem");
    expect(by.antivirus).toMatchObject({ status: "ok", detail: "Defender attivo, firme del 17/11, 0 accessi falliti" });
  });

  test("Windows: BitLocker mai acceso risponde 0 ed è un disco non cifrato, non una risposta sconosciuta", async () => {
    const disk = async (answer: string) => (await probeMachineSecurity(envOf("win32", {
      "powershell.exe": (argv) => Buffer.from(argv[4], "base64").toString("utf16le").includes("BitLockerProtection") ? psOut(answer) : MISSING,
    }))).checks.find((c) => c.key === "disk");
    expect(await disk("bitlocker=0")).toMatchObject({ status: "warn", detail: "Disco non cifrato (BitLocker spento)" });
    // an empty answer (no BitLocker at all) stays unknown: nothing was read
    expect((await disk("bitlocker="))?.status).toBe("unknown");
  });

  test("Windows: protezione in tempo reale spenta = problema; riavvio in attesa = avviso", async () => {
    const env = envOf("win32", {
      "powershell.exe": (argv) => {
        const script = Buffer.from(argv[4], "base64").toString("utf16le");
        if (script.includes("QuickFixEngineering")) return psOut("hotfix=KB1|Security Update|2026-11-12", "reboot=True");
        if (script.includes("Get-MpComputerStatus")) return psOut("av=True|False|2026-11-17|1.0", "failed=?");
        return MISSING;
      },
    });
    const r = await probeMachineSecurity(env);
    expect(r.checks.find((c) => c.key === "antivirus")).toMatchObject({ status: "problem", detail: "Protezione in tempo reale spenta" });
    expect(r.checks.find((c) => c.key === "updates")?.status).toBe("warn");
    // disk and access: missing command = unknown with the sentence saying why
    expect(r.checks.find((c) => c.key === "disk")).toMatchObject({ status: "unknown", detail: "Cifratura del disco: comando non disponibile" });
  });

  test("comando mancante o scaduto: unknown con il perché, il giro non si rompe", async () => {
    const mac = await probeMachineSecurity(envOf("darwin", { "fdesetup status": TIMEOUT }));
    expect(mac.checks).toHaveLength(4);
    expect(mac.checks.find((c) => c.key === "disk")).toMatchObject({ status: "unknown", detail: "Cifratura del disco: nessuna risposta in tempo" });
    expect(mac.checks.find((c) => c.key === "updates")?.status).toBe("unknown");
    expect(mac.status).toBe("unknown");
    const exotic = await probeMachineSecurity(envOf("freebsd", {}));
    expect(exotic.checks.every((c) => c.status === "unknown")).toBe(true);
    const throwing: ProbeEnv = { ...envOf("linux", {}), run: async () => { throw new Error("boom"); } };
    const t = await probeMachineSecurity(throwing);
    expect(t.checks).toHaveLength(4);
    // without commands only file reads remain: a server's disk is a note, not a fault
    expect(t.checks.filter((c) => c.key !== "disk").every((c) => c.status === "unknown")).toBe(true);
  });
});

describe("Linux firewall written straight into the kernel", () => {
  test("iptables: a catch-all DROP reached from INPUT through a jump guards the machine", () => {
    expect(iptablesBlocksInput(IPTABLES_NODE)).toBe(true);
    // Without the jump from INPUT the same DROP guards nothing that comes in.
    expect(iptablesBlocksInput(IPTABLES_NODE.replace("-A INPUT -j NODE-IN\n", ""))).toBe(false);
  });

  test("iptables: INPUT policy DROP blocks, ACCEPT and RETURN alone do not", () => {
    expect(iptablesBlocksInput("-P INPUT DROP\n-P FORWARD DROP\n-P OUTPUT ACCEPT\n-A INPUT -i lo -j ACCEPT\n")).toBe(true);
    expect(iptablesBlocksInput("-P INPUT ACCEPT\n-N GUARD\n-A INPUT -j GUARD\n-A GUARD -i lo -j RETURN\n-A GUARD -p tcp -m tcp --dport 22 -j ACCEPT\n-A GUARD -j RETURN\n")).toBe(false);
  });

  test("iptables: a DROP on one port, or reached only from OUTPUT, is not an input firewall", () => {
    expect(iptablesBlocksInput("-P INPUT ACCEPT\n-A INPUT -p tcp -m tcp --dport 5432 -j DROP\n")).toBe(false);
    expect(iptablesBlocksInput("-P INPUT ACCEPT\n-N OUT-GUARD\n-A OUTPUT -j OUT-GUARD\n-A OUT-GUARD -p tcp -j DROP\n")).toBe(false);
  });

  test("iptables: a rule on one interface matches only that interface, whatever its target", () => {
    // Tailscale's chain, jumped first from INPUT, trusts the VPN interface: the DROP after it still guards the rest.
    expect(iptablesBlocksInput([
      "-P INPUT ACCEPT", "-N ts-input", "-A INPUT -j ts-input", "-A INPUT -i lo -j ACCEPT",
      "-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT", "-A INPUT -p tcp -m tcp --dport 22 -j ACCEPT", "-A INPUT -j DROP",
      "-A ts-input -s 100.64.0.0/10 ! -i tailscale0 -j DROP", "-A ts-input -i tailscale0 -j ACCEPT", "",
    ].join("\n"))).toBe(true);
    expect(iptablesBlocksInput("-P INPUT DROP\n-A INPUT -i wg0 -j ACCEPT\n-A INPUT -p tcp -m tcp --dport 22 -j ACCEPT\n")).toBe(true);
    // A DROP on a bridge or a private interface leaves the public one open.
    expect(iptablesBlocksInput("-P INPUT ACCEPT\n-A INPUT -i docker0 -j DROP\n")).toBe(false);
    expect(iptablesBlocksInput("-P INPUT ACCEPT\n-A INPUT -i ens10 -j DROP\n")).toBe(false);
  });

  test("iptables: an ACCEPT for every packet lets it through before any later DROP or DROP policy", () => {
    expect(iptablesBlocksInput("-P INPUT ACCEPT\n-A INPUT -j ACCEPT\n-A INPUT -j DROP\n")).toBe(false);
    expect(iptablesBlocksInput("-P INPUT DROP\n-A INPUT -p tcp -j ACCEPT\n")).toBe(false);
  });

  test("iptables: a goto does not come back, a comment narrows nothing", () => {
    // Out of the goto target the packet meets INPUT's policy, never the DROP after the goto.
    expect(iptablesBlocksInput("-P INPUT ACCEPT\n-N SOME\n-A INPUT -g SOME\n-A INPUT -p tcp -j DROP\n-A SOME -p tcp -m tcp --dport 22 -j ACCEPT\n")).toBe(false);
    expect(iptablesBlocksInput('-P INPUT ACCEPT\n-A INPUT -m comment --comment "open for now -j DROP" -j ACCEPT\n-A INPUT -j DROP\n')).toBe(false);
    expect(iptablesBlocksInput("-P INPUT ACCEPT\n-A INPUT -m comment --comment drop-all -j DROP\n")).toBe(true);
  });

  test("nft: an input hook with policy drop or a trailing bare drop blocks, policy accept alone does not", () => {
    const chain = (head: string, ...rules: string[]) => `table inet filter {\n\tchain input {\n\t\t${head}\n${rules.map((r) => `\t\t${r}\n`).join("")}\t}\n\tchain output {\n\t\ttype filter hook output priority filter; policy accept;\n\t}\n}\n`;
    expect(nftBlocksInput(chain("type filter hook input priority filter; policy drop;", "ct state established,related accept", "tcp dport { 22, 443 } accept"), "ip")).toBe(true);
    expect(nftBlocksInput(chain("type filter hook input priority filter; policy accept;", "tcp dport 22 accept"), "ip")).toBe(false);
    expect(nftBlocksInput(chain("type filter hook input priority filter; policy accept;", "tcp dport 22 accept", "counter packets 12 bytes 720 drop"), "ip")).toBe(true);
    // A bare accept takes every packet: a drop after it is never reached.
    expect(nftBlocksInput(chain("type filter hook input priority filter; policy accept;", "accept", "drop"), "ip")).toBe(false);
  });

  test("nft: a table guards only its own address family, inet guards both", () => {
    const drop = (family: string, policy = "drop") => `table ${family} filter {\n\tchain input {\n\t\ttype filter hook input priority filter; policy ${policy};\n\t}\n}\n`;
    const both = (text: string) => [nftBlocksInput(text, "ip"), nftBlocksInput(text, "ip6")];
    expect(both(drop("inet"))).toEqual([true, true]);
    expect(both(drop("ip"))).toEqual([true, false]);
    expect(both(drop("ip6"))).toEqual([false, true]);
    // ARP has an input hook too, but it filters ARP frames, not IP packets.
    expect(both(drop("arp"))).toEqual([false, false]);
    expect(both(`${drop("ip6")}${drop("ip", "accept")}`)).toEqual([false, true]);
  });

  // The measured server: ufw inactive, INPUT of both families jumps to the same dropping chain.
  const NODE_ANSWERS = {
    "sshd -T": res("passwordauthentication no\n"),
    "ss -ltnH": res(SS_NODE),
    "ufw status": res("Status: inactive\n"),
    "iptables -S": res(IPTABLES_NODE),
    "ip6tables -S": res(IPTABLES_NODE),
  };
  const OPEN = res("-P INPUT ACCEPT\n-P FORWARD ACCEPT\n-P OUTPUT ACCEPT\n");

  test("ufw inactive but iptables drops: the access facts say firewall on and the check is ok", async () => {
    const on = await probeMachineSecurity(envOf("linux", NODE_ANSWERS));
    expect(on.access_facts?.firewall).toBe(true);
    expect(on.checks.find((c) => c.key === "access")).toMatchObject({ status: "ok", detail: "Solo chiave SSH, 8 porte aperte, firewall acceso" });
    // Readable rules that let everything in: the firewall is off, not unknown.
    const off = await probeMachineSecurity(envOf("linux", { ...NODE_ANSWERS, "iptables -S": OPEN, "ip6tables -S": OPEN }));
    expect(off.access_facts?.firewall).toBe(false);
  });

  test("a firewall on IPv4 alone is off: the ports bound on every address answer over IPv6", async () => {
    const v4only = await probeMachineSecurity(envOf("linux", { ...NODE_ANSWERS, "ip6tables -S": OPEN }));
    expect(v4only.access_facts?.firewall).toBe(false);
    expect(v4only.checks.find((c) => c.key === "access")).toMatchObject({ status: "warn", detail: "Firewall spento, solo chiave SSH, 8 porte aperte" });
    // An nftables table of the inet family guards both, with nothing in iptables.
    const bothFamilies = "table inet filter {\n\tchain input {\n\t\ttype filter hook input priority filter; policy drop;\n\t}\n}\n";
    const native = await probeMachineSecurity(envOf("linux", { ...NODE_ANSWERS, "iptables -S": OPEN, "ip6tables -S": OPEN, "nft list ruleset": res(bothFamilies) }));
    expect(native.access_facts?.firewall).toBe(true);
  });
});

describe("Linux failed logins filtered on the machine", () => {
  const KEYS_ONLY = { "sshd -T": res("passwordauthentication no\n") };
  const antivirus = async (answers: Record<string, RunResult | ((argv: string[]) => RunResult)>) =>
    (await probeMachineSecurity(envOf("linux", { ...KEYS_ONLY, ...answers }))).checks.find((c) => c.key === "antivirus");
  const AUTH_LOG = [
    "2026-11-15T10:00:00.000000+00:00 srv sshd[7]: Failed password for root from 192.0.2.10 port 1 ssh2",
    "2026-11-17T09:00:00.000000+00:00 srv sshd[8]: Invalid user admin from 192.0.2.11 port 2",
    "2026-11-17T09:00:01.000000+00:00 srv sshd[8]: Failed password for invalid user admin from 192.0.2.11 port 2 ssh2",
    "2026-11-17T10:00:00.000000+00:00 srv sshd[9]: Failed publickey for root from 192.0.2.12 port 3 ssh2",
  ].join("\n");

  test("the journal answers with only the matching lines: two attempts", async () => {
    const seen: string[][] = [];
    const check = await antivirus({
      journalctl: (argv) => {
        seen.push(argv);
        return res("Nov 17 09:00:00 srv sshd[1]: Invalid user admin from 192.0.2.11\nNov 17 10:00:00 srv sshd[2]: Failed password for root from 192.0.2.12\n");
      },
    });
    expect(check).toMatchObject({ status: "ok", detail: "2 tentativi di accesso respinti in 24 ore" });
    expect(seen[0]).toContain("--grep");
    expect(seen[0][seen[0].indexOf("--grep") + 1]).toBe(FAILED_LOGIN_PATTERN);
  });

  test("journal with no match exits 1 with '-- No entries --': zero attempts, auth.log not read", async () => {
    let authLogRead = false;
    const check = await antivirus({
      journalctl: res("-- No entries --\n", { code: 1 }),
      grep: () => { authLogRead = true; return res("", { code: 2 }); },
    });
    expect(check).toMatchObject({ status: "ok", detail: "0 tentativi di accesso respinti in 24 ore" });
    expect(authLogRead).toBe(false);
  });

  test("journal killed at the deadline: auth.log filtered by grep, only the last 24 hours count", async () => {
    const seen: string[][] = [];
    const check = await antivirus({
      journalctl: { ...TIMEOUT },
      grep: (argv) => { seen.push(argv); return res(`${AUTH_LOG}\n`); },
    });
    expect(check).toMatchObject({ status: "ok", detail: "2 tentativi di accesso respinti in 24 ore" });
    // -a: a log with NUL bytes (unclean shutdown) is still read as text, not answered with "binary file matches".
    expect(seen[0]).toEqual(["grep", "-a", "-E", FAILED_LOGIN_PATTERN, "/var/log/auth.log"]);
  });

  test("grep exit 1 with nothing printed is zero attempts, not an unreadable log", async () => {
    const check = await antivirus({ journalctl: { ...TIMEOUT }, grep: res("", { code: 1 }) });
    expect(check).toMatchObject({ status: "ok", detail: "0 tentativi di accesso respinti in 24 ore" });
  });

  test("neither log readable: unknown", async () => {
    const check = await antivirus({
      journalctl: { ...TIMEOUT },
      grep: res("", { code: 2, stderr: "grep: /var/log/auth.log: Permission denied" }),
    });
    expect(check).toMatchObject({ status: "unknown", detail: "Accessi falliti: registri non leggibili da questo utente" });
  });
});

describe("nodo con build senza sonda", () => {
  test("riporta quattro unknown con l'ora, non silenzio", () => {
    const r = probeUnavailableReport(NOW);
    expect(r.checked_at).toBe(NOW / 1000);
    expect(r.status).toBe("unknown");
    expect(r.checks.map((c) => c.key)).toEqual(["updates", "disk", "access", "antivirus"]);
    for (const c of r.checks) expect(c.detail.length).toBeLessThanOrEqual(DETAIL_MAX);
  });
});
