/**
 * The contract of `<APP_DATA_DIR>/machines-health.json`: what the tray reads
 * about every machine Topics uses. Another component parses this format, so it
 * must not change without changing that component too.
 */

export type SecurityStatus = "ok" | "warn" | "problem" | "unknown";
/** `info` is a note that does not weigh on the verdict (e.g. an unencrypted system disk on a server). */
export type CheckStatus = SecurityStatus | "info";
export type CheckKey = "updates" | "disk" | "access" | "antivirus";

export interface SecurityCheck {
  key: CheckKey;
  status: CheckStatus;
  /** One sentence in Italian (it is shown to the user), 60 characters at most, no command names. */
  detail: string;
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

/** What a machine's server answers to `GET /api/system/machine-security`. */
export interface MachineSecurityReport {
  checked_at: number;
  status: SecurityStatus;
  checks: SecurityCheck[];
}
