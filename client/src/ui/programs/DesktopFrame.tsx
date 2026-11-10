import { useState, type ReactNode } from 'react';
import { LayoutGrid, Minus, Square, X } from 'lucide-react';
import clsx from 'clsx';
import type { MaskFieldModel, MaskModel } from './model';

/*
 * These components DRAW a Windows desktop and the window of another program:
 * the picture of what the agent sees. Their colours are the picture's, the
 * same in light and dark, not those of Topics.
 */
const DESKTOP = '#1f6fb0';
const WINDOW = '#f3f3f3';
const INK = '#1a1a1a';

/** A blue desktop with a taskbar: the stage of every drawn window. */
export function DesktopFrame({ taskbarLeft, taskbarRight, children, className, minHeight = 420 }: {
  taskbarLeft: string[];
  taskbarRight?: string;
  children: ReactNode;
  className?: string;
  minHeight?: number;
}) {
  return (
    <div className={clsx('flex min-w-0 flex-col overflow-hidden rounded-xl', className)} style={{ backgroundColor: DESKTOP }}>
      <div className="flex flex-1 items-center justify-center p-3 sm:p-6" style={{ minHeight }}>{children}</div>
      <div className="flex h-9 shrink-0 items-center gap-3 px-3 text-mini" style={{ backgroundColor: '#15212b', color: '#e5e7eb' }}>
        <LayoutGrid size={13} aria-hidden="true" />
        {taskbarLeft.map((t, i) => <span key={t} className={i === 0 ? 'font-medium' : 'text-white/60'}>{t}</span>)}
        {taskbarRight && <span className="ml-auto truncate font-mono text-nano text-white/70">{taskbarRight}</span>}
      </div>
    </div>
  );
}

/** The title bar and body of a window of another program. */
export function DrawnWindow({ program, title, children, width = 720 }: { program: string; title?: string; children: ReactNode; width?: number }) {
  return (
    <div className="w-full overflow-hidden rounded-md shadow-xl" style={{ maxWidth: width, backgroundColor: WINDOW, color: INK, boxShadow: '0 10px 30px rgba(0,0,0,.35)' }}>
      <div className="flex h-8 items-center gap-2 px-3 text-mini" style={{ backgroundColor: '#e6e6e6' }}>
        <b className="font-semibold">{program}</b>
        {title && <span className="truncate" style={{ color: '#444' }}>· {title}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2.5" style={{ color: '#555' }} aria-hidden="true">
          <Minus size={11} /><Square size={9} /><X size={11} />
        </span>
      </div>
      {children}
    </div>
  );
}

const BOX = { backgroundColor: '#fff', borderWidth: 1, borderStyle: 'solid', borderColor: '#c9c9c9', color: INK } as const;
const ACTIVE = { boxShadow: '0 0 0 2px #c026d3', borderColor: '#c026d3' } as const;

/** A field of a drawn mask. A typed field is a real input; the others are the picture of one. */
function Field({ f }: { f: MaskFieldModel }) {
  const [focused, setFocused] = useState(false);
  const shown = f.secret && f.value ? '•'.repeat(Math.max(f.value.length, 1)) : f.value;
  const style = { ...BOX, ...(f.active || focused ? ACTIVE : {}) };
  return (
    <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
      <span className="shrink-0 text-mini sm:w-[110px]" style={{ color: '#333' }}>{f.label}</span>
      {f.onChange ? (
        <input
          type={f.secret ? 'password' : 'text'}
          value={f.value}
          placeholder={f.placeholder}
          data-focused={focused || undefined}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => f.onChange?.(e.target.value)}
          aria-label={f.label}
          className="h-7 w-full min-w-0 rounded-sm px-2 text-mini outline-none sm:w-auto sm:flex-1"
          style={style}
        />
      ) : (
        <div className="flex h-7 w-full min-w-0 items-center rounded-sm px-2 text-mini sm:w-auto sm:flex-1" style={{ ...style, color: f.muted ? '#8a8a8a' : INK }}>
          <span className="truncate">{shown}</span>
          {f.active && <span className="ml-px inline-block h-3.5 w-px animate-pulse" style={{ backgroundColor: INK }} aria-hidden="true" />}
        </div>
      )}
    </div>
  );
}

/** A window drawn from a model: fields in two columns, its buttons at the foot. */
export function MaskWindow({ mask, width }: { mask: MaskModel; width?: number }) {
  const col0 = mask.fields.filter((f) => (f.column ?? 0) === 0);
  const col1 = mask.fields.filter((f) => f.column === 1);
  const twoColumns = col1.length > 0;
  return (
    <DrawnWindow program={mask.program} title={mask.title} width={width}>
      <div className="flex min-h-[300px] flex-col p-4 sm:min-h-[340px] sm:p-5">
        {mask.menu ? (
          <ul className="max-w-[260px] space-y-0.5 text-mini" aria-hidden="true">
            {mask.menu.items.map((it, i) => (
              <li key={it} className="rounded-sm px-2 py-1.5" style={i === mask.menu?.highlight ? { backgroundColor: '#c026d322', boxShadow: 'inset 0 0 0 2px #c026d3' } : { color: '#444' }}>{it}</li>
            ))}
          </ul>
        ) : (
          <div className={clsx('grid gap-x-6 gap-y-2.5', twoColumns ? 'sm:grid-cols-2' : 'grid-cols-1')}>
            <div className="space-y-2.5">{col0.map((f) => <Field key={f.id} f={f} />)}</div>
            {twoColumns && <div className="space-y-2.5">{col1.map((f) => <Field key={f.id} f={f} />)}</div>}
          </div>
        )}
        {mask.result && <p className="mt-4 rounded-sm px-2 py-1.5 text-mini font-medium" style={{ backgroundColor: '#dcfce7', color: '#14532d' }}>{mask.result}</p>}
        <div className="mt-auto flex justify-end gap-2 pt-6">
          {mask.buttons.map((b) => (
            b.onPress ? (
              <button
                key={b.id}
                type="button"
                onClick={b.onPress}
                className="h-7 rounded-sm px-3 text-mini font-medium"
                style={b.primary ? { backgroundColor: '#0f766e', color: '#fff' } : { ...BOX }}
              >
                {b.label}
              </button>
            ) : (
              <span
                key={b.id}
                aria-hidden="true"
                className="inline-flex h-7 items-center rounded-sm px-3 text-mini font-medium"
                style={b.primary ? { backgroundColor: '#0f766e', color: '#fff' } : { ...BOX }}
              >
                {b.label}
              </span>
            )
          ))}
        </div>
      </div>
    </DrawnWindow>
  );
}
