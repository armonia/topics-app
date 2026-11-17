/**
 * The shapes of `GET /api/usage/people` and `GET /api/usage/people/:personId`,
 * written once for server and client (`tests/unit/no-type-mirrors.test.ts`).
 */

/** One person and how much they spent in the window. */
export interface PersonUsageRow {
  /** null = the calls with no author. */
  personId: string | null;
  name: string;
  /** Weighted tokens (input + 5·output + 1.25·cache write + 0.1·cache read). */
  weighted: number;
  /** % of one weekly account; null without quota history. */
  accountPct: number | null;
  /** Share of the attributed total, in %. */
  sharePct: number;
  /** Born from a channel only: it can be merged into another person. */
  canMerge: boolean;
}

export interface PeopleUsageMeta {
  days: number;
  since: string;
  until: string;
  /** false = no quota history: only the weighted tokens are known. */
  quotaHistory: boolean;
  /** Points spent by every account in the window (100 = one weekly account). */
  totalPoints: number | null;
  /** Points given to a call Topics saw (the rest had no call in that hour). */
  attributedPoints: number | null;
}

export interface PeopleUsage extends PeopleUsageMeta {
  people: PersonUsageRow[];
}

/** One request (the message that started the work) and what it cost. */
export interface PersonRequestRow {
  chatKey: string;
  chatName: string;
  requestId: string | null;
  request: string;
  at: string;
  calls: number;
  weighted: number;
  accountPct: number | null;
}

export interface PersonUsageDetail extends PeopleUsageMeta {
  personId: string | null;
  name: string;
  requests: PersonRequestRow[];
}
