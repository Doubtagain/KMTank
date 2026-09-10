/**
 * Ranked ladder: MMR, tiers and the multiplayer Elo update.
 */

export const STARTING_MMR = 1000;
/** Ranked matches you must finish before a tier is shown. */
export const PLACEMENT_MATCHES = 5;
/** MMR floor. Ratings never drop below this. */
export const MMR_FLOOR = 100;

export interface TierDef {
  key: string;
  name: string;
  /** Inclusive lower bound of the tier. */
  min: number;
  /** Number of divisions inside the tier (counted down: III, II, I). */
  divisions: number;
  color: string;
}

/** Ordered from lowest to highest. The last tier is open-ended. */
export const TIERS: TierDef[] = [
  { key: 'bronze', name: 'Bronze', min: 0, divisions: 3, color: '#a2703f' },
  { key: 'silver', name: 'Silver', min: 800, divisions: 3, color: '#b6c0cc' },
  { key: 'gold', name: 'Gold', min: 1100, divisions: 3, color: '#e2b344' },
  { key: 'platinum', name: 'Platinum', min: 1400, divisions: 3, color: '#4fd6c8' },
  { key: 'diamond', name: 'Diamond', min: 1700, divisions: 3, color: '#59a8ff' },
  { key: 'master', name: 'Master', min: 2000, divisions: 3, color: '#b06bff' },
  { key: 'grandmaster', name: 'Grandmaster', min: 2300, divisions: 3, color: '#ff5f6d' },
  { key: 'challenger', name: 'Challenger', min: 2600, divisions: 1, color: '#ffd24a' },
];

export const ROMAN = ['I', 'II', 'III', 'IV', 'V'];

export interface RankInfo {
  tier: TierDef;
  /** 1 is the highest division inside a tier. */
  division: number;
  /** e.g. "Gold II", or just "Challenger" for single-division tiers. */
  label: string;
  /** Progress towards the next division, 0..1. */
  progress: number;
  mmr: number;
  placed: boolean;
}

/** Unranked placeholder shown while a player is still in placements. */
export function unrankedInfo(mmr: number, matchesPlayed: number): RankInfo {
  return {
    tier: TIERS[0],
    division: TIERS[0].divisions,
    label: `Placements ${Math.min(matchesPlayed, PLACEMENT_MATCHES)}/${PLACEMENT_MATCHES}`,
    progress: Math.min(matchesPlayed, PLACEMENT_MATCHES) / PLACEMENT_MATCHES,
    mmr,
    placed: false,
  };
}

/** Resolve an MMR value into a tier, division and progress bar. */
export function rankFor(mmr: number, matchesPlayed = PLACEMENT_MATCHES): RankInfo {
  if (matchesPlayed < PLACEMENT_MATCHES) return unrankedInfo(mmr, matchesPlayed);

  let index = 0;
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (mmr >= TIERS[i].min) {
      index = i;
      break;
    }
  }
  const tier = TIERS[index];
  const next = TIERS[index + 1];
  const span = (next ? next.min : tier.min + 300) - tier.min;
  const divisionSpan = span / tier.divisions;
  const into = Math.max(0, mmr - tier.min);

  if (tier.divisions === 1) {
    return {
      tier,
      division: 1,
      label: tier.name,
      progress: Math.min(1, into / span),
      mmr,
      placed: true,
    };
  }

  const step = Math.min(tier.divisions - 1, Math.floor(into / divisionSpan));
  const division = tier.divisions - step;
  const progress = (into - step * divisionSpan) / divisionSpan;

  return {
    tier,
    division,
    label: `${tier.name} ${ROMAN[division - 1]}`,
    progress: Math.max(0, Math.min(1, progress)),
    mmr,
    placed: true,
  };
}

// ---------------------------------------------------------------------------
// Rating update
// ---------------------------------------------------------------------------

export interface RatedResult {
  userId: string;
  mmr: number;
  /** 1 = best. Ties share a placement number. */
  placement: number;
  matchesPlayed: number;
}

export interface RatingDelta {
  userId: string;
  before: number;
  after: number;
  delta: number;
}

/** K-factor: volatile during placements, damped at the very top. */
export function kFactor(mmr: number, matchesPlayed: number): number {
  if (matchesPlayed < PLACEMENT_MATCHES) return 56;
  if (mmr >= 2300) return 20;
  if (mmr >= 2000) return 26;
  return 32;
}

const expectedScore = (a: number, b: number): number => 1 / (1 + Math.pow(10, (b - a) / 400));

/**
 * Free-for-all Elo: every player is scored against every other player, and the
 * pairwise deltas are averaged. A win against the whole lobby is worth roughly
 * one K; a mid-table finish is close to neutral.
 */
export function computeRatingDeltas(results: RatedResult[]): RatingDelta[] {
  const n = results.length;
  if (n < 2) {
    return results.map((r) => ({ userId: r.userId, before: r.mmr, after: r.mmr, delta: 0 }));
  }

  return results.map((self) => {
    let sum = 0;
    for (const other of results) {
      if (other.userId === self.userId) continue;
      const actual =
        self.placement < other.placement ? 1 : self.placement > other.placement ? 0 : 0.5;
      sum += actual - expectedScore(self.mmr, other.mmr);
    }
    const k = kFactor(self.mmr, self.matchesPlayed);
    const delta = Math.round((k * sum) / (n - 1));
    const after = Math.max(MMR_FLOOR, self.mmr + delta);
    return { userId: self.userId, before: self.mmr, after, delta: after - self.mmr };
  });
}
