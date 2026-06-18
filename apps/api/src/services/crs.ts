/**
 * CRS Credit API service
 * Wraps all CRS API calls. NEVER called from client — server only.
 *
 * Caching strategy: cache score for 24 hours per user.
 * CRS charges per pull — do not re-pull if fresh data exists.
 *
 * FCRA: Only call after verifying user has completed consent flow.
 */

const CRS_API_URL = process.env.CRS_API_URL!
const CRS_API_KEY = process.env.CRS_API_KEY!
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

// In-memory cache for MVP. Replace with Redis when scaling.
const scoreCache = new Map<string, { data: CreditScoreResult; fetchedAt: number }>()

export interface CreditScoreResult {
  score: number
  range: { min: number; max: number }
  factors: string[]
  fetchedAt: string
  cached: boolean
}

export async function getCreditScore(userId: string): Promise<CreditScoreResult> {
  // Check cache first
  const cached = scoreCache.get(userId)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { ...cached.data, cached: true }
  }

  // TODO: fetch user SSN/DOB from Supabase (encrypted) to pass to CRS
  // TODO: implement actual CRS API call
  const response = await fetch(`${CRS_API_URL}/score`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CRS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ userId }), // replace with actual CRS payload
  })

  if (!response.ok) {
    throw new Error(`CRS API error: ${response.status}`)
  }

  const raw = await response.json() as { score: number; factors: string[] }

  const result: CreditScoreResult = {
    score: raw.score,
    range: { min: 300, max: 850 },
    factors: raw.factors,
    fetchedAt: new Date().toISOString(),
    cached: false,
  }

  scoreCache.set(userId, { data: result, fetchedAt: Date.now() })
  return result
}
