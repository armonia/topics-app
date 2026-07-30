/**
 * Mini context ring SVG used to indicate context budget consumption.
 * Reused across PaneTabBar tabs and the ChatInput action bar so the same
 * visual semantics (blue → amber → red) apply everywhere.
 */
import { contextLevel, type ContextLevel } from '../../../../shared/context-thresholds';

interface ContextRingProps {
  percent: number;
  /**
   * Il livello GIA' classificato dal server (`classifyContext`), quando c'e'.
   *
   * L'anello lo ricavava da solo dalla sola percentuale, con `> 90` / `> 70`
   * contro il `>=` del server: esattamente al 70% il server diceva "warn" e
   * l'anello restava blu. E non conosceva affatto la soglia di COSTO, quella in
   * token assoluti — un turno a 380k su un modello a 1M era ambra secondo il
   * server e blu qui. Il livello autorevole esisteva e arrivava nello stesso
   * oggetto: bastava usarlo.
   *
   * Assente = non c'e' una misura reale (si sta disegnando il preventivo
   * dell'envelope), e allora si classifica la percentuale con la funzione
   * condivisa, non con una copia delle soglie.
   */
  level?: ContextLevel;
  onClick?: () => void;
  size?: number;
}

export function ContextRing({ percent, level, onClick, size = 14 }: ContextRingProps) {
  const r = (size / 14) * 5;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (percent / 100) * circumference;
  const effective = level ?? contextLevel(percent);
  const isCritical = effective === 'critical';
  const isWarning = effective === 'warn';
  const color = isCritical ? '#ef4444' : isWarning ? '#f59e0b' : '#3b82f6';
  const bgColor = isCritical
    ? 'rgba(239,68,68,0.2)'
    : isWarning
      ? 'rgba(245,158,11,0.2)'
      : 'rgba(59,130,246,0.2)';

  return (
    <svg
      width={size}
      height={size}
      className={`flex-shrink-0 ${onClick ? 'cursor-pointer hover:opacity-80' : ''}`}
      viewBox={`0 0 ${size} ${size}`}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      aria-label="Context Inspector"
      data-testid="context-ring"
    >
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={bgColor} strokeWidth="2" />
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${cx} ${cy})`}
        className="transition-all duration-300"
      />
    </svg>
  );
}
