/**
 * Textile's own public tickers feed.
 *
 * No auth, no key: https://api.textilecredit.com/tickers in CoinGecko tickers
 * format. This is what the venue itself thinks the corridor is worth, so it is
 * the anchor the other sources are judged against — but it is not independent
 * of the venue, which is exactly why it cannot be the only source.
 *
 * A filler quoting purely off this is quoting off its own competitors' prices,
 * and inherits every mistake they make at the same moment.
 */
export interface Ticker {
  pair: string
  last: number | null
  bid: number | null
  ask: number | null
}

const TICKERS_URL = 'https://api.textilecredit.com/tickers'

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  // Textile sends 0 for "no quote on this side" rather than omitting the key.
  return Number.isFinite(n) && n !== 0 ? n : null
}

export async function fetchTickers(timeoutMs = 8000): Promise<Ticker[]> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(TICKERS_URL, { signal: ctl.signal })
    if (!res.ok) throw new Error(`textile tickers ${res.status}`)
    const raw = (await res.json()) as unknown
    const rows = Array.isArray(raw) ? raw : []
    return rows.map((r) => {
      const t = r as Record<string, unknown>
      return {
        pair: String(t.ticker_id ?? `${t.base_currency}_${t.target_currency}`),
        last: num(t.last_price),
        bid: num(t.bid),
        ask: num(t.ask),
      }
    })
  } finally {
    clearTimeout(timer)
  }
}

/** One pair, or null when the venue is not quoting it right now. */
export async function fetchPair(pair: string): Promise<Ticker | null> {
  const all = await fetchTickers()
  return all.find((t) => t.pair.toUpperCase() === pair.toUpperCase()) ?? null
}

/**
 * Mid from a two-sided quote.
 *
 * Returns null when either side is missing: a one-sided market has no mid, and
 * guessing one from `last` would quietly invent a price the venue never showed.
 * Most of Textile's 18 pairs are one-sided at any moment, so this matters.
 */
export function mid(t: Ticker | null): number | null {
  if (!t || t.bid === null || t.ask === null) return null
  return (t.bid + t.ask) / 2
}
