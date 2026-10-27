/**
 * Every scan, kept.
 *
 * Two readings of the same corridor four hours apart came back at 0.65bp and
 * 18.15bp. That is a factor of twenty-eight on the only number that decides
 * whether quoting it makes money, and it is the entire case for an agent that
 * re-decides instead of being configured once.
 *
 * One observation is an anecdote and two is a coincidence, so this records
 * every corridor on every scan. What it buys:
 *
 *   - the intraday shape of each corridor's spread, which is the evidence
 *   - a measured answer to "what clip size is viable on this corridor", rather
 *     than the guess currently hardcoded as a default
 *   - the ability to show a judge the working, not the conclusion
 *
 * JSONL because it survives a kill -9 mid-write, and because the analysis is
 * one pass with no index.
 */
import { appendFileSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Scan } from './scan.js'

const STORE = process.env.AYO_SCAN_LOG ?? '.cache/scans.jsonl'

export interface ScanRow {
  at: string
  corridor: string
  mid: number | null
  spreadBps: number | null
  /** Clip-independent: net edge is recomputed per clip at analysis time. */
  basisBps?: number | null
}

export function recordScan(s: Scan): void {
  try {
    mkdirSync(dirname(STORE), { recursive: true })
    const rows = s.readings.map<ScanRow>((r) => ({
      at: s.at,
      corridor: r.corridor.id,
      mid: r.mid,
      spreadBps: r.spreadBps,
      ...(r.crossCheck ? { basisBps: r.crossCheck.basisBps } : {}),
    }))
    appendFileSync(STORE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  } catch {
    // Never let the log stop the scan.
  }
}

export function loadScans(): ScanRow[] {
  try {
    return readFileSync(STORE, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as ScanRow]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

export interface CorridorSummary {
  corridor: string
  n: number
  minSpreadBps: number
  medianSpreadBps: number
  maxSpreadBps: number
  /** Share of observations where the corridor was two-sided at all. */
  quotableShare: number
}

/** What each corridor has actually looked like, rather than what it looks like now. */
export function summarise(rows: ScanRow[] = loadScans()): CorridorSummary[] {
  const byCorridor = new Map<string, ScanRow[]>()
  for (const r of rows) {
    const list = byCorridor.get(r.corridor) ?? []
    list.push(r)
    byCorridor.set(r.corridor, list)
  }

  return [...byCorridor.entries()]
    .map(([corridor, list]) => {
      const spreads = list
        .map((r) => r.spreadBps)
        .filter((v): v is number => v !== null && Number.isFinite(v))
        .sort((a, b) => a - b)
      if (spreads.length === 0) {
        return { corridor, n: list.length, minSpreadBps: NaN, medianSpreadBps: NaN, maxSpreadBps: NaN, quotableShare: 0 }
      }
      return {
        corridor,
        n: list.length,
        minSpreadBps: spreads[0],
        medianSpreadBps: spreads[Math.floor(spreads.length / 2)],
        maxSpreadBps: spreads[spreads.length - 1],
        quotableShare: spreads.length / list.length,
      }
    })
    .sort((a, b) => (b.medianSpreadBps || 0) - (a.medianSpreadBps || 0))
}
