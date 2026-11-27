/**
 * Shared state and helpers used by the task service core and by every
 * `server/services/tasks/*.ts` sibling module. The helpers live in the
 * `shared-*.ts` factories (one per responsibility); this file composes them
 * and keeps the surface the siblings import.
 */

import type { Database } from "bun:sqlite";
import type { ServiceOpts } from "../tasks";
import { createSharedCore } from "./shared-core";
import { createSharedDeliveryClaims } from "./shared-delivery-claims";
import { createSharedPreviews } from "./shared-previews";
import { createSharedChildren } from "./shared-children";
import { createSharedCardRead } from "./shared-card-read";
import { createSharedTaskMapping } from "./shared-task-mapping";

export * from "./shared-constants";

export function createTasksShared(db: Database, opts: ServiceOpts) {
  const core = createSharedCore(db, opts);
  const deliveryClaims = createSharedDeliveryClaims(db, opts, core);
  const children = createSharedChildren(db, core);
  const cardRead = createSharedCardRead(db, core);
  const previews = createSharedPreviews(db, core, cardRead);
  const taskMapping = createSharedTaskMapping(db, opts, core, previews, cardRead);

  const merged = { ...core, ...deliveryClaims, ...previews, ...children, ...cardRead, ...taskMapping };
  return {
    bindService: merged.bindService,
    CARD_COMMENTS_DEPTH: merged.CARD_COMMENTS_DEPTH,
    CARD_COMMENT_CHARS: merged.CARD_COMMENT_CHARS,
    CARD_CONTEXT_CHARS: merged.CARD_CONTEXT_CHARS,
    CHILD_OWN_WORK_SQL: merged.CHILD_OWN_WORK_SQL,
    DELIVERY_CLAIM_SLOT: merged.DELIVERY_CLAIM_SLOT,
    DESCRIPTION_PREVIEW_CHARS: merged.DESCRIPTION_PREVIEW_CHARS,
    FENCE: merged.FENCE,
    MAX_ANCESTOR_DEPTH: merged.MAX_ANCESTOR_DEPTH,
    PREVIEWABLE_MEDIA: merged.PREVIEWABLE_MEDIA,
    PREVIEW_SLIDES_MAX: merged.PREVIEW_SLIDES_MAX,
    QUESTION_FENCE: merged.QUESTION_FENCE,
    SQL_IS_DELIVERY: merged.SQL_IS_DELIVERY,
    SQL_MIA: merged.SQL_MIA,
    SQL_PAROLA: merged.SQL_PAROLA,
    VIDEO_MEDIA: merged.VIDEO_MEDIA,
    agentAskOnThread: merged.agentAskOnThread,
    annotateDeliveryClaims: merged.annotateDeliveryClaims,
    anteprimaUtile: merged.anteprimaUtile,
    archiveSubtree: merged.archiveSubtree,
    assertBlockerValid: merged.assertBlockerValid,
    assertNoLiveDependents: merged.assertNoLiveDependents,
    awaitingAnswerFor: merged.awaitingAnswerFor,
    baseName: merged.baseName,
    buildBatch: merged.buildBatch,
    cardCommentContent: merged.cardCommentContent,
    cardCommentsFor: merged.cardCommentsFor,
    checkedStage: merged.checkedStage,
    childLeftFlight: merged.childLeftFlight,
    commentOriginColumn: merged.commentOriginColumn,
    countOpenChildren: merged.countOpenChildren,
    deliveryGeneration: merged.deliveryGeneration,
    digestCache: merged.digestCache,
    drawsCardComments: merged.drawsCardComments,
    duplicatePreviewOf: merged.duplicatePreviewOf,
    ensureDeliverySheet: merged.ensureDeliverySheet,
    fileDigest: merged.fileDigest,
    fileExists: merged.fileExists,
    getTaskRow: merged.getTaskRow,
    hasActiveChildren: merged.hasActiveChildren,
    hasChildrenInFlight: merged.hasChildrenInFlight,
    hasFreshAgentComment: merged.hasFreshAgentComment,
    heavyInFlight: merged.heavyInFlight,
    idParam: merged.idParam,
    isParentAlive: merged.isParentAlive,
    labelsFor: merged.labelsFor,
    lastTurnStart: merged.lastTurnStart,
    lastWordOfThread: merged.lastWordOfThread,
    liveCardGaps: merged.liveCardGaps,
    logStatus: merged.logStatus,
    mapRow: merged.mapRow,
    markReopened: merged.markReopened,
    noteDuplicatePreview: merged.noteDuplicatePreview,
    now: merged.now,
    openerNameQuery: merged.openerNameQuery,
    openerOf: merged.openerOf,
    topicBrief: merged.topicBrief,
    parkedChildren: merged.parkedChildren,
    parkedQuestionStillStanding: merged.parkedQuestionStillStanding,
    previewImagesFor: merged.previewImagesFor,
    previewOf: merged.previewOf,
    promoteReviewPreview: merged.promoteReviewPreview,
    queueReasonOf: merged.queueReasonOf,
    rankQueue: merged.rankQueue,
    readGlobalDispatch: merged.readGlobalDispatch,
    rejectedPaths: merged.rejectedPaths,
    releaseContainerFromCardContract: merged.releaseContainerFromCardContract,
    resolveGuestActor: merged.resolveGuestActor,
    resolveSubtaskWork: merged.resolveSubtaskWork,
    reviewAskFallback: merged.reviewAskFallback,
    reviewNote: merged.reviewNote,
    writeSystemDeliveryAsk: merged.writeSystemDeliveryAsk,
    rowToComment: merged.rowToComment,
    rowToTask: merged.rowToTask,
    rowsToTasks: merged.rowsToTasks,
    settleReviewApproval: merged.settleReviewApproval,
    stageColumn: merged.stageColumn,
    supportsCommentOrigin: merged.supportsCommentOrigin,
    tasksHaveStage: merged.tasksHaveStage,
    tooTallForCard: merged.tooTallForCard,
    topicsCols: merged.topicsCols,
    topicsColumns: merged.topicsColumns,
    topicsHasEffort: merged.topicsHasEffort,
    topicsHasModel: merged.topicsHasModel,
    uuid: merged.uuid,
    withSubtaskCounts: merged.withSubtaskCounts,
    writeDeliverySheet: merged.writeDeliverySheet,
  };
}
