/**
 * The contract of `<APP_DATA_DIR>/machines-health.json`: what the tray reads
 * about every machine Topics uses. Another component parses this format, so it
 * must not change without changing that component too.
 */

export type SecurityStatus = "ok" | "warn" | "problem" | "unknown";
/** `info` is a note that does not weigh on the verdict (e.g. an unencrypted system disk on a server). */
export type CheckStatus = SecurityStatus | "info";
export type CheckKey = "updates" | "disk" | "access" | "antivirus";

/** A sentence the client words in its own language: `code` picks the text, `params` fill it. */
export interface CheckMsg {
  code: string;
  params?: Record<string, string | number>;
}

export interface SecurityCheck {
  key: CheckKey;
  status: CheckStatus;
  /** One sentence in Italian (the tray and the alerts read it), 60 characters at most, no command names. */
  detail: string;
  /** The same sentence as parts the client words by code, joined with ", ". Absent on a file written before this field existed: `detail` is shown then. */
  msgs?: CheckMsg[];
}

export interface MachineSecurity {
  /** Epoch seconds of the last round that managed to read the machine; null if it never was read. */
  checked_at: number | null;
  status: SecurityStatus;
  checks: SecurityCheck[];
}

export interface MachineHistory {
  step_s: number;
  /** Epoch seconds of the first point. */
  from: number;
  cpu: Array<number | null>;
  mem: Array<number | null>;
}

export interface MachineHealthEntry {
  id: string;
  name: string;
  kind: "local" | "remote";
  security: MachineSecurity;
  history: MachineHistory;
  /** 24 integers: cards run on the machine today, index = local hour. */
  cards_today: number[];
}

export interface MachinesHealthFile {
  /** Epoch seconds of the write. */
  at: number;
  machines: MachineHealthEntry[];
}

/**
 * What the "access" check was built from. A Linux node sends it along with the
 * report so the computer that collects the data can rebuild the sentence once
 * it has measured the ports from outside (the node's own `ufw` does not see a
 * firewall the cloud provider puts in front of it).
 */
export interface AccessFacts {
  ssh: { kind: "on"; password: boolean | null } | { kind: "off" } | { kind: "unknown"; why: string };
  /** Ports the machine listens on besides 22, loopback excluded; `null` if they could not be read. */
  ports: number[] | null;
  firewall: boolean | "unknown" | null;
  /** A Linux server with no open ports has nothing to filter: a firewall that is off is not a warning. */
  linuxServer: boolean;
  /** Ports measured from OUTSIDE (a TCP connection from another computer); set only by the collector. */
  providerFirewall?: { open: number[] };
}

/** What a machine's server answers to `GET /api/system/machine-security`. */
export interface MachineSecurityReport {
  checked_at: number;
  status: SecurityStatus;
  checks: SecurityCheck[];
  /** Present on Linux nodes; not written to `machines-health.json`. */
  access_facts?: AccessFacts;
}
