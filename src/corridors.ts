/**
 * The live Celo corridors, and what it actually costs to quote each one.
 *
 * Textile runs five corridors on Celo (42220): cNGN, USDC, wARS, wBRL and
 * IDRX, all against USD₮. A filler hardcoded to one of them is making a bet it
 * never re-examines. The first live scan showed why that is expensive — the
 * venue spread across those five ranged from 0.65bp to 9.2bp, a factor of
 * fourteen, and one of them had no bid at all.
 *
 * The scarce resource here is not ideas, it is inventory. With a small book,
 * every dollar parked on a 0.65bp corridor is a dollar not earning 9bp
 * somewhere else, so corridor choice dominates every other decision the agent
 * makes.
 */
export interface Corridor {
  /** Our name for it — the non-USD side. */
  id: string
  /** The pair id as it appears in Textile's public tickers feed. */
  ticker: string
  /** The counter-asset's human label. */
  label: string
  /**
   * Whether we hold an independent second opinion on this corridor's price.
   * Only the naira has one, through Mento's NGNm market on the same chain.
   * A corridor we can cross-check can be quoted with more confidence than one
   * where Textile is the only thing telling us what the price is.
   */
  crossCheck: 'mento-ngnm' | null
}

export const CORRIDORS: Corridor[] = [
  { id: 'cNGN', ticker: 'USDT_NGN', label: 'Nigerian naira', crossCheck: 'mento-ngnm' },
  { id: 'IDRX', ticker: 'USDT_IDR', label: 'Indonesian rupiah', crossCheck: null },
  { id: 'wBRL', ticker: 'USDT_WBRL', label: 'Brazilian real', crossCheck: null },
  { id: 'wARS', ticker: 'USDT_WARS', label: 'Argentine peso', crossCheck: null },
  { id: 'USDC', ticker: 'USDC_USDT', label: 'USD Coin', crossCheck: null },
]

/**
 * Textile's taker fee on Celo, in bps. Quoted in their docs and charged by the
 * SellFirstFeeController, included in the rate the trader sees.
 */
export const PROTOCOL_FEE_BPS = 1

/**
 * What gas costs as a fraction of a fill, in bps, at a given clip size.
 *
 * This is the line that small books forget. Celo gas is sub-cent in absolute
 * terms, which reads as "free" until the clip is small: half a cent on a $25
 * fill is 2bp, which is three times the entire spread on the naira corridor.
 *
 * Expressed as a function of size rather than a constant, because the whole
 * point is that it is not one.
 */
export function gasBps(clipUsd: number, gasCostUsd = 0.005): number {
  if (clipUsd <= 0) return Number.POSITIVE_INFINITY
  return (gasCostUsd / clipUsd) * 10_000
}

/**
 * The spread we can realistically capture, in bps.
 *
 * A filler quoting inside the existing book does not take the whole spread —
 * it has to improve on the best price to win the request, and the trader keeps
 * the improvement. Half is the conventional assumption and the honest one:
 * quote at the midpoint of the current book and you win roughly the flow that
 * would otherwise have crossed, earning half of what the incumbents earn.
 */
export const CAPTURE_SHARE = 0.5

/**
 * Net edge per round trip, in bps, after everything that is taken off the top.
 *
 * Negative means quoting that corridor loses money at that clip size — which,
 * at the sizes this agent can afford, is true of more corridors than it is not.
 */
export function netEdgeBps(spreadBps: number, clipUsd: number): number {
  return spreadBps * CAPTURE_SHARE - PROTOCOL_FEE_BPS - gasBps(clipUsd)
}
