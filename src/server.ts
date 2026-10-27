/**
 * The price feed Stitch consumes.
 *
 * Textile's filler bot prices every pool off an HTTP endpoint the operator
 * supplies. Their docs are explicit that this is the thing that decides a
 * filler's results — "your quotes are only as good as your feed" — so this is
 * where Ayo lives. Stitch keeps doing the part it is good at (RFQ, EIP-712
 * signing, settlement); the judgment is here.
 *
 * Contract, from Stitch's ADVANCED.md:
 *
 *   GET <feed_url>  ->  { "price": 0.000724, "timestamp": 1760000000 }
 *
 * Two details that will cost money if they are wrong:
 *
 * 1. ORIENTATION. `price` is debt per collateral — the *stable per soft*, e.g.
 *    USD₮ per cNGN, ≈0.000723. Every number we measure and print elsewhere is
 *    the other way up (1383 naira per USD₮). Their docs warn that publishing
 *    the inverted number "makes the bot post wildly mispriced orders". So the
 *    inversion happens here, once, loudly, and nowhere else.
 *
 * 2. STALENESS IS A FEATURE. "If the feed is stale, Stitch skips quoting that
 *    pool rather than posting orders at an old price." That gives us a kill
 *    switch for free: when Ayo is not confident, it does not need to refuse to
 *    answer or invent a wide spread — it publishes an honestly old timestamp
 *    and Stitch stands down by itself.
 */
import { createServer, type ServerResponse } from 'node:http'
import { scan, type CorridorReading } from './scan.js'
import { stats, deviation } from './basis.js'

const PORT = Number(process.env.PORT ?? 8787)

/** Recompute at most this often; Stitch polls faster than the venue moves. */
const CACHE_MS = 5_000

/**
 * How far past its own mean the naira basis may drift before we stop quoting.
 *
 * Not a guess once the log has warmed up: it is set from the measured p95
 * deviation, so the bar adapts to how noisy this pair actually is. Until then
 * we use a deliberately tight default, because quoting confidently on an
 * uncalibrated signal is the expensive mistake.
 */
const UNCALIBRATED_MAX_DEVIATION_BPS = 25

/** Seconds of backdating that will trip any sane `staleness_secs`. */
const STAND_DOWN_AGE_SECS = 3600

interface FeedPayload {
  price: number
  timestamp: number
}

interface Decision {
  payload: FeedPayload | null
  /** Full reasoning, served on /debug and logged. Never sent to Stitch. */
  why: string
  quoting: boolean
  reading: CorridorReading | null
}

let cached: { at: number; byCorridor: Map<string, Decision> } | null = null

function decide(r: CorridorReading | undefined): Decision {
  const nowSecs = Math.floor(Date.now() / 1000)

  if (!r || r.mid === null) {
    return { payload: null, quoting: false, reading: r ?? null, why: 'No two-sided mid from Textile. Nothing to price off.' }
  }

  // The inversion. Everything upstream is soft-per-stable (1383 NGN/USD₮);
  // Stitch wants stable-per-soft (0.000723 USD₮/NGN).
  const price = 1 / r.mid

  // Cross-check, where we have one. A basis that has wandered far from its own
  // mean means one of the two naira markets has repriced and the other has not
  // — we do not know which, and that is exactly when not to be quoting.
  if (r.crossCheck) {
    const st = stats()
    const b = r.crossCheck.basisBps
    if (b !== null) {
      const dev = deviation(b, st)
      const limit = st.warmedUp && st.p95DeviationBps !== null ? st.p95DeviationBps * 2 : UNCALIBRATED_MAX_DEVIATION_BPS
      if (dev !== null && dev > limit) {
        return {
          payload: { price, timestamp: nowSecs - STAND_DOWN_AGE_SECS },
          quoting: false,
          reading: r,
          why: `Basis ${b.toFixed(1)}bp is ${dev.toFixed(1)}bp from its mean, past the ${limit.toFixed(1)}bp limit. Publishing a stale timestamp so Stitch stands down.`,
        }
      }
    }
  }

  return {
    payload: { price, timestamp: nowSecs },
    quoting: true,
    reading: r,
    why: `Quoting off a ${r.spreadBps?.toFixed(2)}bp venue spread; net ${r.netEdgeBps?.toFixed(2)}bp after fee and gas.`,
  }
}

async function decisions(): Promise<Map<string, Decision>> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.byCorridor
  const s = await scan()
  const byCorridor = new Map<string, Decision>()
  for (const r of s.readings) byCorridor.set(r.corridor.id.toLowerCase(), decide(r))
  cached = { at: Date.now(), byCorridor }
  return byCorridor
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  const s = JSON.stringify(body, null, 2)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(s)
}

export function start(port = PORT) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    try {
      // Stitch wants one feed per pool, so the corridor is in the path.
      const feed = path.match(/^\/feed\/([a-z0-9]+)$/i)
      if (feed) {
        const d = (await decisions()).get(feed[1].toLowerCase())
        if (!d) return json(res, 404, { error: `No corridor "${feed[1]}". Try /debug.` })
        if (!d.payload) return json(res, 503, { error: d.why })
        // Exactly the two fields Stitch reads, nothing else.
        return json(res, 200, d.payload)
      }

      if (path === '/debug') {
        const all = await decisions()
        return json(res, 200, {
          at: new Date().toISOString(),
          basis: stats(),
          corridors: [...all.entries()].map(([id, d]) => ({
            id,
            quoting: d.quoting,
            why: d.why,
            publishedPrice: d.payload?.price ?? null,
            venueMid: d.reading?.mid ?? null,
            spreadBps: d.reading?.spreadBps ?? null,
            netEdgeBps: d.reading?.netEdgeBps ?? null,
          })),
        })
      }

      if (path === '/healthz') return json(res, 200, { ok: true })

      return json(res, 404, {
        error: `No endpoint at ${path}.`,
        endpoints: ['/feed/{corridor}', '/debug', '/healthz'],
      })
    } catch (err) {
      return json(res, 500, { error: (err as Error).message })
    }
  })

  server.listen(port, () => {
    console.log(`\n  Ayo feed on http://localhost:${port}`)
    console.log(`  Stitch feed_url  →  http://localhost:${port}/feed/cngn`)
    console.log(`  Reasoning        →  http://localhost:${port}/debug\n`)
  })
  return server
}

start()
