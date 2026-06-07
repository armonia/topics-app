// Heuristic plan-response detector shared by MessageContent (gating PlanView
// render) and PlanView itself. Kept in a non-component module so React Fast
// Refresh treats the component file (PlanView.tsx) as components-only.
export function isPlanResponse(content: string): boolean {
  if (!content) return false;
  // Check for plan header (multiple variations) + numbered steps
  const hasPlanHeader = /^##?\s+(?:(?:Implementation|Action|Execution|Development|Migration|Refactoring|Deployment)\s+)?Plan\b/mi.test(content);
  const hasNumberedSteps = (content.match(/^\d+\.\s+/gm) || []).length >= 2;
  return hasPlanHeader && hasNumberedSteps;
}
