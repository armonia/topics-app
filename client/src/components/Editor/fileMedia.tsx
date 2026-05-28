import { useState } from 'react';
import { Download, ZoomIn, ZoomOut } from 'lucide-react';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv', 'ogv']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'aac', 'flac', 'm4a', 'opus', 'wma']);
const PDF_EXTS = new Set(['pdf']);

export function getFileExt(filename: string): string {
  return (filename.split('.').pop() || '').toLowerCase();
}

export type MediaType = 'image' | 'video' | 'audio' | 'pdf' | 'text';

export function getMediaType(filename: string): MediaType {
  const ext = getFileExt(filename);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (PDF_EXTS.has(ext)) return 'pdf';
  return 'text';
}

export function isHtmlFile(filename: string): boolean {
  return /\.(html?|htm)$/i.test(filename);
}

export function MediaViewer({ filePath, mediaType, filename }: { filePath: string; mediaType: MediaType; filename: string }) {
  // Use /preview/ endpoint which serves any absolute path with correct MIME type
  const mediaUrl = `/preview${filePath}`;
  const [zoom, setZoom] = useState(1);
  const [imageError, setImageError] = useState(false);

  const resetZoom = () => setZoom(1);

  if (mediaType === 'image') {
    return (
      <div className="flex flex-col h-full">
        {/* Toolbar */}
        <div className="flex items-center gap-1 px-2 py-1 border-b border-app-border bg-elevated flex-shrink-0">
          <button onClick={() => setZoom(z => Math.max(0.1, z - 0.25))} className="w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover text-app-text-muted" title="Zoom out">
            <ZoomOut size={14} />
          </button>
          <button onClick={resetZoom} className="px-1.5 h-6 flex items-center justify-center rounded hover:bg-app-hover text-[11px] text-app-text-muted tabular-nums min-w-[40px]" title="Reset zoom">
            {Math.round(zoom * 100)}%
          </button>
          <button onClick={() => setZoom(z => Math.min(5, z + 0.25))} className="w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover text-app-text-muted" title="Zoom in">
            <ZoomIn size={14} />
          </button>
          <div className="flex-1" />
          <a href={mediaUrl} download={filename} className="w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover text-app-text-muted" title="Download">
            <Download size={14} />
          </a>
        </div>
        {/* Image */}
        <div className="flex-1 overflow-auto flex items-center justify-center bg-[repeating-conic-gradient(#80808015_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]">
          {imageError ? (
            <p className="text-[13px] text-app-text-muted">Unable to load image</p>
          ) : (
            <img
              src={mediaUrl}
              alt={filename}
              style={{ transform: `scale(${zoom})`, transformOrigin: 'center', maxWidth: zoom <= 1 ? '100%' : 'none', maxHeight: zoom <= 1 ? '100%' : 'none' }}
              className="object-contain transition-transform duration-100"
              onError={() => setImageError(true)}
              draggable={false}
            />
          )}
        </div>
      </div>
    );
  }

  if (mediaType === 'video') {
    return (
      <div className="flex-1 flex items-center justify-center bg-black h-full">
        <video
          src={mediaUrl}
          controls
          className="max-w-full max-h-full"
          preload="metadata"
        >
          Your browser does not support video playback.
        </video>
      </div>
    );
  }

  if (mediaType === 'audio') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 h-full">
        <div className="text-[48px] opacity-30">&#9835;</div>
        <span className="text-[13px] text-app-text-muted">{filename}</span>
        <audio src={mediaUrl} controls preload="metadata" className="w-[320px] max-w-full" />
        <a href={mediaUrl} download={filename} className="text-[12px] text-primary hover:underline flex items-center gap-1">
          <Download size={12} /> Download
        </a>
      </div>
    );
  }

  if (mediaType === 'pdf') {
    return (
      <div className="flex-1 h-full">
        <iframe
          src={mediaUrl}
          title={filename}
          className="w-full h-full border-0"
        />
      </div>
    );
  }

  return null;
}

export function HtmlPreview({ filePath, filename }: { filePath: string; filename: string }) {
  return (
    <div className="flex-1 h-full bg-white">
      <iframe
        src={`/preview${filePath}`}
        title={filename}
        sandbox="allow-scripts allow-forms allow-popups"
        className="w-full h-full border-0"
      />
    </div>
  );
}
