/**
 * The subject a window has in front, as the server hears it in the `focus`
 * frame (notifications-redesign, ATTN-06): an epoch born on a subject in front
 * of an awake window is born seen. The holders stack (a remount overlaps the
 * release), the last one is the subject in front, and a change is announced
 * so `useWebSocket` sends the frame again.
 *
 * Under bun there is no document, so `isWindowAwake()` answers true: the
 * awake half is the e2e's.
 *
 * @covers ATTN-06, CHAT-DONE-01
 */
import { afterEach, describe, expect, test } from "bun:test";
import { holdSubjectInFront, isSubjectInFront, onSubjectInFrontChange, subjectInFront } from "./chatInView";

const releases: Array<() => void> = [];
afterEach(() => {
  while (releases.length) releases.pop()!();
});

describe("the subject in front", () => {
  test("a held subject is in front until its release", () => {
    const release = holdSubjectInFront("topic:front");
    expect(subjectInFront()).toBe("topic:front");
    expect(isSubjectInFront("topic:front")).toBe(true);
    expect(isSubjectInFront("topic:behind")).toBe(false);
    release();
    expect(subjectInFront()).toBeNull();
    expect(isSubjectInFront("topic:front")).toBe(false);
  });

  test("two holders of the same subject: in front until both are released", () => {
    const a = holdSubjectInFront("topic:twice");
    const b = holdSubjectInFront("topic:twice");
    a();
    expect(isSubjectInFront("topic:twice")).toBe(true);
    b();
    expect(isSubjectInFront("topic:twice")).toBe(false);
  });

  test("the last holder is the subject in front; releasing it gives the front back to the one before", () => {
    releases.push(holdSubjectInFront("topic:chat"));
    const drawer = holdSubjectInFront("terminal:t1");
    expect(subjectInFront()).toBe("terminal:t1");
    drawer();
    expect(subjectInFront()).toBe("topic:chat");
  });

  test("a change of the subject in front is announced, a release of a covered holder is not", () => {
    let changes = 0;
    const off = onSubjectInFrontChange(() => { changes++; });
    const a = holdSubjectInFront("topic:a");
    const b = holdSubjectInFront("topic:b");
    expect(changes).toBe(2);
    a(); // `b` is still in front
    expect(changes).toBe(2);
    b();
    expect(changes).toBe(3);
    off();
  });
});
