/** Work the Mac sent to the PC and how earlier work ended, as the PC's sleep keeper reports it. One declaration for the server and the load screen. */

export interface ScreenJob {
  /** The project as a person reads it on the machine's screen («Topics», «Armonia site»): a label, it does not name a Topics project. */
  project: string | null;
  /**
   * The repository the job was sent from: the folder of its main checkout, the same from every worktree. The one
   * thing that places the job on a session. Null on a job from a sender that does not write it yet.
   */
  repo: string | null;
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
