/**
 * rrweb's live clock, driven by the DOM mirror (BROWSER-DOM-IDLE-01).
 *
 * A live rrweb replayer asks for an animation frame on every frame, forever,
 * and each one makes the renderer update. Its own `pause()` does nothing once
 * live (the player's state machine has no PAUSE there), and `destroy()` only
 * calls `pause()`: the mirror's park never stopped the clock, and a closed
 * mirror left it running. Measured 13/10 in WebKit: 60 frames a second from a
 * mirror idle for over a second. So the mirror stops and restarts the clock
 * itself, through the parts rrweb 2.0.0-alpha.4 (pinned) leaves reachable.
 */
interface LiveClock {
  raf: number | null;
  timeOffset: number;
  start(): void;
  clear(): void;
  toggleLiveMode(live: boolean): void;
}

interface LivePlayer {
  timer: LiveClock;
  service: { state: { context: { baselineTime: number; events: unknown[] } } };
}

const live = (replayer: object) => replayer as unknown as LivePlayer;

/** Lets the clock stop once it has applied what is due. Events still come in, and wait for `wakeClock`. */
export function parkClock(replayer: object): void {
  live(replayer).timer.toggleLiveMode(false);
}

/** Restarts the clock at the present, so whatever waited is applied on the next frame. */
export function wakeClock(replayer: object): void {
  const { timer, service } = live(replayer);
  // A clock still running out its queue must not end up running twice.
  if (timer.raf !== null) cancelAnimationFrame(timer.raf);
  timer.toggleLiveMode(true);
  timer.start();
  // `start` counts from zero; events are timed from the first one the replayer got.
  timer.timeOffset = Date.now() - service.state.context.baselineTime;
}

/** Stops the clock for good, which `destroy` does not. */
export function stopClock(replayer: object): void {
  live(replayer).timer.clear();
}

/**
 * Lets go of the events already handed to the replayer. rrweb keeps every one,
 * snapshots of every page included, to seek through a recording; a live
 * mirror never seeks.
 */
export function forgetHandedOver(replayer: object): void {
  const { events } = live(replayer).service.state.context;
  // The last one stays: rrweb compares against it to tell it has caught up.
  if (events.length > 1) events.splice(0, events.length - 1);
}
