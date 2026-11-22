/** Cuts an agent SOUL into the pieces the layered persona keeps apart (shared by the migration script and the system health route). */

export interface SoulSection { heading: string; text: string }
export interface SoulPlan { dropped: SoulSection[]; kept: SoulSection[]; moved: SoulSection[] }

const headingOf = (line: string): string => line.replace(/^##\s+/, "").trim().toLowerCase();

/** Cuts a markdown document into its preamble plus one section per `## ` heading. */
function splitSoulSections(soul: string): SoulSection[] {
  const sections: SoulSection[] = [];
  let current: SoulSection = { heading: "", text: "" };
  for (const line of soul.split("\n")) {
    if (/^##\s+/.test(line)) {
      sections.push(current);
      current = { heading: headingOf(line), text: `${line}\n` };
    } else {
      current.text += `${line}\n`;
    }
  }
  sections.push(current);
  return sections.filter((s) => s.text.trim());
}

/** Decides where each section goes, given the shipped base and the headings to keep. */
export function planSoulSplit(soul: string, baseSoul: string, keep: string[]): SoulPlan {
  const baseHeadings = new Set(splitSoulSections(baseSoul).map((s) => s.heading).filter(Boolean));
  const keepHeadings = new Set(keep.map((k) => k.trim().toLowerCase()));
  const plan: SoulPlan = { dropped: [], kept: [], moved: [] };
  for (const s of splitSoulSections(soul)) {
    if (s.heading && keepHeadings.has(s.heading)) plan.kept.push(s);
    else if (s.heading && baseHeadings.has(s.heading)) plan.dropped.push(s);
    else if (s.heading) plan.moved.push(s);
    else plan.dropped.push(s); // the preamble is the generic title block
  }
  return plan;
}
