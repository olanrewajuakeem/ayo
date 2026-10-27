/**
 * An independent on-chain naira price, from Mento.
 *
 * This is the source other fillers will not have. Mento prices USD against
 * NGNm through its own oracle and AMM pools on Celo — a completely separate
 * price-discovery process from Textile's RFQ makers. When the two agree, the
 * corridor is calm and we can quote tightly. When they diverge, something is
 * moving and the right response is to widen, not to guess which one is right.
 *
 * NGNm and cNGN are different tokens, so this is a *reference* rate, not an
 * arbitrage leg. We never assume we can trade between them.
 *
 * It is read over HTTP from Cowrie, an FX API I built and run on Celo mainnet
 * (https://cowrie-seven.vercel.app). Disclosed deliberately: it is my own
 * service, so it is a dependency I control, and the feed degrades gracefully
 * when it is unavailable rather than silently falling back to one source.
 */
export interface MentoRate {
  rate: number
  asOf: string
  source: 'mento'
}

const COWRIE = process.env.MENTO_FEED_URL ?? 'https://cowrie-seven.vercel.app'

export async function fetchMentoNgn(timeoutMs = 12000): Promise<MentoRate | null> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`${COWRIE}/quote?from=USD&to=NGN&amount=100`, { signal: ctl.signal })
    // 503 is the documented "oracle quiet" response, not a fault. The naira
    // feed goes dark for hours at a time; a filler that treats that as an
    // error instead of as information will quote through a blackout.
    if (!res.ok) return null
    const q = (await res.json()) as { rate?: number; as_of?: string }
    if (typeof q.rate !== 'number' || !Number.isFinite(q.rate) || q.rate <= 0) return null
    return { rate: q.rate, asOf: q.as_of ?? new Date().toISOString(), source: 'mento' }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
