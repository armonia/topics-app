import { useRef } from 'react';
import { useT } from '../../hooks/useT';
import { DETAIL_LEVELS, detailAtFraction, stepDetail, type DetailLevel } from './detailLevel';

/**
 * A custom range input for the board's level of detail: three stops on a
 * track, a thumb that snaps to the nearest one while dragged, arrow keys,
 * and a click on a stop. Left is the least detail (projects and counts),
 * right is the most (the kanban).
 */
export function DetailSlider({ value, onChange }: { value: DetailLevel; onChange: (next: DetailLevel) => void }) {
  const tr = useT();
  const trackRef = useRef<HTMLDivElement>(null);
  const index = DETAIL_LEVELS.indexOf(value);
  const last = DETAIL_LEVELS.length - 1;
  const levelText = tr(`board.toolbar.detail.${value}`);

  const fromPointer = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    onChange(detailAtFraction((clientX - rect.left) / rect.width));
  };

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      data-testid="board-detail-slider"
      aria-label={tr('board.toolbar.detail.label')}
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={index}
      aria-valuetext={levelText}
      title={levelText}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); fromPointer(e.clientX); }}
      onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e.clientX); }}
      onKeyDown={(e) => {
        const delta = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
        if (e.key === 'Home') { e.preventDefault(); onChange(DETAIL_LEVELS[0]); }
        else if (e.key === 'End') { e.preventDefault(); onChange(DETAIL_LEVELS[last]); }
        else if (delta) { e.preventDefault(); onChange(stepDetail(value, delta)); }
      }}
      className="relative mx-1 h-6 w-16 shrink-0 cursor-pointer touch-none select-none rounded outline-none focus-visible:ring-1 focus-visible:ring-primary coarse:h-11 coarse:w-24"
    >
      <div className="absolute inset-x-2 top-1/2 h-0.5 -translate-y-1/2 rounded bg-white/15" />
      {DETAIL_LEVELS.map((level, i) => (
        <span
          key={level}
          data-level={level}
          className={`absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${i <= index ? 'bg-primary/60' : 'bg-white/25'}`}
          style={{ left: `calc(0.5rem + (100% - 1rem) * ${i / last})` }}
        />
      ))}
      <span
        className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow transition-[left] duration-150 motion-reduce:transition-none"
        style={{ left: `calc(0.5rem + (100% - 1rem) * ${index / last})` }}
      />
    </div>
  );
}
