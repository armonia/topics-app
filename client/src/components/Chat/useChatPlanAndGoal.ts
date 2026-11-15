import { useState, useCallback, useMemo } from 'react';
import type { Topic, ChatMessage, AutonomyLevel } from '../../types';
import type { SendMessageOptions } from '../../hooks/useChat';
import { topicsApi, chatApi } from '../../lib/api';
import { errMessage } from '../../lib/errMessage';
import { PLAN_APPROVAL_QUESTION, PLAN_APPROVE_LABEL, PLAN_EDIT_KEY, PLAN_REJECT_LABEL } from '../../../../shared/plan-decision';
import { clearAskDraft, readAskDraft } from './askDraft';
import { findPendingPlan, planApprovalMessage } from './planDetection';
import type { useGoal } from '@/hooks/useGoal';
import type { useToast } from '../Shared/Toast';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

interface PlanAndGoalParams {
  topic: Topic;
  tr: Translate;
  toast: ReturnType<typeof useToast>;
  currentMessages: ChatMessage[];
  currentStreaming: boolean;
  currentLoading: boolean;
  autonomy: AutonomyLevel | null;
  setAutonomy: (level: AutonomyLevel | null) => void;
  sendMessage: (sk: string, content: string, options?: SendMessageOptions) => Promise<boolean>;
  closeGoal: ReturnType<typeof useGoal>['close'];
  declareGoal: ReturnType<typeof useGoal>['declare'];
  stopGoalLoop: ReturnType<typeof useGoal>['stopLoop'];
  promoteGoal: ReturnType<typeof useGoal>['promote'];
}

/** The plan approval bar's decisions and the goal bar's actions. */
export function useChatPlanAndGoal({
  topic, tr, toast, currentMessages, currentStreaming, currentLoading, autonomy, setAutonomy, sendMessage,
  closeGoal, declareGoal, stopGoalLoop, promoteGoal,
}: PlanAndGoalParams) {
  /**
   * The decision taken on the plan the turn proposed without being able to
   * deliver it (plan mode without `ExitPlanMode`, see server/lib/plan-approval.ts).
   *
   * Approving RAISES the chat's autonomy to `auto-apply`, and it stays there.
   * It is not a shortcut: `--permission-mode` is a SPAWN flag, so every change
   * restarts the CLI session. Granting it "for this turn only" would mean two
   * respawns per approval and a race with you if you touch the selector in the
   * meantime, while this way the change is ONE, visible in the selector, and
   * reversible whenever you want. The option says so plainly before you pick it.
   */
  // The plan waiting for an answer, if any: it feeds the bar above the
  // composer. Same reading as the inline panel (`findPendingAsk`), so the two
  // surfaces cannot say different things, plus the fallback on a plan written
  // only in prose, which has no row to attach to (`findPendingPlan`). In both
  // cases the choice is the same and does the same thing.
  const pendingPlan = useMemo(
    () => findPendingPlan({
      messages: currentMessages,
      autonomy,
      busy: currentStreaming || currentLoading,
    }),
    [currentMessages, autonomy, currentStreaming, currentLoading],
  );
  const [planBusy, setPlanBusy] = useState(false);

  const handlePlanDecision = useCallback(async (approved: boolean, editedPlan?: string) => {
    if (!approved) {
      sendMessage(topic.sessionKey, 'Piano rifiutato. Proponi un\'altra strada, sempre senza toccare niente.');
      return;
    }
    try {
      await topicsApi.update(topic.id, { autonomyLevel: 'auto-apply' });
      // The selector must show the TRUE level right away: approving a plan
      // raises the autonomy and it stays there, and reading it from `topic`
      // would mean waiting for the broadcast round.
      setAutonomy('auto-apply');
    } catch {
      // If the autonomy was not raised, sending the message would restart
      // the turn in the same trap: better to say so than to pretend.
      toast.error('Non sono riuscito ad alzare l\'autonomia: il piano non parte.');
      return;
    }
    // A plan corrected by hand goes out instead of the one the model wrote,
    // and the message says it REPLACES it: the session that resumes still
    // holds its own (`planApprovalMessage`).
    sendMessage(topic.sessionKey, planApprovalMessage(editedPlan));
  }, [sendMessage, topic.sessionKey, topic.id, toast, setAutonomy]);

  /** The choice taken from the bar above the composer: it records the answer,
   *  so the inline panel closes and the row stops waiting, and then does
   *  what the panel does. One road for two surfaces. */
  const handlePlanChoiceFromBar = useCallback(async (approved: boolean) => {
    if (!pendingPlan || planBusy) return;
    setPlanBusy(true);
    // The correction written in the panel counts from here too. Two surfaces
    // approving the same plan with different texts run, in silence, the
    // version nobody chose.
    const edited = pendingPlan.toolCallId
      ? readAskDraft(pendingPlan.toolCallId)?.planText?.trim() || undefined
      : undefined;
    try {
      // A plan written only in prose has no waiting row: there is nothing
      // to close, and posting an answer to a tool that does not exist would
      // return 404 and turn a valid choice into an error.
      if (pendingPlan.toolCallId) {
        await chatApi.toolResponse(topic.sessionKey, pendingPlan.toolCallId, {
          kind: 'questions',
          answers: { [PLAN_APPROVAL_QUESTION]: approved ? PLAN_APPROVE_LABEL : PLAN_REJECT_LABEL },
          ...(edited ? { metadata: { [PLAN_EDIT_KEY]: edited } } : {}),
          submittedAt: new Date().toISOString(),
        });
        // This branch never goes through `submitAndForget`, which is where
        // the draft is cleared: without this the correction would sit there
        // for seven days under a question already answered (ASK-07).
        clearAskDraft(pendingPlan.toolCallId);
      }
      await handlePlanDecision(approved, edited);
    } catch {
      toast.error('Non sono riuscito a registrare la scelta. Riprova.');
    } finally {
      setPlanBusy(false);
    }
  }, [pendingPlan, planBusy, topic.sessionKey, handlePlanDecision, toast]);

  // THE GOAL BAR'S ACTIONS SPEAK.
  //
  // `useGoal` does no optimistic update (a decision, see its docstring): with no
  // error on screen a refusal from the server drew the bar IDENTICAL to before,
  // which is also how a success draws it. A failed write now says so, and on the
  // rename the error is RE-THROWN towards `GoalBar`, because the edit field
  // stays open only if it sees the rejection.
  const handleGoalClose = useCallback(async (status: 'achieved' | 'abandoned') => {
    try {
      await closeGoal(status);
    } catch (err) {
      toast.error(errMessage(err) || tr('goal.closeFailed'));
    }
  }, [closeGoal, toast, tr]);

  const handleGoalEdit = useCallback(async (content: string) => {
    try {
      await declareGoal(content);
    } catch (err) {
      toast.error(errMessage(err) || tr('goal.editFailed'));
      throw err;
    }
  }, [declareGoal, toast, tr]);

  const handleGoalStopLoop = useCallback(async () => {
    try {
      await stopGoalLoop();
    } catch (err) {
      toast.error(errMessage(err) || tr('goal.actionFailed'));
    }
  }, [stopGoalLoop, toast, tr]);

  const handleGoalPromote = useCallback(async () => {
    try {
      await promoteGoal();
    } catch (err) {
      toast.error(errMessage(err) || tr('goal.actionFailed'));
    }
  }, [promoteGoal, toast, tr]);
  return {
    pendingPlan, planBusy, handlePlanDecision, handlePlanChoiceFromBar,
    handleGoalClose, handleGoalEdit, handleGoalStopLoop, handleGoalPromote,
  };
}
