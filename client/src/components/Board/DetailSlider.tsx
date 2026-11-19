import { useRef } from 'react';
import { useT } from '../../hooks/useT';
import { CARD_DETAIL_LEVELS, type CardDetail } from './detailLevel';

/**
 * A custom range input for how much of each card is drawn, independent of the
 * layout: a stop per level on a track, snapping to the nearest while dragged,
 * arrow keys, and a click on a stop. Left is compact, right is the full card.
 */
export function DetailSlider({ value, onChange }: { value: CardDetail; onChange: (next: CardDetail) => void }) {
  const levels = CARD_DETAIL_LEVELS;
  const tr = useT();
  const trackRef = useRef<HTMLDivElement>(null);
  const index = levels.indexOf(value);
  const last = levels.length - 1;
  const levelText = tr(`board.toolbar.cardDetail.${value}`);

  const fromPointer = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const fraction = (clientX - rect.left) / rect.width;
    onChange(levels[Math.round(Math.min(1, Math.max(0, fraction)) * last)]);
  };

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      data-testid="board-card-detail-slider"
      aria-label={tr('board.toolbar.cardDetail.label')}
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={index}
      aria-valuetext={levelText}
      title={levelText}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); fromPointer(e.clientX); }}
      onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e.clientX); }}
      onKeyDown={(e) => {
        const delta = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
        if (e.key === 'Home') { e.preventDefault(); onChange(levels[0]); }
        else if (e.key === 'End') { e.preventDefault(); onChange(levels[last]); }
        else if (delta) { e.preventDefault(); onChange(levels[Math.min(last, Math.max(0, index + delta))]); }
      }}
      className="relative mx-1 h-6 w-16 shrink-0 cursor-pointer touch-none select-none rounded outline-none focus-visible:ring-1 focus-visible:ring-primary coarse:h-11 coarse:w-24"
    >
      <div className="absolute inset-x-2 top-1/2 h-0.5 -translate-y-1/2 rounded bg-white/15" />
      {levels.map((level, i) => (
        <span
          key={level}
          data-level={level}
          className={`absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${i <= index ? 'bg-primary/60' : 'bg-white/25'}`}
          style={{ left: `calc(0.5rem + (100% - 1rem) * ${i / last})` }}
        />
      ))}
      <span
        className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow transition-[left] duration-fast motion-reduce:transition-none"
        style={{ left: `calc(0.5rem + (100% - 1rem) * ${index / last})` }}
      />
    </div>
  );
}
