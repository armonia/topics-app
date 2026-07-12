import { Loader2 } from 'lucide-react';

// The old ToolCallBadge (colored bordered pill + raw JSON args) lived here.
// Every tool render — blocks timeline, legacy bucket AND inline contentOffset
// tools — now goes through <ToolCallRow>, the single compact row + typed-card
// language (chat-rendering-parity).

// Partial/streaming indicator
export function PartialIndicator() {
  return (
    <div data-testid="chat-streaming-indicator" className="flex items-center gap-1.5 text-[11px] text-app-text-muted mt-1">
      <Loader2 size={12} className="animate-spin" />
      <span>Streaming...</span>
    </div>
  );
}
