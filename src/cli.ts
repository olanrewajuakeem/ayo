/**
 * Scan the corridors and print where a small book should go.
 *
 *   npx tsx src/cli.ts                  one scan at the default $25 clip
 *   npx tsx src/cli.ts --clip 10        size matters: gas is a bps cost
 *   npx tsx src/cli.ts --watch          rescan every 30s, logging the naira basis
 */
import { scan, type CorridorReading } from './scan.js'
import { WARMUP_SAMPLES } from './basis.js'
import { summarise } from './log.js'

const arg = (flag: string): string | null => {
  const i = process.argv.indexOf(flag)
  return i === -1 ? null : (process.argv[i + 1] ?? null)
}

const n = (v: number | null, dp = 2) => (v === null ? '—' : v.toFixed(dp))
const pad = (s: string, w: number) => s.padEnd(w)
const padL = (s: string, w: number) => s.padStart(w)

function line(r: CorridorReading): string {
  const flag = r.tradeable ? '✓' : ' '
  const cross = r.corridor.crossCheck ? '◆' : ' '
  return [
    ` ${flag} ${cross} `,
    pad(r.corridor.id, 6),
    padL(r.mid === null ? '—' : r.mid.toLocaleString('en-US', { maximumFractionDigits: 4 }), 13),
    padL(n(r.spreadBps) + 'bp', 10),
    padL(n(r.netEdgeBps) + 'bp', 11),
    '  ' + r.note,
  ].join('')
}

async function once(clipUsd: number) {
  const s = await scan(clipUsd)
  console.log(`\n  ${s.at}   clip $${s.clipUsd}   gas ${s.gasBps.toFixed(2)}bp of notional`)
  console.log(`      ${pad('pair', 6)}${padL('mid', 13)}${padL('spread', 10)}${padL('net edge', 11)}`)
  for (const r of s.readings) console.log(line(r))

  const ngn = s.readings.find((r) => r.corridor.crossCheck)
  if (ngn?.crossCheck) {
    const c = ngn.crossCheck
    const st = c.stats
    console.log(`\n  naira cross-check (Mento NGNm)`)
    console.log(`    reference ${c.reference === null ? '—' : c.reference.toFixed(4)}   basis ${n(c.basisBps, 1)}bp   deviation ${n(c.deviationBps, 2)}bp`)
    if (st && !st.warmedUp) {
      console.log(`    calibrating: ${st.n}/${WARMUP_SAMPLES} samples before the basis mean is trusted`)
    } else if (st?.meanBps != null) {
      console.log(`    mean ${st.meanBps.toFixed(1)}bp   stdev ${n(st.stdevBps, 2)}bp   p95 deviation ${n(st.p95DeviationBps, 2)}bp   n=${st.n}`)
    }
  }

  console.log(
    s.best
      ? `\n  → deploy into ${s.best.corridor.id} (${s.best.corridor.label}): ${n(s.best.netEdgeBps)}bp net\n`
      : `\n  → no corridor clears costs at a $${s.clipUsd} clip. Do not quote.\n`
  )
}

/**
 * What the corridors have looked like over time, not just now.
 *
 * The number that matters here is the spread range. A corridor that has been
 * seen at 0.65bp and 18bp is not a corridor with "a spread" — it is one whose
 * spread is a function of the hour, and no single configured number is right
 * for it.
 */
function history() {
  const rows = summarise()
  if (rows.length === 0) {
    console.log('\n  No scans logged yet. Run --watch for a while.\n')
    return
  }
  console.log(`\n  ${pad('pair', 7)}${padL('n', 5)}${padL('min', 10)}${padL('median', 10)}${padL('max', 10)}${padL('range', 9)}${padL('quotable', 10)}`)
  for (const r of rows) {
    const range = Number.isFinite(r.maxSpreadBps) && r.minSpreadBps > 0 ? `${(r.maxSpreadBps / r.minSpreadBps).toFixed(0)}×` : '—'
    console.log(
      `  ${pad(r.corridor, 7)}${padL(String(r.n), 5)}${padL(n(r.minSpreadBps) + 'bp', 10)}${padL(n(r.medianSpreadBps) + 'bp', 10)}${padL(n(r.maxSpreadBps) + 'bp', 10)}${padL(range, 9)}${padL((r.quotableShare * 100).toFixed(0) + '%', 10)}`
    )
  }
  console.log()
}

async function main() {
  if (process.argv.includes('--history')) return history()

  const clipUsd = Number(arg('--clip') ?? 25)
  if (!Number.isFinite(clipUsd) || clipUsd <= 0) throw new Error('--clip must be a positive number')

  await once(clipUsd)
  if (process.argv.includes('--watch')) setInterval(() => void once(clipUsd), 30_000)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
