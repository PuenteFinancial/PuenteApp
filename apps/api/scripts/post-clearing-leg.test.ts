import { describe, it, expect } from 'vitest'
import { parseArgs, repairRefusal, type RepairCandidateRow } from './post-clearing-leg.js'

// The clearing-leg repair CLI. The dangerous property of the applier it drives
// is that applyFundingCleared SETS funding_cleared unconditionally — so the
// whole safety story of this script is (1) arg parsing that cannot silently
// reinterpret a mistyped command, and (2) the refusal gate that only lets an
// already-flagged transfer through.

const flagged: RepairCandidateRow = {
  state: 'FUNDED',
  funding_cleared: true,
  send_amount_minor: 500,
  fee_amount_minor: 0,
  margin_minor: 5,
}

describe('parseArgs', () => {
  it('requires --transfer', () => {
    expect(() => parseArgs([])).toThrow(/--transfer is required/)
    expect(() => parseArgs(['--confirm'])).toThrow(/--transfer is required/)
  })

  it('rejects a non-UUID rather than letting a fragment reach the DB', () => {
    expect(() => parseArgs(['--transfer', '681c8e1a'])).toThrow(/must be a UUID/)
    expect(() => parseArgs(['--transfer', 'not-an-id'])).toThrow(/must be a UUID/)
  })

  it('rejects a --transfer that swallowed the next flag', () => {
    expect(() => parseArgs(['--transfer', '--confirm'])).toThrow(/--transfer is required/)
  })

  it('rejects an unknown flag rather than silently ignoring it', () => {
    expect(() =>
      parseArgs(['--transfer', '681c8e1a-71b0-40c1-aa20-25f78e0bcf76', '--force']),
    ).toThrow(/unknown flag/)
  })

  it('defaults to a dry run — posting requires --confirm', () => {
    expect(parseArgs(['--transfer', '681c8e1a-71b0-40c1-aa20-25f78e0bcf76'])).toEqual({
      transferId: '681c8e1a-71b0-40c1-aa20-25f78e0bcf76',
      confirm: false,
    })
    expect(
      parseArgs(['--transfer', '681c8e1a-71b0-40c1-aa20-25f78e0bcf76', '--confirm']).confirm,
    ).toBe(true)
  })

  it('lowercases the id so ledger keys stay canonical', () => {
    expect(parseArgs(['--transfer', '681C8E1A-71B0-40C1-AA20-25F78E0BCF76']).transferId).toBe(
      '681c8e1a-71b0-40c1-aa20-25f78e0bcf76',
    )
  })
})

describe('repairRefusal — the gate in front of an applier that sets the flag', () => {
  it('refuses a missing transfer', () => {
    expect(repairRefusal(null)).toMatch(/no such transfer/)
  })

  it('refuses when funding_cleared is not set — repairing must never mean clearing', () => {
    expect(repairRefusal({ ...flagged, funding_cleared: false })).toMatch(/never sets clearing/)
  })

  it('passes an already-flagged transfer through', () => {
    expect(repairRefusal(flagged)).toBeNull()
  })
})
