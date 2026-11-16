/**
 * The scope each boot stage reads, built up stage by stage in server.ts.
 *
 * Every stage returns the bindings later stages read; the type of the scope a stage receives is the
 * intersection of what the stages before it returned, so a stage cannot name something that does not exist yet.
 */
import type { bootCore } from "./core";
import type { bootBrowser } from "./browser";
import type { bootTracker } from "./tracker";
import type { bootRoutersFirst } from "./routers-first";
import type { bootDispatchPrep } from "./dispatch-prep";
import type { bootHeadlessTurns } from "./headless-turns";
import type { bootDispatcher } from "./dispatcher";
import type { bootQuiescence } from "./quiescence";
import type { bootPreviewDelivery } from "./preview-delivery";
import type { bootTasksRouter } from "./tasks-router";
import type { bootRoutersSecond } from "./routers-second";
import type { bootHeartbeat } from "./heartbeat";
import type { bootTerminalsWs } from "./terminals-ws";
import type { bootBootSweeps } from "./boot-sweeps";
import type { bootHttp } from "./http";
import type { bootFront } from "./front";
import type { bootListen } from "./listen";
import type { bootGovernor } from "./governor";
import type { bootReattach } from "./reattach";
import type { bootDeliveryAudit } from "./delivery-audit";
import type { bootRelay } from "./relay";

/** What server.ts itself provides before the first stage. */
export type BaseScope = { rootDir: string; BOOT_COMMIT: string | null };
export type AfterCore = BaseScope & ReturnType<typeof bootCore>;
export type AfterBrowser = AfterCore & Awaited<ReturnType<typeof bootBrowser>>;
export type AfterTracker = AfterBrowser & ReturnType<typeof bootTracker>;
export type AfterRouters1 = AfterTracker & ReturnType<typeof bootRoutersFirst>;
export type AfterDispatchPrep = AfterRouters1 & ReturnType<typeof bootDispatchPrep>;
export type AfterHeadlessTurns = AfterDispatchPrep & ReturnType<typeof bootHeadlessTurns>;
export type AfterDispatcher = AfterHeadlessTurns & ReturnType<typeof bootDispatcher>;
export type AfterQuiescence = AfterDispatcher & ReturnType<typeof bootQuiescence>;
export type AfterPreviewDelivery = AfterQuiescence & ReturnType<typeof bootPreviewDelivery>;
export type AfterTasksRouter = AfterPreviewDelivery & ReturnType<typeof bootTasksRouter>;
export type AfterRouters2 = AfterTasksRouter & ReturnType<typeof bootRoutersSecond>;
export type AfterHeartbeat = AfterRouters2 & Awaited<ReturnType<typeof bootHeartbeat>>;
export type AfterTerminalsWs = AfterHeartbeat & ReturnType<typeof bootTerminalsWs>;
export type AfterBootSweeps = AfterTerminalsWs & Awaited<ReturnType<typeof bootBootSweeps>>;
export type AfterHttp = AfterBootSweeps & Awaited<ReturnType<typeof bootHttp>>;
export type AfterFront = AfterHttp & ReturnType<typeof bootFront>;
export type AfterListen = AfterFront & Awaited<ReturnType<typeof bootListen>>;
export type AfterGovernor = AfterListen & ReturnType<typeof bootGovernor>;
export type AfterReattach = AfterGovernor & ReturnType<typeof bootReattach>;
export type AfterDeliveryAudit = AfterReattach & ReturnType<typeof bootDeliveryAudit>;
export type AfterRelay = AfterDeliveryAudit & Awaited<ReturnType<typeof bootRelay>>;
