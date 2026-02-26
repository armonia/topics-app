import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export function formatContent(text: string): string {
  if (!text) return '';
  
  // Simple implementation for now
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

export function debounce<T extends (...args: Parameters<T>) => ReturnType<T>>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout>;
  return function(this: unknown, ...args: Parameters<T>) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

export function generateSessionKey(topicId: string): string {
  return `topic:${topicId.slice(0, 8)}`;
}

export function scrollToBottom(element: HTMLElement | null) {
  if (!element) return;
  setTimeout(() => {
    element.scrollTop = element.scrollHeight;
  }, 0);
}

export function getRandomColor(): string {
  const colors = [
    '#0066cc', '#059669', '#dc2626', '#7c3aed', 
    '#ea580c', '#0891b2', '#be185d', '#4338ca',
    '#16a34a', '#c2410c', '#7c2d12', '#1e40af'
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

export { getRandomTopicIcon } from './topicIcons';

export function formatTimestamp(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  } else {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
}