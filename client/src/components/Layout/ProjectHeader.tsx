import { FolderOpen, ExternalLink, X } from 'lucide-react';
import { hashToColor, hashToColorLight, hashToColorDark } from './projectColors';

interface ProjectHeaderProps {
  projectPath: string;
  projectName: string;
  color?: string;
  onOpenInFinder?: () => void;
  onClose?: () => void;
}

export function ProjectHeader({ projectPath, projectName, onOpenInFinder, onClose }: ProjectHeaderProps) {
  const accentColor = hashToColor(projectPath);
  
  // Detect dark mode
  const isDark = typeof window !== 'undefined' && 
    (document.documentElement.classList.contains('dark') || 
     window.matchMedia('(prefers-color-scheme: dark)').matches);
  
  const bgColor = isDark ? hashToColorDark(projectPath) : hashToColorLight(projectPath);

  return (
    <div 
      className="h-10 flex items-center gap-2 px-3 border-b flex-shrink-0 app-drag-region transition-colors"
      style={{ 
        backgroundColor: bgColor,
        borderColor: `color-mix(in srgb, ${accentColor} 20%, transparent)`,
      }}
    >
      
      <div 
        className="w-2 h-2 rounded-full flex-shrink-0"
        style={{ backgroundColor: accentColor }}
      />
      
      <FolderOpen 
        size={14} 
        className="flex-shrink-0"
        style={{ color: accentColor }}
      />
      
      <span 
        className="text-[13px] font-semibold truncate"
        style={{ color: accentColor }}
      >
        {projectName}
      </span>
      
      <span className="text-[11px] text-app-text-muted truncate flex-1 min-w-0">
        {projectPath}
      </span>
      
      {onOpenInFinder && (
        <button
          onClick={(e) => { e.stopPropagation(); onOpenInFinder(); }}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover transition-colors app-no-drag"
          style={{ color: accentColor }}
          title="Open in Finder"
        >
          <ExternalLink size={14} />
        </button>
      )}
      {onClose && (
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover transition-colors app-no-drag text-app-text-muted hover:text-red-500"
          title="Close project"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
