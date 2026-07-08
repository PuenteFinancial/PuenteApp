import { createClient } from '@supabase/supabase-js'
import { env } from '../config/env.js'

export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// GoTrue calls that mint user sessions (signInWithOtp/verifyOtp) must never
// run on supabaseAdmin: supabase-js adopts the minted session in memory even
// with persistSession: false, after which every DB query on that client runs
// as the last-verified user (RLS) instead of service role.
export const supabaseAuth = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})
