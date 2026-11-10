import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronDown, CircleAlert, Search, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { FOCUS_RING } from '../shell/pressable';
import { DatePicker } from './DatePicker';
import { NATIVE_TEXT, type ControlLanguage } from './nativeText';
import { FLOAT_SURFACE, LAYER_FLOAT, focusOnMount, revealOnMount } from './overlay';
import { isCoarse, placeFloat, type FloatBox } from './placement';

/*
 * The form controls of the layer. Every one is controlled: the value comes in
 * as a prop and every change goes out through `onChange`, so the same field
 * serves the gallery (a fixed value) and the product (the container's state).
 */

const CONTROL_SIZE = {
  sm: 'h-6 px-2 text-mini',
  md: 'h-7 px-2.5 text-compact',
} as const;

/** The box of a text control: a hairline on the surface, a ring on focus. */
const CONTROL = clsx(
  'w-full min-w-0 rounded-lg border bg-surface text-app-text placeholder:text-app-placeholder transition-colors',
  'disabled:cursor-default disabled:bg-black/[0.03] disabled:text-app-text-tertiary dark:disabled:bg-white/[0.04]',
  FOCUS_RING,
);

const BORDER_OK = 'border-app-border-input hover:border-black/20 dark:hover:border-white/20';
const BORDER_ERROR = 'border-rose-500/70 dark:border-rose-400/70';

/** Label above, hint or error below: the frame every text control shares. */
function FieldFrame({ id, label, hint, error, hintId, className, children }: {
  id: string;
  label?: string;
  hint?: ReactNode;
  error?: string;
  hintId: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={clsx('flex min-w-0 flex-col gap-1', className)}>
      {label && <label htmlFor={id} className="text-mini font-medium text-app-text-secondary">{label}</label>}
      {children}
      {error ? (
        <p id={hintId} className="flex items-start gap-1 text-mini leading-4 text-rose-600 dark:text-rose-400">
          <CircleAlert size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-mini leading-4 text-app-text-tertiary">{hint}</p>
      ) : null}
    </div>
  );
}

/** A one-line text field, optionally with a glyph inside on the left. */
export function TextField({
  label, value, onChange, placeholder, type = 'text', icon: Icon, hint, error, disabled, title, autoFocus, onEnter,
  size = 'md', className, name, lang,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'search' | 'email' | 'number' | 'date';
  icon?: LucideIcon;
  hint?: ReactNode;
  /** Set: the field is drawn invalid and says why under it. */
  error?: string;
  disabled?: boolean;
  title?: string;
  autoFocus?: boolean;
  /** Called on Enter (not while an input method is composing). */
  onEnter?: () => void;
  size?: 'sm' | 'md';
  className?: string;
  name?: string;
  /** Language of the calendar when `type` is `date` (default `it`). */
  lang?: ControlLanguage;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  if (type === 'date') {
    // Never the browser's own date input: the layer draws the field and its calendar.
    return (
      <FieldFrame id={id} label={label} hint={hint} error={error} hintId={hintId} className={className}>
        <DatePicker
          id={id}
          value={value}
          onChange={onChange}
          lang={lang}
          placeholder={placeholder}
          disabled={disabled}
          title={title}
          size={size}
          invalid={!!error}
          describedBy={error || hint ? hintId : undefined}
          ariaLabel={label ? undefined : placeholder ?? title}
          autoFocus={autoFocus}
          name={name}
        />
      </FieldFrame>
    );
  }
  const onKeyDown = onEnter
    ? (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
        e.preventDefault();
        onEnter();
      }
    }
    : undefined;
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error} hintId={hintId} className={className}>
      <span className="relative flex min-w-0">
        {Icon && (
          <Icon
            size={size === 'sm' ? 12 : 14}
            className={clsx('pointer-events-none absolute top-1/2 -translate-y-1/2 text-app-text-tertiary', size === 'sm' ? 'left-2' : 'left-2.5')}
            aria-hidden="true"
          />
        )}
        <input
          id={id}
          name={name}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          data-tip={title}
          autoFocus={autoFocus}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? hintId : undefined}
          aria-label={label ? undefined : placeholder ?? title}
          className={clsx(CONTROL, CONTROL_SIZE[size], error ? BORDER_ERROR : BORDER_OK, Icon && (size === 'sm' ? 'pl-6' : 'pl-8'), type === 'number' && 'tabular-nums')}
        />
      </span>
    </FieldFrame>
  );
}

/** A text box of several lines; it grows by hand, never sideways. */
export function TextArea({ label, value, onChange, placeholder, rows = 3, disabled, hint, className }: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  hint?: ReactNode;
  className?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <FieldFrame id={id} label={label} hint={hint} hintId={hintId} className={className}>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        aria-label={label ? undefined : placeholder}
        className={clsx(CONTROL, BORDER_OK, 'resize-y px-2.5 py-1.5 text-compact leading-5')}
      />
    </FieldFrame>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  /** A glyph before the label, in the list and in the closed field. */
  icon?: LucideIcon;
  /** A quiet second line under the label, in the list. */
  hint?: string;
}

/** Above this many options the list opens with a search box on top. */
const SEARCH_FROM = 8;
/** Letters typed within this many milliseconds of each other make one word. */
const TYPE_AHEAD_MS = 700;

/** Lower case without accents, so a search for "resume" finds the accented spelling. */
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const OPTION = 'mx-1 flex min-h-7 w-[calc(100%-8px)] cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-compact text-app-text coarse:min-h-11 coarse:text-body-lg';

/**
 * A choice among options, drawn by the layer (never the browser's `<select>`).
 * A button shows the chosen label; it opens a `role="listbox"` over (or under)
 * itself. Arrows, Home and End move, letters jump to a label (type-ahead),
 * Enter and Space choose, Escape and a click outside close and give the focus
 * back to the button. Past eight options a search box sits on top and typing
 * filters the list.
 */
export function Select({ label, value, options, onChange, disabled, title, size = 'md', className, lang = 'it', placeholder }: {
  label?: string;
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  disabled?: boolean;
  /** Tooltip, and the accessible name when there is no `label`. */
  title?: string;
  size?: 'sm' | 'md';
  className?: string;
  /** Language of the few words the list says itself (the search box). */
  lang?: ControlLanguage;
  /** Shown in the closed field when `value` is not among the options. */
  placeholder?: string;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const t = NATIVE_TEXT[lang];
  const trigger = useRef<HTMLButtonElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const [box, setBox] = useState<FloatBox | null>(null);
  const [query, setQuery] = useState('');
  /** Index in the visible rows of the row the keyboard is on. */
  const [active, setActive] = useState(0);

  const open = box !== null;
  const searchable = options.length > SEARCH_FROM;
  const chosen = options.find((o) => o.value === value);
  const needle = plain(query.trim());
  const visible = needle ? options.filter((o) => plain(o.label).includes(needle)) : options;
  const name = label ?? title;
  const ChosenIcon = chosen?.icon;
  const iconSize = size === 'sm' ? 12 : 14;

  const close = () => {
    setBox(null);
    trigger.current?.focus({ preventScroll: true });
  };
  const show = () => {
    const el = trigger.current;
    if (!el || disabled) return;
    const row = isCoarse(el) ? 44 : 28;
    const height = Math.min(320, options.length * row + 8 + (searchable ? 44 : 0));
    setBox(placeFloat(el, { width: Math.max(el.getBoundingClientRect().width, 160), height }));
    setQuery('');
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    typed.current = { text: '', at: 0 };
  };
  const choose = (o: SelectOption | undefined) => {
    if (!o) return;
    close();
    if (o.value !== value) onChange(o.value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    const last = visible.length - 1;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(Math.min(last, active + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(0, active - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(visible[active]);
    } else if ((e.key === 'Home' || e.key === 'End') && !searchable) {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : last);
    } else if (!searchable && (e.key.length === 1 || e.key === ' ') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const fresh = e.timeStamp - typed.current.at < TYPE_AHEAD_MS;
      if (e.key === ' ' && !(fresh && typed.current.text)) {
        e.preventDefault();
        choose(visible[active]);
        return;
      }
      e.preventDefault();
      const word = (fresh ? typed.current.text : '') + e.key;
      typed.current = { text: word, at: e.timeStamp };
      const start = word.length === 1 ? active + 1 : active;
      const from = plain(word);
      for (let i = 0; i < visible.length; i++) {
        const at = (start + i) % visible.length;
        if (plain(visible[at].label).startsWith(from)) {
          setActive(at);
          break;
        }
      }
    }
  };

  const rowId = (i: number) => `${id}-o${i}`;
  const activeId = visible.length ? rowId(Math.min(active, visible.length - 1)) : undefined;

  return (
    <FieldFrame id={id} label={label} hintId={`${id}-hint`} className={className}>
      <button
        id={id}
        ref={trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={name ? `${name}: ${chosen?.label ?? ''}` : undefined}
        disabled={disabled}
        data-tip={title}
        onClick={() => (open ? setBox(null) : show())}
        onKeyDown={(e) => {
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
            e.preventDefault();
            show();
          }
        }}
        className={clsx(CONTROL, CONTROL_SIZE[size], BORDER_OK, 'flex cursor-pointer items-center gap-1.5 text-left disabled:cursor-default', open && 'border-black/20 dark:border-white/20')}
      >
        {ChosenIcon && <ChosenIcon size={iconSize} className="shrink-0 text-app-text-secondary" aria-hidden="true" />}
        <span className={clsx('min-w-0 flex-1 truncate', !chosen && 'text-app-placeholder')}>{chosen?.label ?? placeholder ?? ''}</span>
        <ChevronDown size={size === 'sm' ? 12 : 14} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
      </button>
      {open && box && (
        <>
          <div
            aria-hidden="true"
            className={clsx('fixed inset-0', LAYER_FLOAT)}
            onClick={close}
            onContextMenu={(e) => {
              e.preventDefault();
              close();
            }}
          />
          <div
            onKeyDown={onKeyDown}
            style={{ left: box.left, top: box.top, bottom: box.bottom, minWidth: box.width, maxWidth: `min(420px, calc(100vw - ${box.left + 8}px))`, maxHeight: box.maxHeight }}
            className={clsx(FLOAT_SURFACE, LAYER_FLOAT, 'fixed flex w-max flex-col py-1 outline-none')}
          >
            {searchable && (
              <div className="relative mx-1 mb-1 flex shrink-0">
                <Search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-app-text-tertiary" aria-hidden="true" />
                <input
                  ref={focusOnMount}
                  type="text"
                  role="combobox"
                  aria-expanded="true"
                  aria-autocomplete="list"
                  aria-controls={listId}
                  aria-activedescendant={activeId}
                  aria-label={t.search}
                  placeholder={t.search}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                  className={clsx('h-7 w-full min-w-0 rounded-md border border-app-border-input bg-surface pl-7 pr-2 text-compact text-app-text placeholder:text-app-placeholder coarse:h-11 coarse:text-body-lg', FOCUS_RING)}
                />
              </div>
            )}
            <div
              id={listId}
              role="listbox"
              ref={searchable ? undefined : focusOnMount}
              tabIndex={-1}
              aria-label={name}
              aria-activedescendant={searchable ? undefined : activeId}
              className="min-h-0 flex-1 overflow-y-auto outline-none"
            >
              {visible.map((o, i) => {
                const selected = o.value === value;
                const Icon = o.icon;
                return (
                  <div
                    key={o.value}
                    id={rowId(i)}
                    role="option"
                    aria-selected={selected}
                    ref={i === active ? revealOnMount : undefined}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => i !== active && setActive(i)}
                    onClick={() => choose(o)}
                    className={clsx(OPTION, i === active && 'bg-black/[0.05] dark:bg-white/[0.08]')}
                  >
                    <Check size={14} className={clsx('shrink-0 text-primary', !selected && 'invisible')} aria-hidden="true" />
                    {Icon && <Icon size={14} className="shrink-0 text-app-text-secondary" aria-hidden="true" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{o.label}</span>
                      {o.hint && <span className="block truncate text-mini leading-4 text-app-text-tertiary">{o.hint}</span>}
                    </span>
                  </div>
                );
              })}
              {visible.length === 0 && <div className="px-3 py-2 text-compact text-app-text-tertiary">{t.noResults}</div>}
            </div>
          </div>
        </>
      )}
    </FieldFrame>
  );
}

/**
 * An on/off setting: the words on the left, the switch on the right, the
 * product's track (`components/Shared/Switch.tsx`): a veil when off, so the
 * off state reads in the light theme too, and a ringed knob.
 */
export function Toggle({ checked, onChange, label, description, disabled, title }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
  /** Why the setting cannot change here, or what it does when there is no label. */
  title?: string;
}) {
  const id = useId();
  const descriptionId = `${id}-desc`;
  const control = (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ? undefined : title}
      aria-describedby={description ? descriptionId : undefined}
      disabled={disabled}
      data-tip={title}
      onClick={() => onChange(!checked)}
      className={clsx('flex h-6 shrink-0 items-center rounded-full disabled:cursor-default disabled:opacity-40', FOCUS_RING)}
    >
      <span className={clsx('relative block h-5 w-9 rounded-full transition-colors duration-fast', checked ? 'bg-primary' : 'bg-black/25 dark:bg-white/25')}>
        <span className={clsx('control-slide absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm ring-1 ring-black/10', checked ? 'translate-x-4' : 'translate-x-0')} />
      </span>
    </button>
  );
  if (!label && !description) return control;
  return (
    <div className="flex min-w-0 items-start gap-3" data-tip={title}>
      <div className="min-w-0 flex-1">
        {label && (
          <label htmlFor={id} className={clsx('block text-prose leading-6 text-app-text', disabled ? 'cursor-default text-app-text-tertiary' : 'cursor-pointer')}>
            {label}
          </label>
        )}
        {description && <p id={descriptionId} className="text-mini leading-4 text-app-text-tertiary">{description}</p>}
      </div>
      {control}
    </div>
  );
}

/** A tick box with its words; the native input underneath keeps the semantics. */
export function Checkbox({ checked, onChange, label, disabled, title }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label
      data-tip={title}
      className={clsx('group relative inline-flex min-h-7 min-w-0 items-center gap-2 text-prose', disabled ? 'cursor-default text-app-text-tertiary' : 'cursor-pointer text-app-text')}
    >
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        aria-label={label ? undefined : title}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden="true"
        className={clsx(
          'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
          'peer-focus-visible:ring-2 peer-focus-visible:ring-primary/60',
          checked ? 'border-primary bg-primary text-white' : 'border-black/25 bg-surface dark:border-white/25',
          !checked && !disabled && 'group-hover:border-primary',
          disabled && 'opacity-45',
        )}
      >
        {checked && <Check size={11} strokeWidth={3} />}
      </span>
      {label && <span className="min-w-0">{label}</span>}
    </label>
  );
}
