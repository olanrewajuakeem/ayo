/**
 * Scan every live corridor and rank them by what they would actually pay us.
 *
 * This is the decision the agent makes before any other: where to put a small
 * book. Everything downstream — quoting, inventory skew, risk limits — only
 * matters once the inventory is somewhere worth quoting.
 *
 * The ranking is deliberately not "widest spread wins". A wide spread on a
 * corridor with no bid is untradeable. A tight spread we can cross-check is
 * safer than a wide one we cannot. And every corridor is measured after the
 * costs that a small book cannot ignore.
 */
import { fetchTickers, mid, type Ticker } from './sources/textile.js'
import { fetchMentoNgn } from './sources/mento.js'
import { basisBps, stats, deviation, record, type BasisStats } from './basis.js'
import { CORRIDORS, netEdgeBps, gasBps, PROTOCOL_FEE_BPS, type Corridor } from './corridors.js'
import { recordScan } from './log.js'

export interface CorridorReading {
  corridor: Corridor
  mid: number | null
  bid: number | null
  ask: number | null
  /** The venue's own spread, in bps. Null when one side is missing. */
  spreadBps: number | null
  /** Spread we keep after capture share, protocol fee and gas. */
  netEdgeBps: number | null
  /** Quotable at all: two-sided and net-positive at this clip. */
  tradeable: boolean
  /** Independent cross-check, where one exists. */
  crossCheck: {
    reference: number | null
    basisBps: number | null
    deviationBps: number | null
    stats: BasisStats | null
  } | null
  note: string
}

export interface Scan {
  at: string
  clipUsd: number
  gasBps: number
  readings: CorridorReading[]
  /** Best corridor to deploy into, or null when none clears costs. */
  best: CorridorReading | null
}

function spreadOf(t: Ticker | null): number | null {
  if (!t || t.bid === null || t.ask === null) return null
  const m = (t.bid + t.ask) / 2
  if (m <= 0) return null
  // Textile quotes some pairs with bid above ask in the tickers feed, which is
  // a quoting-direction artefact rather than a crossed book. The magnitude is
  // what matters, so take it.
  return (Math.abs(t.ask - t.bid) / m) * 10_000
}

export async function scan(clipUsd = 25): Promise<Scan> {
  const at = new Date().toISOString()
  const [tickers, mento] = await Promise.all([
    fetchTickers().catch(() => [] as Ticker[]),
    fetchMentoNgn().catch(() => null),
  ])

  const byTicker = new Map(tickers.map((t) => [t.pair.toUpperCase(), t]))
  const g = gasBps(clipUsd)

  const readings: CorridorReading[] = CORRIDORS.map((corridor) => {
    const t = byTicker.get(corridor.ticker.toUpperCase()) ?? null
    const m = mid(t)
    const spreadBps = spreadOf(t)
    const net = spreadBps === null ? null : netEdgeBps(spreadBps, clipUsd)

    let crossCheck: CorridorReading['crossCheck'] = null
    if (corridor.crossCheck === 'mento-ngnm') {
      const ref = mento?.rate ?? null
      const b = ref !== null && m !== null ? basisBps(m, ref) : null
      if (b !== null && Number.isFinite(b)) {
        // Persist every naira observation — this is the calibration set that
        // lets the basis mean mean something later.
        record({ at, textile: m!, mento: ref!, basisBps: b })
      }
      const st = stats()
      crossCheck = {
        reference: ref,
        basisBps: b,
        deviationBps: b === null ? null : deviation(b, st),
        stats: st,
      }
    }

    const tradeable = spreadBps !== null && net !== null && net > 0

    const note =
      spreadBps === null
        ? t
          ? 'One-sided — nobody is quoting both sides, so there is no round trip.'
          : 'Not in the tickers feed right now.'
        : net !== null && net <= 0
          ? `Spread ${spreadBps.toFixed(2)}bp does not clear ${(PROTOCOL_FEE_BPS + g).toFixed(2)}bp of fee and gas at a $${clipUsd} clip.`
          : `Net ${net!.toFixed(2)}bp after fee and gas.`

    return { corridor, mid: m, bid: t?.bid ?? null, ask: t?.ask ?? null, spreadBps, netEdgeBps: net, tradeable, crossCheck, note }
  })

  // Rank by net edge, but a cross-checkable corridor breaks ties upward: given
  // two similar edges, prefer the one where we have a second opinion on price.
  const ranked = [...readings]
    .filter((r) => r.tradeable)
    .sort((a, b) => {
      const d = (b.netEdgeBps ?? 0) - (a.netEdgeBps ?? 0)
      if (Math.abs(d) > 0.25) return d
      return (b.corridor.crossCheck ? 1 : 0) - (a.corridor.crossCheck ? 1 : 0)
    })

  const result = { at, clipUsd, gasBps: g, readings, best: ranked[0] ?? null }
  recordScan(result)
  return result
}
