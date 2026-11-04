/**
 * What five days of watching every Celo corridor actually showed.
 *
 * The argument for this agent has been an assertion: that a statically
 * configured filler is wrong most of the time because the thing it is
 * configured against moves. This turns that into a measurement.
 *
 * Every scan since 27 October is in .cache/scans.jsonl — five corridors,
 * every thirty seconds. The questions worth answering from it:
 *
 *   1. How far does a corridor's spread actually travel in a week?
 *   2. At the clip sizes a small book can afford, how often does each
 *      corridor clear its costs at all?
 *   3. How often is the corridor everyone configures by default — cNGN,
 *      the one Stitch preloads — the wrong place to be?
 *
 * The third is the one that matters. Every operator who installs Stitch and
 * picks the default is answering a question once that has a different answer
 * every hour.
 *
 *   npx tsx src/analyse.ts              at the default clips
 *   npx tsx src/analyse.ts --clip 10    one specific size
 */
import { loadScans, type ScanRow } from './log.js'
import { netEdgeBps, gasBps, PROTOCOL_FEE_BPS, CAPTURE_SHARE } from './corridors.js'

const CLIPS = [10, 25, 50, 100]

const pct = (part: number, whole: number) => (whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`)
const pad = (s: string, w: number) => s.padEnd(w)
const padL = (s: string, w: number) => s.padStart(w)

interface ByCorridor {
  id: string
  rows: ScanRow[]
  spreads: number[]
}

function group(rows: ScanRow[]): ByCorridor[] {
  const m = new Map<string, ScanRow[]>()
  for (const r of rows) {
    const list = m.get(r.corridor) ?? []
    list.push(r)
    m.set(r.corridor, list)
  }
  return [...m.entries()].map(([id, list]) => ({
    id,
    rows: list,
    spreads: list.map((r) => r.spreadBps).filter((v): v is number => v !== null && Number.isFinite(v)),
  }))
}

const quantile = (sorted: number[], q: number) =>
  sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]

function main() {
  const rows = loadScans()
  if (rows.length === 0) {
    console.log('\n  No scans logged. Run `npm run watch` for a while first.\n')
    return
  }

  const clipArg = process.argv.indexOf('--clip')
  const clips = clipArg === -1 ? CLIPS : [Number(process.argv[clipArg + 1])]

  const times = rows.map((r) => r.at).sort()
  const groups = group(rows)

  console.log(`\n  ${rows.length.toLocaleString()} observations · ${times[0].slice(0, 16)}Z → ${times[times.length - 1].slice(0, 16)}Z\n`)

  // ---- 1. How far each corridor's spread travels -------------------------
  console.log(`  SPREAD RANGE`)
  console.log(`  ${pad('pair', 7)}${padL('n', 7)}${padL('min', 9)}${padL('median', 9)}${padL('max', 9)}${padL('range', 8)}${padL('two-sided', 11)}`)
  for (const g of groups) {
    const s = [...g.spreads].sort((a, b) => a - b)
    if (s.length === 0) {
      console.log(`  ${pad(g.id, 7)}${padL(String(g.rows.length), 7)}${padL('—', 9)}${padL('—', 9)}${padL('—', 9)}${padL('—', 8)}${padL('0%', 11)}`)
      continue
    }
    const range = s[0] > 0 ? `${(s[s.length - 1] / s[0]).toFixed(0)}×` : '—'
    console.log(
      `  ${pad(g.id, 7)}${padL(String(g.rows.length), 7)}${padL(s[0].toFixed(2), 9)}${padL(quantile(s, 0.5).toFixed(2), 9)}${padL(s[s.length - 1].toFixed(2), 9)}${padL(range, 8)}${padL(pct(s.length, g.rows.length), 11)}`
    )
  }

  // ---- 2. How often each corridor clears its costs -----------------------
  console.log(`\n  SHARE OF TIME NET-POSITIVE, BY CLIP SIZE`)
  console.log(`  capture ${(CAPTURE_SHARE * 100).toFixed(0)}% of spread, less ${PROTOCOL_FEE_BPS}bp protocol fee, less gas`)
  console.log(`  ${pad('pair', 7)}${clips.map((c) => padL(`$${c}`, 10)).join('')}`)
  for (const g of groups) {
    const cells = clips.map((clip) => {
      const ok = g.spreads.filter((s) => netEdgeBps(s, clip) > 0).length
      return padL(pct(ok, g.rows.length), 10)
    })
    console.log(`  ${pad(g.id, 7)}${cells.join('')}`)
  }
  console.log(`\n  gas as a share of the clip: ${clips.map((c) => `$${c} → ${gasBps(c).toFixed(1)}bp`).join('   ')}`)

  // ---- 3. The cost of configuring once -----------------------------------
  //
  // Group the observations by timestamp so each scan is one moment, then ask
  // what a filler hardcoded to cNGN would have been doing at that moment
  // versus what was actually the best available.
  const byMoment = new Map<string, ScanRow[]>()
  for (const r of rows) {
    const list = byMoment.get(r.at) ?? []
    list.push(r)
    byMoment.set(r.at, list)
  }

  console.log(`\n  THE COST OF CONFIGURING ONCE`)
  console.log(`  a filler hardcoded to cNGN, versus the best corridor available at that moment\n`)

  for (const clip of clips) {
    let moments = 0
    let cngnUnderwater = 0
    let somethingElseBetter = 0
    let nothingWorked = 0
    let forgoneBps = 0

    for (const [, scan] of byMoment) {
      const edges = scan.map((r) => ({
        id: r.corridor,
        edge: r.spreadBps === null ? null : netEdgeBps(r.spreadBps, clip),
      }))
      const cngn = edges.find((e) => e.id === 'cNGN' || e.id === 'cngn')
      const best = edges.reduce<{ id: string; edge: number } | null>((acc, e) => {
        if (e.edge === null) return acc
        return acc === null || e.edge > acc.edge ? { id: e.id, edge: e.edge } : acc
      }, null)
      if (!cngn) continue
      moments++

      const cngnEdge = cngn.edge
      if (cngnEdge === null || cngnEdge <= 0) cngnUnderwater++
      if (best === null || best.edge <= 0) {
        nothingWorked++
        continue
      }
      if (best.id.toLowerCase() !== 'cngn') {
        somethingElseBetter++
        forgoneBps += best.edge - (cngnEdge ?? 0)
      }
    }

    void 0
    console.log(`  $${clip} clip · ${moments.toLocaleString()} moments`)
    console.log(`    cNGN below cost, or unquotable      ${padL(pct(cngnUnderwater, moments), 8)}`)
    console.log(`    another corridor paid more          ${padL(pct(somethingElseBetter, moments), 8)}`)
    console.log(`    nothing cleared costs anywhere      ${padL(pct(nothingWorked, moments), 8)}`)
    console.log(`    average edge forgone by staying     ${padL((forgoneBps / Math.max(1, somethingElseBetter)).toFixed(2) + 'bp', 8)}\n`)
  }

  // ---- 4. The capital floor ----------------------------------------------
  //
  // The question nobody asks until they have already funded a wallet: how
  // much does a filler need before quoting this venue is possible at all?
  //
  // Two constraints have to overlap. To win a request you must quote inside
  // the existing market, so no wider than half the venue spread from mid. To
  // make money you must quote wider than your costs — the protocol fee plus
  // gas. Gas is fixed in dollars, so as a share of the clip it falls as the
  // clip grows, and below some size the two constraints have no overlap at
  // all: every price that wins is a loss, and every price that profits is
  // outside the market.
  //
  //   gasBps(C) + fee  <  spread / 2
  //
  // Solving for C gives the smallest clip that can trade a given spread.
  const GAS_USD = 0.005
  const minClipFor = (spreadBps: number): number | null => {
    const room = spreadBps / 2 - PROTOCOL_FEE_BPS
    if (room <= 0) return null // no spread can cover the fee alone
    return (GAS_USD / (room / 10_000))
  }

  console.log(`  THE CAPITAL FLOOR`)
  console.log(`  smallest clip that can quote inside the market and still clear costs\n`)
  console.log(`  ${pad('pair', 7)}${padL('median spread', 15)}${padL('min clip', 11)}${padL('at p75 spread', 15)}${padL('min clip', 11)}`)
  for (const g of groups) {
    const s = [...g.spreads].sort((a, b) => a - b)
    if (s.length === 0) continue
    const med = quantile(s, 0.5)
    const p75 = quantile(s, 0.75)
    const fmt = (v: number | null) => (v === null ? 'impossible' : v < 1000 ? `$${v.toFixed(0)}` : `$${(v / 1000).toFixed(1)}k`)
    console.log(
      `  ${pad(g.id, 7)}${padL(med.toFixed(2) + 'bp', 15)}${padL(fmt(minClipFor(med)), 11)}${padL(p75.toFixed(2) + 'bp', 15)}${padL(fmt(minClipFor(p75)), 11)}`
    )
  }
  console.log(`\n  assumes ${PROTOCOL_FEE_BPS}bp protocol fee and $${GAS_USD} of gas per fill.`)
  console.log(`  a book quoting below its corridor's floor loses on every fill it wins,`)
  console.log(`  and wins none of the fills it would profit from.\n`)
}

main()
