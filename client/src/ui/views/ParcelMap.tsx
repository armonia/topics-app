import { useId } from 'react';
import clsx from 'clsx';
import type { MapPart, ParcelMapModel } from './model';

const toPoints = (pts: Array<[number, number]>) => pts.map((p) => p.join(',')).join(' ');

/**
 * A GIS layer drawn as SVG: the hatched contribution perimeter with its dashed
 * edges, the canals, the cadastral parcels (the ones under verification in
 * red) and a measured distance. Everything comes in map units from the model;
 * the SVG slices to fill its box, so text keeps its proportions at any size.
 * `hidden` drops whole parts (a layer switched off): the perimeter with its
 * edges and label, or the canals with theirs; by default everything is drawn.
 */
export function ParcelMap({ map, label, hidden = [], ortho = false }: { map: ParcelMapModel; label: string; hidden?: MapPart[]; ortho?: boolean }) {
  const showPerimeter = !hidden.includes('perimeter');
  const showCanals = !hidden.includes('canals');
  const showWorks = !hidden.includes('works');
  const idBase = useId().replace(/:/g, '');
  const hatch = `hatch-${idBase}`;
  const photo = `photo-${idBase}`;
  const [w, h] = map.size;
  const { from, to } = map.measure;
  const labels = map.parcels.flatMap((p) => (p.label ? [{ id: p.id, ...p.label }] : []));
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid slice" className="absolute inset-0 h-full w-full" role="img" aria-label={label}>
      <defs>
        <pattern id={hatch} width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="14" strokeWidth="1.2" className="stroke-[#a9bfae] dark:stroke-[#3d4d42]" />
        </pattern>
        <pattern id={photo} width="46" height="38" patternUnits="userSpaceOnUse" patternTransform="rotate(-12)">
          <rect width="46" height="38" className="fill-[#9fb48a] dark:fill-[#3b4a33]" />
          <rect width="23" height="19" className="fill-[#b9a77c] dark:fill-[#54492f]" />
          <rect x="23" y="19" width="23" height="19" className="fill-[#7f9a72] dark:fill-[#2f3d29]" />
        </pattern>
      </defs>
      <rect width={w} height={h} className="fill-[#eef1ec] dark:fill-[#1b201c]" />
      {ortho && <rect width={w} height={h} fill={`url(#${photo})`} opacity={0.8} />}
      {showPerimeter && <path d={map.perimeter.area} fill={`url(#${hatch})`} opacity={0.75} />}
      {showCanals && map.canals.map((c) => (
        <g key={c.id}>
          <path d={c.path} fill="none" strokeWidth={c.width} strokeLinecap="round" className="stroke-[#86b4ea] dark:stroke-[#2f5e95]" />
          <text
            x={c.label.at[0]} y={c.label.at[1]}
            transform={c.label.rotate ? `rotate(${c.label.rotate} ${c.label.at[0]} ${c.label.at[1]})` : undefined}
            className="fill-[#2563eb] text-[14px] dark:fill-[#7fb0f8]"
          >
            {c.label.text}
          </text>
        </g>
      ))}
      {showPerimeter && map.perimeter.edges.map((d) => (
        <path key={d} d={d} fill="none" strokeWidth="2.5" strokeDasharray="12 8" className="stroke-[#2f7df6] dark:stroke-[#5a9bf6]" />
      ))}
      {showPerimeter && (
        <text x={map.perimeter.label.at[0]} y={map.perimeter.label.at[1]} className="fill-[#1d6fe0] text-[14px] font-semibold dark:fill-[#7fb0f8]">
          {map.perimeter.label.text}
        </text>
      )}
      {showWorks && (map.works ?? []).map((k) => (
        <g key={k.id}>
          <rect x={k.at[0] - 9} y={k.at[1] - 9} width="18" height="18" rx="4" strokeWidth="1.6" className="fill-[#fff7e6] stroke-[#b45309] dark:fill-[#3a2d12] dark:stroke-[#f0b35a]" />
          <path d={`M${k.at[0] - 3} ${k.at[1] - 5} V${k.at[1] + 5} M${k.at[0] + 3} ${k.at[1] - 5} V${k.at[1] + 5}`} strokeWidth="1.8" className="stroke-[#b45309] dark:stroke-[#f0b35a]" />
          <text x={k.at[0]} y={k.at[1] - 15} textAnchor="middle" className="fill-[#92400e] text-[13px] font-semibold dark:fill-[#f0b35a]">{k.label}</text>
        </g>
      ))}
      {map.parcels.map((p) => (
        <polygon
          key={p.id}
          points={toPoints(p.points)}
          strokeWidth={p.target ? 2.5 : 1}
          className={p.target
            ? 'fill-[#ef4444]/20 stroke-[#e5484d] dark:fill-[#ef4444]/25 dark:stroke-[#f87171]'
            : 'fill-[#f6f3e4] stroke-[#b8b49a] dark:fill-[#2a2a22] dark:stroke-[#5b5947]'}
        />
      ))}
      {labels.map((l) => (
        <text
          key={`${l.id}-label`}
          x={l.at[0]} y={l.at[1]}
          textAnchor="middle"
          className={clsx('fill-[#b42318] font-semibold dark:fill-[#fca5a5]', l.size === 'sm' ? 'text-[14px]' : 'text-[17px]')}
        >
          {l.text}
        </text>
      ))}
      <line x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} strokeWidth="1.6" strokeDasharray="4 4" className="stroke-[#1f2328] dark:stroke-[#e6e6e6]" />
      {[true, false].map((halo) => (
        <text
          key={String(halo)}
          x={map.measure.label.at[0]} y={map.measure.label.at[1]}
          strokeWidth={halo ? 5 : 0} strokeLinejoin="round"
          className={clsx('text-[14px] font-semibold', halo ? 'fill-[#eef1ec] stroke-[#eef1ec] dark:fill-[#1b201c] dark:stroke-[#1b201c]' : 'fill-[#1f2328] dark:fill-[#ededed]')}
          aria-hidden={halo || undefined}
        >
          {map.measure.label.text}
        </text>
      ))}
    </svg>
  );
}
