import type { Action, CrumbModel, RichTextModel, Tone } from '../types';

type Point = [number, number];

/** The parts of the map a layer switch can hide. */
export type MapPart = 'perimeter' | 'canals' | 'works' | 'ortho';

/** A watercourse as the GIS layer draws it: a path and its label along it. */
export interface CanalModel {
  id: string;
  name: string;
  /** SVG path in map units. */
  path: string;
  width: number;
  label: { at: Point; rotate?: number; text: string };
}

export interface ParcelModel {
  id: string;
  points: Point[];
  /** Parcels under verification are drawn in red and labelled. */
  target?: boolean;
  label?: { at: Point; text: string; size?: 'lg' | 'sm' };
}

/** What a GIS layer returned, in map units (the viewBox), ready to draw. */
export interface ParcelMapModel {
  size: Point;
  perimeter: { area: string; edges: string[]; label: { at: Point; text: string } };
  canals: CanalModel[];
  parcels: ParcelModel[];
  /** Works of the organization on the canals (sluices, gates), drawn by the «works» layer. */
  works?: Array<{ id: string; at: Point; label: string }>;
  measure: { from: Point; to: Point; label: { at: Point; text: string } };
}

export interface MapCheckModel {
  label: string;
  value: string;
  /** A chip in this tone; without it the value is plain bold text. */
  tone?: Tone;
}

export interface ParcelViewModel {
  crumbs: CrumbModel[];
  confirmLabel: string;
  /** The other answer: «not in the perimeter». */
  rejectLabel: string;
  /** `part`: what of the map the layer draws, so switching it off hides that part. */
  layers: Array<{ id: string; label: string; on: boolean; part?: MapPart }>;
  caption: RichTextModel;
  map: ParcelMapModel;
  panel: {
    title: string;
    claim: RichTextModel;
    checks: MapCheckModel[];
    originals: Array<{ id: string; label: string }>;
    outcomeLabel: string;
    outcome: string;
  };
}

/* ---------- the parcel view, decided or not ---------- */

/** What was decided on a map check, shown at the top of the side panel. */
export interface MapDecisionModel {
  text: string;
  tone: Tone;
  /** Who and when, one line. */
  detail: string;
}

/* ---------- the CAD sheet (a03) ---------- */

export type CadPoint = [number, number];

export interface CadLayerModel {
  id: string;
  label: string;
  /** Stroke colour of the layer, as the drawing's own. */
  color: string;
}

/** One thing drawn on the sheet, tagged with its layer; coordinates are sheet units. */
export type CadEntity =
  | { kind: 'line'; layer: string; a: CadPoint; b: CadPoint; dash?: boolean; width?: number; color?: string }
  | { kind: 'rect'; layer: string; at: CadPoint; size: CadPoint; fill?: string; width?: number; color?: string }
  | { kind: 'circle'; layer: string; at: CadPoint; r: number; fill?: string; color?: string }
  | { kind: 'text'; layer: string; at: CadPoint; text: string; size?: number; bold?: boolean; color?: string }
  /** A dimension: its length in metres is read from the sheet scale, not typed. */
  | { kind: 'dim'; layer: string; id: string; a: CadPoint; b: CadPoint; label: string; ok: boolean; color?: string };

export interface CadSheetModel {
  size: CadPoint;
  /** Sheet units that make one metre on the ground. */
  unitsPerMetre: number;
  layers: CadLayerModel[];
  entities: CadEntity[];
}

/** One rule of the regulation checked against a dimension of the sheet. */
export interface CadRuleModel {
  id: string;
  label: string;
  /** What the rule asks, as printed: `≥ 4,00 m`. */
  required: string;
  /** The value found on the sheet, as printed: `4,00 m`. */
  found: string;
  ok: boolean;
}

export interface CadMeasureModel {
  id: string;
  a: CadPoint;
  b: CadPoint;
  /** Printed length, e.g. `3,20 m`. */
  label: string;
}

export interface CadNoteModel {
  id: string;
  at: CadPoint;
  text: string;
}

/* ---------- a presentation (a04) ---------- */

export interface SlideBullet {
  text: string;
  /** The original it cites; opens in the shared version. */
  source?: { label: string; id?: string };
}

export interface SlideModel {
  id: string;
  /** Short name in the strip of slides. */
  name: string;
  title: string;
  kind: 'cover' | 'bullets' | 'map' | 'facts';
  subtitle?: string;
  bullets?: SlideBullet[];
  facts?: Array<{ label: string; value: string }>;
  map?: ParcelMapModel;
}

/* ---------- saved views and blocks (a01, a05) ---------- */

export type BlockId = 'document' | 'map' | 'drawing' | 'table' | 'compare' | 'timeline' | 'checks' | 'decision' | 'signature' | 'slides' | 'summary';

export interface ViewCardModel {
  id: string;
  name: string;
  description: string;
  blocks: Array<{ key: string; label: string; tone: Tone }>;
  /** The steps that open it, each a way into the flow. */
  steps: Array<{ id: string; label: string; onOpen?: () => void }>;
  /** Opens or creations per month (a declared estimate); absent when the view is not in use. */
  metric?: number;
  /** In the organization's own views. */
  adopted: boolean;
}

export interface BlockRowModel {
  id: BlockId;
  name: string;
  shows: string;
  reads: string;
  /** What exists in the product already; absent: new. */
  exists?: string;
}

/** What `a05` shows of one view: the sentence of the decision, the originals, what it writes. */
export interface ViewFactsModel {
  decision?: string;
  originals?: string;
  writes?: string;
  base?: string;
}

export interface ViewStepToggle {
  id: string;
  /** The flow and the step the view is used at, as the flow screen names them. */
  flow: string;
  step: string;
  on: boolean;
  onToggle: Action;
  onOpen?: () => void;
}
