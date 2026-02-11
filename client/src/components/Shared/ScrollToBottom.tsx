import { ArrowDown } from 'lucide-react';

interface ScrollToBottomProps {
  show: boolean;
  newCount: number;
  onClick: () => void;
}

export function ScrollToBottom({ show, newCount, onClick }: ScrollToBottomProps) {
  if (!show) return null;

  return (
    <button
      onClick={onClick}
      className="absolute bottom-3 right-3 z-10 w-8 h-8 bg-[var(--primary)] hover:bg-[#0055dd] text-white rounded-full shadow-lg flex items-center justify-center transition-all duration-200 hover:scale-105"
      title="Scroll to bottom"
    >
      <ArrowDown size={16} />
      {newCount > 0 && (
        <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">
          {newCount > 99 ? '99+' : newCount}
        </span>
      )}
    </button>
  );
}

interface NewMessageBannerProps {
  show: boolean;
  onClick: () => void;
}

export function NewMessageBanner({ show, onClick }: NewMessageBannerProps) {
  if (!show) return null;

  return (
    <button
      onClick={onClick}
      className="absolute top-2 left-1/2 -translate-x-1/2 z-10 bg-[var(--primary)] text-white text-[11px] font-medium px-3 py-1 rounded-full shadow-md hover:bg-[#0055dd] transition-all duration-200 animate-bounce-once"
    >
      New messages ↓
    </button>
  );
}
