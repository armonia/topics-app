/**
 * Whether a `git status --porcelain` XY code is a merge conflict: both added
 * (`AA`), both deleted (`DD`), or a `U` on either side (`UU AU UA UD DU`).
 * One definition for the server and the client.
 */
export function isConflicted(status: string): boolean {
  return status === "AA" || status === "DD" || status[0] === "U" || status[1] === "U";
}
