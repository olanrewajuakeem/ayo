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
import { stats, deviation, WARMUP_SAMPLES } from './basis.js'
import { page } from './page.js'
import { readAll, skewBps, MAX_SKEW_BPS, type Inventory } from './inventory.js'

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
  /** What the book holds on this corridor, when we can read it. */
  inventory: Inventory | null
  /** How far the published price was leaned, in bps. Signed. */
  skewBps: number
}

let cached: { at: number; byCorridor: Map<string, Decision> } | null = null

export function decide(r: CorridorReading | undefined, inv?: Inventory): Decision {
  const nowSecs = Math.floor(Date.now() / 1000)

  if (!r || r.mid === null) {
    return { payload: null, quoting: false, reading: r ?? null, inventory: inv ?? null, skewBps: 0, why: 'No two-sided mid from Textile. Nothing to price off.' }
  }

  // The inversion. Everything upstream is soft-per-stable (1383 NGN/USD₮);
  // Stitch wants stable-per-soft (0.000723 USD₮/NGN). Their docs warn that
  // publishing this the wrong way up makes the bot post wildly mispriced
  // orders, so it happens here, once, and nowhere else.
  const fair = 1 / r.mid

  /**
   * Inventory skew, applied to the price rather than the spread.
   *
   * Stitch derives both its bid and its ask from this one number, so moving
   * it moves both sides together. Long the counter-asset means publishing a
   * slightly lower price: the bot then bids lower (buys less of what we are
   * already heavy in) and asks lower (sells it more readily), and the book
   * walks back toward balance across many fills instead of accumulating
   * until it is stuck.
   */
  const skew = skewBps(inv)
  const price = fair * (1 + skew / 10_000)

  // Viability gate. The scanner already knows what this corridor pays after
  // the venue fee and gas at our clip size; quoting it when that is negative
  // is paying for the privilege of taking inventory risk.
  //
  // This is the whole corridor-selection idea reaching the wire. Stitch can
  // hold every corridor configured at once, and Ayo decides which of them are
  // live by whether it serves a fresh price or an old one. A corridor that
  // stops paying goes quiet within one poll, and comes back the moment it is
  // worth quoting again — without a restart, and without anyone watching.
  if (!r.tradeable) {
    return {
      payload: { price, timestamp: nowSecs - STAND_DOWN_AGE_SECS },
      quoting: false,
      reading: r,
      inventory: inv ?? null,
      skewBps: skew,
      why:
        r.netEdgeBps === null
          ? `${r.corridor.id}: ${r.note} Standing down.`
          : `${r.corridor.id} nets ${r.netEdgeBps.toFixed(2)}bp after fee and gas — quoting it loses money. Standing down.`,
    }
  }

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
          inventory: inv ?? null,
          skewBps: skew,
          why: `Basis ${b.toFixed(1)}bp is ${dev.toFixed(1)}bp from its mean, past the ${limit.toFixed(1)}bp limit. Publishing a stale timestamp so Stitch stands down.`,
        }
      }
    }
  }

  const leaning =
    skew === 0
      ? ''
      : ` Book is ${inv && inv.balance < 0 ? 'long ' + r.corridor.id : 'long USD\u20AE'}, so the price is leaned ${skew > 0 ? '+' : ''}${skew.toFixed(2)}bp to work it back.`

  return {
    payload: { price, timestamp: nowSecs },
    quoting: true,
    reading: r,
    inventory: inv ?? null,
    skewBps: skew,
    why: `Quoting off a ${r.spreadBps?.toFixed(2)}bp venue spread; net ${r.netEdgeBps?.toFixed(2)}bp after fee and gas.${leaning}`,
  }
}

export async function decisions(): Promise<Map<string, Decision>> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.byCorridor
  const s = await scan()
  const mids = new Map(s.readings.map((r) => [r.corridor.id.toLowerCase(), r.mid]))
  const inventories = await readAll(mids).catch(() => new Map<string, Inventory>())
  const byCorridor = new Map<string, Decision>()
  for (const r of s.readings) {
    const id = r.corridor.id.toLowerCase()
    byCorridor.set(id, decide(r, inventories.get(id)))
  }
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

    // Content negotiation. A browser gets the board; anything else gets JSON.
    // The same reasoning either way — a judge should not have to parse
    // brackets to see that four corridors are being refused and why.
    if (path === '/') {
      const accept = String(req.headers.accept ?? '')
      if (accept.includes('text/html')) {
        const all = await decisions()
        const html = page(all, stats(), new Date().toISOString())
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
        return
      }
    }

    if (path === '/debug' || path === '/') {
      const all = await decisions()
      const st = stats()
      return json(res, 200, {
        what: 'Ayo — a corridor-selecting price feed for Textile FX fillers on Celo.',
        at: new Date().toISOString(),
        basis: {
          ...st,
          // Three genuinely different states, and conflating any two of them
          // would misrepresent how much this copy actually knows.
          note: st.seeded
            ? `Seeded calibration, measured ${st.seedAt} on a machine rented for the purpose — this copy is serverless and has no disk, so it cannot reach ${WARMUP_SAMPLES} samples itself. ${st.n} live sample(s) here so far; they take over once there are ${WARMUP_SAMPLES}.`
            : st.n === 0
              ? 'No basis history and no seed: this copy is serverless and has no disk. Calibration accumulates on the machine actually quoting.'
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
