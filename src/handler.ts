/**
 * Request handling, shared between the local server and the deployed one.
 *
 * Stitch reads the feed from whichever of the two is closer: running locally,
 * it polls localhost and pays no network cost. The deployed copy exists so the
 * reasoning is inspectable by someone who is not sitting at this laptop —
 * judges included.
 *
 * One honest difference between them: the deployed copy is serverless and has
 * no disk, so the basis calibration does not accumulate there. The numbers it
 * shows are live; the basis history belongs to the machine actually quoting.
 * /debug says so rather than implying a longer record than exists.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { scan, type CorridorReading } from './scan.js'
import { stats, deviation } from './basis.js'

/** Recompute at most this often; Stitch polls faster than the venue moves. */
const CACHE_MS = 5_000

/**
 * How far past its own mean the naira basis may drift before we stop quoting.
 *
 * Once the log has warmed up this comes from the measured p95 deviation, so
 * the bar adapts to how noisy the pair actually is. Until then it is a
 * deliberately tight default: quoting confidently off an uncalibrated signal
 * is the expensive mistake.
 */
const UNCALIBRATED_MAX_DEVIATION_BPS = 25

/** Seconds of backdating that will trip any sane `staleness_secs`. */
const STAND_DOWN_AGE_SECS = 3600

export interface FeedPayload {
  price: number
  timestamp: number
}

export interface Decision {
  payload: FeedPayload | null
  /** Full reasoning, served on /debug. Never sent to Stitch. */
  why: string
  quoting: boolean
  reading: CorridorReading | null
}

let cached: { at: number; byCorridor: Map<string, Decision> } | null = null

export function decide(r: CorridorReading | undefined): Decision {
  const nowSecs = Math.floor(Date.now() / 1000)

  if (!r || r.mid === null) {
    return { payload: null, quoting: false, reading: r ?? null, why: 'No two-sided mid from Textile. Nothing to price off.' }
  }

  // The inversion. Everything upstream is soft-per-stable (1383 NGN/USD₮);
  // Stitch wants stable-per-soft (0.000723 USD₮/NGN). Their docs warn that
  // publishing this the wrong way up makes the bot post wildly mispriced
  // orders, so it happens here, once, and nowhere else.
  const price = 1 / r.mid

  if (r.crossCheck) {
    const st = stats()
    const b = r.crossCheck.basisBps
    if (b !== null) {
      const dev = deviation(b, st)
      const limit = st.warmedUp && st.p95DeviationBps !== null ? st.p95DeviationBps * 2 : UNCALIBRATED_MAX_DEVIATION_BPS
      if (dev !== null && dev > limit) {
        // Not a refusal and not a wide quote — an honestly old timestamp.
        // Stitch skips a stale pool by itself, so this is a kill switch the
        // venue already understands.
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

export async function decisions(): Promise<Map<string, Decision>> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.byCorridor
  const s = await scan()
  const byCorridor = new Map<string, Decision>()
  for (const r of s.readings) byCorridor.set(r.corridor.id.toLowerCase(), decide(r))
  cached = { at: Date.now(), byCorridor }
  return byCorridor
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body, null, 2))
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  // Vercel rewrites every request through /api/*, so the deployed copy sees an
  // extra prefix the local server never does. Strip it here rather than in two
  // entry points, so both see identical paths and cannot diverge.
  const path = url.pathname.replace(/^\/api(?=\/|$)/, '').replace(/\/+$/, '') || '/'

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

    if (path === '/debug' || path === '/') {
      const all = await decisions()
      const st = stats()
      return json(res, 200, {
        what: 'Ayo — a corridor-selecting price feed for Textile FX fillers on Celo.',
        at: new Date().toISOString(),
        basis: {
          ...st,
          note: st.n === 0
            ? 'No basis history here: this copy is serverless and has no disk. Calibration accumulates on the machine actually quoting.'
            : undefined,
        },
        corridors: [...all.entries()].map(([id, d]) => ({
          id,
          quoting: d.quoting,
          why: d.why,
          publishedPrice: d.payload?.price ?? null,
          venueMid: d.reading?.mid ?? null,
          spreadBps: d.reading?.spreadBps ?? null,
          netEdgeBps: d.reading?.netEdgeBps ?? null,
        })),
        endpoints: ['/feed/{corridor}', '/debug', '/healthz'],
      })
    }

    if (path === '/healthz') return json(res, 200, { ok: true })

    return json(res, 404, { error: `No endpoint at ${path}.`, endpoints: ['/feed/{corridor}', '/debug', '/healthz'] })
  } catch (err) {
    return json(res, 500, { error: (err as Error).message })
  }
}
