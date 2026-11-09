/** Work the Mac sent to the PC and how earlier work ended, as the PC's sleep keeper reports it. One declaration for the server and the load screen. */

export interface ScreenJob {
  project: string | null;
  what: string;
  who: string | null;
  since: number | null;
}

export interface ScreenOutcome {
  project: string | null;
  what: string;
  /** true = it passed, false = it failed, null = interrupted or an outcome the file did not name. */
  ok: boolean | null;
  /** Stopped before its end (the keeper's `interrotto`: the ssh went away, a signal). allow-italian: the keeper's wire value */
  interrupted: boolean;
  seconds: number | null;
  endedAt: number | null;
}
