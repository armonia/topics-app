import { FileText } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { FOCUS_RING } from '../shell/pressable';
import { ParcelMap } from './ParcelMap';
import type { SlideModel } from './model';

/**
 * One slide, 16:9, in the colours of paper whatever the theme: a slide is a
 * document that leaves the organization. Sizes are in container units, so the
 * same component draws a thumbnail and a full slide, always the same picture.
 * `interactive` makes the cited sources buttons; a thumbnail is only a picture.
 */
export function SlideView({ slide, copy, index, total, orgLabel, orgMonogram, footer, interactive, onOpenSource, className }: {
  slide: SlideModel;
  copy: UiCopy;
  index: number;
  total: number;
  orgLabel: string;
  orgMonogram: string;
  footer: string;
  interactive?: boolean;
  onOpenSource?: (source: { label: string; id?: string }) => void;
  className?: string;
}) {
  const d = copy.viewsMore.deck;
  return (
    <div style={{ containerType: 'inline-size' }} className={clsx('w-full', className)}>
      <div className="relative flex aspect-video w-full flex-col overflow-hidden rounded-[0.8cqw] bg-white text-[#1f2328] shadow-[0_10px_40px_rgba(0,0,0,0.15)]" style={{ padding: '4.4cqw 5.2cqw', gap: '1.8cqw' }}>
        <div className="flex items-center text-[#6b7280]" style={{ gap: '1cqw', fontSize: '1.45cqw' }}>
          <span className="inline-flex items-center justify-center rounded-full bg-[#2f8f5b] font-bold text-white" style={{ width: '2.4cqw', height: '2.4cqw', fontSize: '1.05cqw' }}>{orgMonogram}</span>
          <span>{orgLabel} · {d.slideOf(index + 1, total)}</span>
        </div>
        <div className="font-bold leading-tight tracking-tight" style={{ fontSize: slide.kind === 'cover' ? '4.2cqw' : '3.4cqw' }}>{slide.title}</div>
        {slide.subtitle && <div className="text-[#4b5563]" style={{ fontSize: '2cqw' }}>{slide.subtitle}</div>}
        {slide.kind === 'facts' && slide.facts && (
          <div className="grid min-h-0 flex-1 grid-cols-2 content-start" style={{ gap: '1.4cqw 3cqw', fontSize: '1.9cqw' }}>
            {slide.facts.map((f) => (
              <div key={f.label} className="min-w-0">
                <div className="text-[#6b7280]" style={{ fontSize: '1.4cqw' }}>{f.label}</div>
                <div className="font-semibold leading-snug">{f.value}</div>
              </div>
            ))}
          </div>
        )}
        {(slide.kind === 'bullets' || slide.kind === 'map') && (
          <div className={clsx('grid min-h-0 flex-1', slide.map ? 'grid-cols-[1.2fr_1fr]' : 'grid-cols-1')} style={{ gap: '2.4cqw' }}>
            {slide.map && (
              <div className="relative min-h-0 overflow-hidden rounded-[0.6cqw] bg-[#eef2ea]">
                <ParcelMap map={slide.map} label={slide.title} hidden={[]} />
              </div>
            )}
            <ul className="flex min-h-0 flex-col" style={{ gap: '1.2cqw', fontSize: '1.9cqw', lineHeight: 1.4 }}>
              {(slide.bullets ?? []).map((b) => (
                <li key={b.text} className="flex gap-[0.8cqw]">
                  <span aria-hidden="true">•</span>
                  <span className="min-w-0">
                    {b.text}
                    {b.source && (interactive && onOpenSource ? (
                      <button
                        type="button"
                        onClick={() => onOpenSource(b.source!)}
                        className={clsx('ml-[0.8cqw] inline-flex items-center gap-[0.4cqw] rounded bg-sky-100 px-[0.8cqw] align-baseline text-sky-800 hover:bg-sky-200', FOCUS_RING)}
                        style={{ fontSize: '1.3cqw' }}
                      >
                        <FileText style={{ width: '1.3cqw', height: '1.3cqw' }} aria-hidden="true" />
                        {b.source.label}
                      </button>
                    ) : (
                      <span className="ml-[0.8cqw] rounded bg-sky-100 px-[0.8cqw] text-sky-800" style={{ fontSize: '1.3cqw' }}>{b.source.label}</span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-auto border-t border-[#e5e7eb] pt-[0.8cqw] text-[#6b7280]" style={{ fontSize: '1.2cqw' }}>{footer}</div>
      </div>
    </div>
  );
}
