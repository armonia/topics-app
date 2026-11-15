import { useEffect, useRef, useState } from 'react';
import { useT } from '../hooks/useT';
import { Download, ImageOff, MicOff, Music, X } from 'lucide-react';
import { getFileIconDef } from '../lib/fileIcons';
import { getMediaUrl } from '../lib/api';
import { basename } from '../lib/path-utils';
import { releaseAudio } from '../lib/releaseAudio';
import { ImageLightbox, ZoomableImage } from './Shared/ImageLightbox';
import { useMediaBox } from './Chat/mediaBox';

// File extension helpers
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
const AUDIO_EXTS = ['ogg', 'mp3', 'wav', 'm4a', 'aac', 'opus', 'webm'];
const DOC_EXTS = ['pdf', 'zip', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'md', 'json'];

function getExtension(path: string): string {
  const match = path.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : '';
}

function isImage(path: string): boolean {
  return IMAGE_EXTS.includes(getExtension(path));
}

function isAudio(path: string): boolean {
  return AUDIO_EXTS.includes(getExtension(path));
}

function isDocument(path: string): boolean {
  return DOC_EXTS.includes(getExtension(path));
}

function getFileName(path: string): string {
  return basename(path) || path;
}

function FileIcon({ path, size = 24 }: { path: string; size?: number }) {
  const def = getFileIconDef(getFileName(path));
  const I = def.icon;
  return <I size={size} style={{ color: def.color }} />;
}

export function MediaImage({ path }: { path: string }) {
  const [lightbox, setLightbox] = useState(false);
  const [error, setError] = useState(false);
  // Its box before the bytes, from the size the server sent (`Chat/mediaBox.ts`).
  const box = useMediaBox(path);
  const src = getMediaUrl(path);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const loaded = loadedSrc === src;
  // In its box and still without its bytes: the box reads as the place of a
  // picture (a neutral tint of the theme), and the curtain of the list does not
  // wait for it (`data-media-box`, `Chat/listPaintedAndWhole.ts`).
  const boxed = !!box && !loaded;

  if (error) {
    return (
      <div data-testid="media-image-error" className="inline-flex items-center gap-2 bg-app-hover dark:bg-elevated rounded-lg p-2 text-body-lg leading-5 text-app-text-muted">
        <ImageOff aria-hidden className="w-4 h-4 inline-block align-[-3px] mr-1" />Image failed to load: {getFileName(path)}
      </div>
    );
  }

  return (
    <>
      <img data-testid="media-image" src={src} alt={getFileName(path)} className={`max-w-full max-h-80 rounded-lg cursor-pointer hover:opacity-90 transition-opacity my-1${boxed ? ' bg-app-hover dark:bg-elevated' : ''}`} style={boxed ? box : undefined} data-media-box={boxed ? '' : undefined} onLoad={box ? () => setLoadedSrc(src) : undefined} onClick={() => setLightbox(true)} onError={() => setError(true)} loading="lazy" />
      {lightbox && <ImageLightbox src={src} alt={getFileName(path)} onClose={() => setLightbox(false)} />}
    </>
  );
}

function VoiceMessagePlayer({ path, isUserMessage }: { path: string; isUserMessage?: boolean }) {
  const tr = useT();
  const src = getMediaUrl(path);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [error, setError] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onMeta = () => { if (audio.duration && isFinite(audio.duration)) setDuration(audio.duration); };
    const onTime = () => {
      setCurrentTime(audio.currentTime);
      // Safari sometimes only reports duration after playback starts. Read the
      // current value via the functional updater (not the closed-over `duration`)
      // so this mount-once effect needn't depend on it / rebind listeners.
      if (audio.duration && isFinite(audio.duration)) {
        setDuration(prev => (prev === 0 ? audio.duration : prev));
      }
    };
    const onEnded = () => { setPlaying(false); setCurrentTime(0); };
    const onError = (e: Event) => { console.error('Audio error:', (e.target as HTMLAudioElement)?.error); setError(true); };
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('durationchange', onMeta);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('durationchange', onMeta);
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      // Removing the listeners is not enough: a media element holding a loaded
      // source stays attached to its own audio renderer, which in WebKit is a
      // live thread in the WebContent process. With chats unmounting (residency
      // cap), every voice message played left one behind.
      // See lib/releaseAudio.ts for the measurement that led here.
      releaseAudio(audio);
    };
  }, []);

  if (error) {
    return (
      <div data-testid="voice-player-error" className="inline-flex items-center gap-2 bg-app-hover dark:bg-elevated rounded-lg p-2 text-body-lg leading-5 text-app-text-muted">
        <MicOff aria-hidden className="w-4 h-4 inline-block align-[-3px] mr-1" />Voice message failed to load
      </div>
    );
  }

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) { audio.pause(); setPlaying(false); }
    else { audio.play(); setPlaying(true); }
  };

  /** The one place the position is written, so the pointer and the keyboard
   *  cannot drift apart. Seconds, clamped to the track. */
  const seekTo = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    audio.currentTime = Math.max(0, Math.min(seconds, duration));
    setCurrentTime(audio.currentTime);
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekTo(pct * duration);
  };

  /* THE BAR WAS A `div` WITH AN `onClick`: no role, no tab stop, no key. To
   * anyone not holding a mouse the position of a voice message was not just
   * hard to change, it was not announced at all -- and the element still looked
   * clickable, so it read as broken rather than absent. `role="slider"` plus
   * these keys is the contract that name implies: five seconds per arrow, the
   * ends on Home/End. */
  const onBarKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!duration) return;
    const step = 5;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); seekTo(currentTime + step); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); seekTo(currentTime - step); }
    else if (e.key === 'Home') { e.preventDefault(); seekTo(0); }
    else if (e.key === 'End') { e.preventDefault(); seekTo(duration); }
  };

  const fmt = (s: number) => {
    if (!s || !isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div data-testid="voice-player" className="flex items-center gap-2.5 py-1 min-w-[180px] max-w-[260px]">
      <audio ref={audioRef} src={src} preload="auto" />
      {/* The button was an icon and nothing else: `toHaveAccessibleName` had
          nothing to read, and a screen reader announced «button». The name
          follows the STATE, because that is what pressing it will do. */}
      <button
        onClick={toggle}
        aria-label={tr(playing ? 'chat.voice.pause' : 'chat.voice.play')}
        data-testid="voice-player-toggle"
        className={`w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-full transition-colors ${
          // Bolla utente = bg-primary (blu saturo) in ENTRAMBI i temi: qui
          // `bg-white/N` è il rialzo corretto sopra fondo scuro garantito,
          // l'eccezione alla regola in index.css. Fuori dalla bolla si usa il
          // token accent (bg-primary/N) che si adatta al tema.
          isUserMessage
            ? 'bg-white/20 hover:bg-white/30 text-white'
            : 'bg-primary/15 hover:bg-primary/25 text-primary'
        }`}
      >
        {playing ? (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="2" y="1" width="4" height="12" rx="1" /><rect x="8" y="1" width="4" height="12" rx="1" /></svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M3 1.5v11l9-5.5z" /></svg>
        )}
      </button>
      <div className="flex-1 flex flex-col gap-1 min-w-0">
        {/* `tap-expand-y`: the bar is 6px tall and spans the bubble's width, so
            the axis that is missing is the vertical one -- and it has room,
            since nothing else is stacked against it inside the player. */}
        <div
          className="tap-expand-y h-1.5 rounded-full cursor-pointer relative overflow-hidden"
          style={{ backgroundColor: isUserMessage ? 'rgba(255,255,255,0.2)' : 'rgba(var(--primary-rgb, 59,130,246),0.15)' }}
          onClick={seek}
          onKeyDown={onBarKey}
          role="slider"
          tabIndex={0}
          aria-label={tr('chat.voice.progress')}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(currentTime)}
          aria-valuetext={`${fmt(currentTime)} / ${fmt(duration)}`}
          data-testid="voice-player-progress"
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full transition-all"
            style={{
              width: `${progress}%`,
              backgroundColor: isUserMessage ? 'rgba(255,255,255,0.8)' : 'var(--primary, #3b82f6)',
            }}
          />
        </div>
        <div className={`flex justify-between text-mini tabular-nums ${isUserMessage ? 'text-white/60' : 'text-app-text-muted'}`}>
          <span>{fmt(currentTime)}</span>
          <span>{fmt(duration)}</span>
        </div>
      </div>
    </div>
  );
}

function MediaAudio({ path, isVoice, isUserMessage }: { path: string; isVoice?: boolean; isUserMessage?: boolean }) {
  if (isVoice) return <VoiceMessagePlayer path={path} isUserMessage={isUserMessage} />;
  const src = getMediaUrl(path);
  return (
    <div data-testid="media-audio" className="my-2 bg-elevated dark:bg-elevated rounded-lg p-3 border border-app-border-light">
      <div className="flex items-center gap-2 mb-2 text-body-lg leading-5 text-app-text-secondary"><Music aria-hidden className="w-4 h-4 shrink-0" />{getFileName(path)}</div>
      <audio controls className="w-full" preload="metadata">
        <source src={src} />
        Your browser does not support audio playback.
      </audio>
    </div>
  );
}

function MediaFile({ path }: { path: string }) {
  const src = getMediaUrl(path);
  return (
    <a
      data-testid="media-file"
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      download={getFileName(path)}
      className="my-1 flex items-center gap-3 bg-elevated hover:bg-app-hover rounded-lg p-3 border border-app-border-light transition-colors no-underline text-inherit"
    >
      <FileIcon path={path} size={24} />
      <div className="flex-1 min-w-0">
        <div data-testid="media-file-name" className="text-body-lg leading-5 font-medium truncate">{getFileName(path)}</div>
        <div className="text-compact leading-4 text-app-text-muted uppercase">{getExtension(path)} file</div>
      </div>
      <Download size={16} className="text-app-text-muted flex-shrink-0" />
    </a>
  );
}

export function MediaRenderer({ path, isVoice, isUserMessage }: { path: string; isVoice?: boolean; isUserMessage?: boolean }) {
  if (isImage(path)) return <MediaImage path={path} />;
  if (isAudio(path) || isVoice) return <MediaAudio path={path} isVoice={isVoice} isUserMessage={isUserMessage} />;
  if (isDocument(path)) return <MediaFile path={path} />;
  return <MediaFile path={path} />;
}

export function ImageThumbnail({ file, onRemove }: { file: File; onRemove: () => void }) {
  const tr = useT();
  const [src] = useState(() => URL.createObjectURL(file));

  useEffect(() => {
    return () => { URL.revokeObjectURL(src); };
  }, [src]);

  return (
    <div className="relative inline-block">
      <ZoomableImage src={src} alt={file.name} className="w-16 h-16 object-cover rounded-lg border border-app-border-light" />
      <button type="button" onClick={onRemove} aria-label={tr('chat.attachments.removeFile', { name: file.name })} className="absolute -top-1.5 -right-1.5 bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center hover:bg-red-600"><X className="w-3 h-3" aria-hidden="true" /></button>
    </div>
  );
}
