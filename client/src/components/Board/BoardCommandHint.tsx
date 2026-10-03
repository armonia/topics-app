import { MessageSquare, SquareSlash } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { startsWithMapCommand } from '../Chat/commandMap';

/**
 * «I comandi vanno dati nella chat dell'agente» (CMDUI-08), above a composer
 * of the board (the drawer's, a card's comment) when what is written there
 * starts with a command. Sent from here a command is text: with an agent it
 * becomes an «update on the task» the agent reads as prose, without one a
 * note. Nothing is blocked: Enter still sends the text as before. «Open the
 * session» is the same gesture as the card menu's.
 */
export function BoardCommandHint({ text, onOpenSession }: {
  text: string;
  /** Opens the agent's chat; absent when the card has no live session. */
  onOpenSession?: () => void;
}) {
  const tr = useT();
  if (!startsWithMapCommand(text)) return null;
  return (
    <div data-testid="board-command-hint" role="note" className="mb-1 flex items-center gap-1.5 text-mini text-app-text-secondary">
      <SquareSlash className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{onOpenSession ? tr('board.command.hint') : tr('board.command.noSession')}</span>
      {onOpenSession && (
        <button
          type="button"
          data-testid="board-command-open-session"
          onClick={(e) => { e.stopPropagation(); onOpenSession(); }}
          className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-primary hover:bg-app-hover"
        >
          <MessageSquare className="h-3 w-3" aria-hidden="true" />
          {tr('board.command.openSession')}
        </button>
      )}
    </div>
  );
}
