/**
 * A calibration the deployed copy could not have computed itself.
 *
 * `basis.ts` will not report a mean before WARMUP_SAMPLES observations, and the
 * hosted copy has no disk, so it never reaches them — it stands down on the
 * naira permanently. The way out was to buy an hour of a machine that keeps a
 * file, run the real calibration there, and commit the answer.
 *
 * So this is not a constant someone typed. It is the output of a measured run,
 * carried here because the environment that needs it cannot produce it. The
 * transaction that paid for the machine is recorded alongside, which is the only
 * reason to trust the provenance of a number in a file.
 *
 * It is a *prior*, not a substitute for watching. Live samples outrank it as
 * soon as there are enough of them, and anything reading it is told it is seeded
 * rather than observed — see `/debug`.
 *
 * Set to null when there is no such run to point at. A seed invented rather than
 * measured would be worse than none, for exactly the reason basis.ts refuses to
 * average twelve samples.
 */
export interface BasisSeed {
  /** When the calibrating run finished. */
  at: string
  /** Observations behind the figures below. */
  n: number
  meanBps: number
  stdevBps: number
  p95DeviationBps: number
  /** Where it ran, in words. */
  source: string
  /** The x402 payment that bought the machine, for provenance. */
  transaction?: string
}

/**
 * Measured on the laptop that did the five days of quoting, not on the machine
 * that was rented to produce it.
 *
 * The rented hour was bought and ran, and returned nothing: the calibration
 * script was written to print only at completion, the lease expired a few
 * minutes short, and the gateway retains a result only for a script it saw
 * finish. The payment is real and verifiable; the data it was supposed to buy is
 * gone. The README says so, because a seed whose provenance is overstated is the
 * one thing this file cannot afford to be.
 *
 * So these are local samples — genuinely observed, just not bought. `n` is the
 * rolling window, which at 30-second cadence spans the eight days of intermittent
 * watching between the two timestamps rather than a continuous twelve hours.
 */
export const SEED: BasisSeed | null = {
  at: '2026-11-04T18:09:48.198Z',
  n: 1440,
  meanBps: 401.8439637145767,
  stdevBps: 13.970799830314883,
  p95DeviationBps: 20.44532735093952,
  source: 'local log, 2026-10-28T06:24:38Z to 2026-11-04T18:09:48Z',
}
