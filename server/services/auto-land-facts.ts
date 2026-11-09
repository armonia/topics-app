/**
 * What the automatic land reads off the database that is not a card: the board's
 * workflow and the model an agent runs. Kept out of the router so that file does
 * not grow for it (`check:bloat`).
 */
import type { Database } from "bun:sqlite";
import { AGENT_AUTHOR_PREFIX } from "../../shared/comment-author";
import { STAGE_AI_REVIEW, workflowHasStage } from "../../shared/workflow";
import { readBoardWorkflow } from "./board-workflow";

/** Does the board's workflow have the AI review column? Without one, server code is a person's. */
export function boardHasAiReview(db: Database, projectId: string): boolean {
  return workflowHasStage(readBoardWorkflow(db, projectId).columns, STAGE_AI_REVIEW);
}

/** The model an agent identity (`agent:<topicId>`) runs; a missing topic row or column is "cannot be told". */
export function topicModelOf(db: Database): (author: string) => string | null {
  return (author) => {
    if (!author.startsWith(AGENT_AUTHOR_PREFIX)) return null;
    try {
      const row = db.query("SELECT model FROM topics WHERE id = ?").get(author.slice(AGENT_AUTHOR_PREFIX.length)) as { model?: string | null } | null;
      return row?.model ?? null;
    } catch { return null; }
  };
}
