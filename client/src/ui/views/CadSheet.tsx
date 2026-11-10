import type { MouseEvent } from 'react';
import type { CadEntity, CadMeasureModel, CadNoteModel, CadPoint, CadSheetModel } from './model';

export type CadTool = 'view' | 'measure' | 'note';

const MEASURE = '#fbbf24';
const SNAP = 12;

/** The points a click snaps to: the ends of dimensions and lines, the corners of boxes, the centres of circles. */
function snapPoints(entities: CadEntity[]): CadPoint[] {
  const out: CadPoint[] = [];
  for (const e of entities) {
    if (e.kind === 'dim' || (e.kind === 'line' && e.layer !== 'griglia')) out.push(e.a, e.b);
    else if (e.kind === 'rect') out.push(e.at, [e.at[0] + e.size[0], e.at[1]], [e.at[0], e.at[1] + e.size[1]], [e.at[0] + e.size[0], e.at[1] + e.size[1]]);
    else if (e.kind === 'circle') out.push(e.at);
  }
  return out;
}

function snapTo(p: CadPoint, points: CadPoint[]): CadPoint {
  let best: CadPoint | undefined;
  let bestD = SNAP;
  for (const q of points) {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < bestD) {
      best = q;
      bestD = d;
    }
  }
  return best ?? [Math.round(p[0]), Math.round(p[1])];
}

function Entity({ e }: { e: CadEntity }) {
  switch (e.kind) {
    case 'line':
      return <line x1={e.a[0]} y1={e.a[1]} x2={e.b[0]} y2={e.b[1]} stroke={e.color ?? '#9aa0a8'} strokeWidth={e.width ?? 1} strokeDasharray={e.dash ? '10 6' : undefined} />;
    case 'rect':
      return <rect x={e.at[0]} y={e.at[1]} width={e.size[0]} height={e.size[1]} fill={e.fill ?? 'none'} stroke={e.color ?? '#9aa0a8'} strokeWidth={e.width ?? 1} />;
    case 'circle':
      return <circle cx={e.at[0]} cy={e.at[1]} r={e.r} fill={e.fill ?? 'none'} stroke={e.color ?? '#9aa0a8'} strokeWidth="2" />;
    case 'text':
      return <text x={e.at[0]} y={e.at[1]} fontSize={e.size ?? 12} fontWeight={e.bold ? 700 : 400} fill={e.color ?? '#c8cbd2'}>{e.text}</text>;
    case 'dim': {
      const horizontal = Math.abs(e.b[1] - e.a[1]) < Math.abs(e.b[0] - e.a[0]);
      const mid: CadPoint = [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
      const color = e.color ?? '#4cc77f';
      return (
        <g stroke={color} strokeWidth="1.5">
          <line x1={e.a[0]} y1={e.a[1]} x2={e.b[0]} y2={e.b[1]} />
          {horizontal ? (
            <>
              <line x1={e.a[0]} y1={e.a[1] - 8} x2={e.a[0]} y2={e.a[1] + 8} strokeWidth="1" />
              <line x1={e.b[0]} y1={e.b[1] - 8} x2={e.b[0]} y2={e.b[1] + 8} strokeWidth="1" />
            </>
          ) : (
            <>
              <line x1={e.a[0] - 8} y1={e.a[1]} x2={e.a[0] + 8} y2={e.a[1]} strokeWidth="1" />
              <line x1={e.b[0] - 8} y1={e.b[1]} x2={e.b[0] + 8} y2={e.b[1]} strokeWidth="1" />
            </>
          )}
          <text
            x={horizontal ? mid[0] : mid[0] - 8}
            y={horizontal ? mid[1] - 8 : mid[1] + 4}
            textAnchor={horizontal ? 'middle' : 'end'}
            fontSize="13" fontWeight={700} stroke="none" fill={color}
          >
            {e.label}
          </text>
        </g>
      );
    }
  }
}

/**
 * A technical drawing as SVG: entities on layers (a layer switched off hides
 * what it holds), a grid that is one metre a square, the dimensions of the
 * sheet, and on top what the reader adds: measured distances and notes. With
 * the measure or note tool on, a click lands on the sheet (snapped to a
 * corner or an end when one is close) and goes out as a sheet point; the
 * measure is read from the sheet's scale, not typed. The drawing is always
 * dark, as a CAD screen is.
 */
export function CadSheet({ sheet, hidden, tool, measures, pending, notes, onPoint, label }: {
  sheet: CadSheetModel;
  hidden: string[];
  tool: CadTool;
  measures: CadMeasureModel[];
  pending?: CadPoint;
  notes: CadNoteModel[];
  onPoint?: (p: CadPoint) => void;
  label: string;
}) {
  const [w, h] = sheet.size;
  const snaps = snapPoints(sheet.entities.filter((e) => !hidden.includes(e.layer)));
  const click = tool !== 'view' && onPoint
    ? (ev: MouseEvent<SVGSVGElement>) => {
      const svg = ev.currentTarget;
      const matrix = svg.getScreenCTM();
      if (!matrix) return;
      const pt = svg.createSVGPoint();
      pt.x = ev.clientX;
      pt.y = ev.clientY;
      const p = pt.matrixTransform(matrix.inverse());
      onPoint(snapTo([p.x, p.y], snaps));
    }
    : undefined;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={label}
      onClick={click}
      style={{ cursor: click ? 'crosshair' : 'default' }}
      className="absolute inset-0 h-full w-full"
      fontFamily="ui-monospace, Menlo, monospace"
    >
      <rect width={w} height={h} fill="#1b1d21" />
      {sheet.entities.filter((e) => !hidden.includes(e.layer)).map((e, i) => <Entity key={`${e.layer}-${i}`} e={e} />)}
      {measures.map((m) => {
        const mid: CadPoint = [(m.a[0] + m.b[0]) / 2, (m.a[1] + m.b[1]) / 2];
        return (
          <g key={m.id}>
            <line x1={m.a[0]} y1={m.a[1]} x2={m.b[0]} y2={m.b[1]} stroke={MEASURE} strokeWidth="2" strokeDasharray="6 4" />
            <circle cx={m.a[0]} cy={m.a[1]} r="4" fill={MEASURE} />
            <circle cx={m.b[0]} cy={m.b[1]} r="4" fill={MEASURE} />
            {[true, false].map((halo) => (
              <text
                key={String(halo)} x={mid[0] + 8} y={mid[1] - 8} fontSize="14" fontWeight={700}
                fill={halo ? '#1b1d21' : MEASURE} stroke={halo ? '#1b1d21' : 'none'} strokeWidth={halo ? 5 : 0} strokeLinejoin="round"
                aria-hidden={halo || undefined}
              >
                {m.label}
              </text>
            ))}
          </g>
        );
      })}
      {pending && <circle cx={pending[0]} cy={pending[1]} r="7" fill="none" stroke={MEASURE} strokeWidth="2" />}
      {notes.map((n, i) => (
        <g key={n.id}>
          <circle cx={n.at[0]} cy={n.at[1]} r="10" fill="#5aa9ff" stroke="#1b1d21" strokeWidth="2" />
          <text x={n.at[0]} y={n.at[1] + 4} textAnchor="middle" fontSize="11" fontWeight={700} fill="#0b1b2e">{i + 1}</text>
          {[true, false].map((halo) => (
            <text
              key={String(halo)} x={n.at[0] + 16} y={n.at[1] + 4} fontSize="13"
              fill={halo ? '#1b1d21' : '#cfe4ff'} stroke={halo ? '#1b1d21' : 'none'} strokeWidth={halo ? 5 : 0} strokeLinejoin="round"
              aria-hidden={halo || undefined}
            >
              {n.text}
            </text>
          ))}
        </g>
      ))}
    </svg>
  );
}
