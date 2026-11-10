import type { ReactNode } from 'react';
import clsx from 'clsx';
import { useScrollFade } from './scrollEdges';

/** A `div` that scrolls sideways with faded edges (see `useScrollFade`); the scrollbar is hidden, the fade is what shows there is more. */
export function ScrollFade({ className, children, ...aria }: {
  className?: string;
  children: ReactNode;
  role?: string;
  'aria-label'?: string;
}) {
  const { attach, style, onScroll } = useScrollFade<HTMLDivElement>();
  return (
    <div ref={attach} style={style} onScroll={onScroll} className={clsx('scrollbar-none scroll-px-8 overflow-x-auto', className)} {...aria}>
      {children}
    </div>
  );
}
