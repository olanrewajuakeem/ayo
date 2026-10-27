/**
 * The NGNm–cNGN basis, measured rather than assumed.
 *
 * Mento's NGNm and Textile's cNGN are both naira, and both trade on Celo, but
 * they are different tokens: different issuers, different redemption paths,
 * different holders. They sit at a persistent spread — the first live reading
 * put it at 418bp — and that spread is a fact about the two instruments, not a
 * disagreement about the price of the naira.
 *
 * So the raw gap carries almost no information. The *deviation from its own
 * mean* carries all of it. A basis that has sat at 418bp for hours and then
 * moves to 460 says something happened in one market that the other has not
 * absorbed yet, and that is precisely the moment a filler should widen.
 *
 * This file does the unglamorous part: record every observation, persist it so
 * a restart does not erase the calibration, and refuse to pretend we know the
 * mean before we have actually watched for a while.
 */
import { appendFileSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const STORE = process.env.AYO_BASIS_LOG ?? '.cache/basis.jsonl'

/**
 * Observations needed before the mean is trusted.
 *
 * At one sample per 30s this is about an hour. Fewer than this and a single
 * quiet stretch would masquerade as the long-run level, which is exactly the
 * assumption this file exists to avoid.
 */
export const WARMUP_SAMPLES = 120

/** Observations kept for the rolling window — roughly 12 hours at 30s. */
const WINDOW = 1440

export interface Sample {
  at: string
  textile: number
  mento: number
  basisBps: number
}

export interface BasisStats {
  n: number
  /** Null until WARMUP_SAMPLES is reached — an untrusted mean is worse than none. */
  meanBps: number | null
  stdevBps: number | null
  /** 95th percentile of |observation − mean|, the honest analogue of Stitch's static floor. */
  p95DeviationBps: number | null
  warmedUp: boolean
}

/** Signed basis in bps: how far Textile sits above Mento. */
export function basisBps(textile: number, mento: number): number {
  if (mento <= 0) return Number.NaN
  return ((textile - mento) / mento) * 10_000
}

export function record(s: Sample): void {
  try {
    mkdirSync(dirname(STORE), { recursive: true })
    appendFileSync(STORE, JSON.stringify(s) + '\n')
  } catch {
    // Losing a sample costs calibration accuracy, not correctness. Never let
    // a disk problem stop the agent from quoting.
  }
}

export function load(): Sample[] {
  try {
    const lines = readFileSync(STORE, 'utf8').trim().split('\n').filter(Boolean)
    const out: Sample[] = []
    for (const l of lines) {
      try {
        const s = JSON.parse(l) as Sample
        if (Number.isFinite(s.basisBps)) out.push(s)
      } catch {
        // A truncated final line is normal if the process died mid-append.
      }
    }
    return out.slice(-WINDOW)
  } catch {
    return []
  }
}

export function stats(samples: Sample[] = load()): BasisStats {
  const vals = samples.map((s) => s.basisBps).filter(Number.isFinite)
  const n = vals.length
  if (n === 0) return { n: 0, meanBps: null, stdevBps: null, p95DeviationBps: null, warmedUp: false }

  const mean = vals.reduce((a, b) => a + b, 0) / n
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n
  const stdev = Math.sqrt(variance)

  const deviations = vals.map((v) => Math.abs(v - mean)).sort((a, b) => a - b)
  const p95 = deviations[Math.min(deviations.length - 1, Math.floor(deviations.length * 0.95))]

  const warmedUp = n >= WARMUP_SAMPLES
  return {
    n,
    meanBps: warmedUp ? mean : null,
    stdevBps: warmedUp ? stdev : null,
    p95DeviationBps: warmedUp ? p95 : null,
    warmedUp,
  }
}

/**
 * How far the current basis sits from its own mean, in bps.
 *
 * Null during warmup: with no trusted mean there is no deviation to measure,
 * and inventing one would hand the agent false confidence at exactly the
 * moment it has least information.
 */
export function deviation(currentBasisBps: number, st: BasisStats = stats()): number | null {
  if (!st.warmedUp || st.meanBps === null) return null
  return Math.abs(currentBasisBps - st.meanBps)
}
