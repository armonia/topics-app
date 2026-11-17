/**
 * The HTTP and WebSocket front door: the server options both listeners are built from. The request path itself lives in
 * `server/routes/` (front-door.ts and the doors it composes).
 */
import { createFrontDoor } from "../routes/front-door";
import type { AfterHttp } from "./scope";

export function bootFront(scope: AfterHttp) {
  const opzioniServer = createFrontDoor(scope);
  return { opzioniServer };
}
