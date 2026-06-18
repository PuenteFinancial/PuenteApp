export interface CreditScoreRange {
  min: number
  max: number
}

export type CreditTier =
  | 'poor'        // 300–579
  | 'fair'        // 580–669
  | 'good'        // 670–739
  | 'very_good'   // 740–799
  | 'exceptional' // 800–850

export interface CreditScore {
  score: number
  tier: CreditTier
  range: CreditScoreRange
  factors: string[]
  fetchedAt: string
  cached: boolean
}

export interface CreditScoreUnlock {
  tier: CreditTier
  minScore: number
  examples: string[] // e.g. "Auto loan at 4.9% APR", "Credit card with $2k limit"
}

// What unlocks at each tier — used in the UI to show users what they're building toward
export const CREDIT_TIER_UNLOCKS: CreditScoreUnlock[] = [
  {
    tier: 'poor',
    minScore: 300,
    examples: ['Secured credit card', 'Credit-builder loan'],
  },
  {
    tier: 'fair',
    minScore: 580,
    examples: ['Basic unsecured credit card', 'Some auto loans'],
  },
  {
    tier: 'good',
    minScore: 670,
    examples: ['Auto loan at ~6% APR', 'Credit card with rewards', 'Personal loan'],
  },
  {
    tier: 'very_good',
    minScore: 740,
    examples: ['Auto loan at ~4% APR', 'Premium rewards card', 'Mortgage qualification'],
  },
  {
    tier: 'exceptional',
    minScore: 800,
    examples: ['Best mortgage rates', 'Top-tier rewards cards', 'Lowest auto loan rates'],
  },
]

export function getCreditTier(score: number): CreditTier {
  if (score >= 800) return 'exceptional'
  if (score >= 740) return 'very_good'
  if (score >= 670) return 'good'
  if (score >= 580) return 'fair'
  return 'poor'
}
