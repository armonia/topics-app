/**
 * Shared custom drag-image helper for the tiling surfaces.
 *
 * Both PanelGrid (dragging a topic tile) and GroupLayout (dragging a layout row
 * to reorder) render the SAME transient "pill" as the drag image instead of the
 * browser's default file/ghost: a primary-accent rounded chip drawn OFF-screen,
 * wired via `setDragImage` (centered under the cursor), then removed on the next
 * frame once the browser has snapshotted it. Each host also tracks live ghosts
 * in a `Set` so a component unmounting mid-drag can drain any still-attached
 * node — pass that set as `registry`.
 *
 * NOTE: PaneTabBar deliberately does NOT use this. Its tab chip must render
 * ON-screen at the cursor (WKWebView/Tauri returns an EMPTY image for anything
 * outside the visual viewport) and is styled as app chrome (elevated surface +
 * border + accent dot), left-anchored rather than centered. See its dragstart.
 */
import type React from 'react';

export interface DragGhostOptions {
  /** Text (may include a leading emoji) shown in the pill. */
  text: string;
  /** `sm` = compact (row reorder); `md` = roomier w/ flex gap (topic tile). */
  size?: 'sm' | 'md';
}

/**
 * Create the drag-image pill, register it as the event's `setDragImage`, and
 * schedule its removal next frame. The live node is added to `registry` and
 * removed again on cleanup so a host's unmount safety-net can drain it.
 */
export function spawnDragGhost(
  e: React.DragEvent,
  { text, size = 'sm' }: DragGhostOptions,
  registry: Set<HTMLElement>,
): void {
  if (!e.dataTransfer) return;
  const md = size === 'md';
  const ghost = document.createElement('div');
  ghost.style.cssText = `
    position:fixed;left:-9999px;top:-9999px;
    ${md ? 'display:flex;align-items:center;gap:6px;' : ''}
    padding:${md ? '6px 14px' : '4px 12px'};border-radius:${md ? 8 : 6}px;
    background:color-mix(in srgb, var(--primary) ${md ? 90 : 80}%, transparent);color:#fff;
    font:500 ${md ? 13 : 12}px/1 Inter,system-ui,sans-serif;
    box-shadow:0 ${md ? '4px 12px' : '2px 8px'} rgba(0,0,0,0.15);
    white-space:nowrap;pointer-events:none;
  `;
  ghost.textContent = text;
  document.body.appendChild(ghost);
  registry.add(ghost);
  e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
  requestAnimationFrame(() => {
    ghost.remove();
    registry.delete(ghost);
  });
}
