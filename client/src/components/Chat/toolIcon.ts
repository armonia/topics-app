/**
 * Pick a Lucide icon for a tool call based on its name. Centralised so the
 * inline tool-call row, message footer, and any future tool-list view all
 * agree on the icon for a given tool.
 *
 * The lookup is intentionally cheap and fuzzy — we match a small set of
 * substrings rather than maintaining a full registry. A `Wrench` is returned
 * as a generic fallback so any unknown tool still renders.
 */
import {
  Brain,
  FileText,
  Globe,
  ListChecks,
  Search,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

const RULES: Array<[RegExp, LucideIcon]> = [
  [/^(bash|terminal|exec|shell|run)/i, Terminal],
  [/^(read|view|edit|write|create_file|file|notebook)/i, FileText],
  [/^(grep|search|find|glob)/i, Search],
  [/^(web|fetch|http|url|browser|navigate)/i, Globe],
  [/^(todo|task|plan|list)/i, ListChecks],
  [/^(thinking|reason|reflect)/i, Brain],
];

export function iconForToolName(name: string): LucideIcon {
  for (const [re, icon] of RULES) {
    if (re.test(name)) return icon;
  }
  return Wrench;
}
