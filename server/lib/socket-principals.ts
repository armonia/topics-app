import type { Database } from "bun:sqlite";
import { frameResource, isGuestSafeFrameType, isGuestSocketData } from "./grants";
import { hasGrant } from "./grants-query";
import { principalsRev, resolvePrincipals } from "./principals";
import type { WSData } from "../types";

type Db = Pick<Database, "query">;

/** Refreshes the identity held by an open socket after a principals change. */
export function refreshSocketPrincipal(db: Db, data: WSData): void {
  if (!data.deviceId) return;
  const rev = principalsRev(db);
  if (data.principal?.rev === rev) return;
  const resolved = resolvePrincipals(db, data.deviceId);
  data.principal = { principals: resolved.list, confined: resolved.confined, rev: resolved.rev };
}

/** Applies the same guest frame policy using the socket's current principals. */
export function socketMayReceiveFrame(db: Db, data: WSData, message: unknown): boolean {
  refreshSocketPrincipal(db, data);
  if (!isGuestSocketData(data)) return true;
  const type = (message as { type?: unknown } | null)?.type;
  if (typeof type !== "string" || !isGuestSafeFrameType(type)) return false;
  const resource = frameResource(message);
  return !!resource && !!data.principal
    && hasGrant(db, data.principal.principals, resource.type, resource.id);
}

/** Applies topic fan-out policy using the socket's current principals. */
export function socketMayReadTopic(db: Db, data: WSData, topicId: string): boolean {
  refreshSocketPrincipal(db, data);
  return !isGuestSocketData(data) || (!!data.principal
    && hasGrant(db, data.principal.principals, "topic", topicId));
}
