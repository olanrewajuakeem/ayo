/**
 * Buy an opinion on the naira from outside the chain.
 *
 * This repo has spent five days asserting that the cNGN–NGNm basis is "a fact
 * about the two instruments" — a plumbing artefact with no information in its
 * level, only in its deviation. That was the honest reading of what could be
 * measured from Celo alone, and it may well be wrong.
 *
 * Here is the alternative hypothesis. Nigeria has two dollar prices: the official
 * rate, and the street rate that Nigerians actually transact at, which has run
 * several percent above it for years. If Textile's cNGN tracks the street and
 * Mento's NGNm tracks the official, then the basis is not plumbing at all. It is
 * the parallel-market premium, and this agent has been measuring a piece of
 * Nigerian macroeconomics every thirty seconds without knowing it.
 *
 * Nothing on-chain can settle that, because both candidate anchors are off-chain.
 * So the agent buys them: `naira-rates/usd-ngn` sells the official rate and the
 * street rate from Quidax and Luno P2P books, for 0.01 USA₮ a call. A cent to
 * find out whether the central number in this repo has been described correctly.
 *
 * Sold directly by its operator rather than through the buy gateway, so payment
 * goes to the seller's own wallet, and the listing is marked experimental.
 *
 *   npx tsx --env-file=.env src/naira.ts --quote   ask the price, pay nothing
 *   npx tsx --env-file=.env src/naira.ts           buy one reading and compare
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { createPublicClient, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'
import { ExactEvmScheme, toClientEvmSigner } from '@x402/evm'
import { ExactEvmSchemeV1 } from '@x402/evm/v1'
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch'
import { fetchPair, mid } from './sources/textile.js'
import { fetchMentoNgn } from './sources/mento.js'

const ENDPOINT = process.env.NAIRA_RATES_URL ?? 'https://naira-rate-api.onrender.com/v1/rates'
const RPC = process.env.CELO_RPC_URL ?? 'https://forno.celo.org'

/** USA₮ — "Tether America USD". The only token this seller accepts. */
const USAT_ASSET = '0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771'

const CELO_CAIP = 'eip155:42220'
/** See src/rent.ts: the v1 challenge names the chain `celo`, which the type rejects. */
const CELO_V1 = 'celo' as `${string}:${string}`

/** 0.01 USA₮ listed, capped at three times that. */
const MAX_ATOMIC = 30_000n

const LOG = '.cache/naira-rates.jsonl'

interface Rates {
  pair?: string
  official?: { source?: string; mid?: number }
  street?: { source?: string; bid?: number; ask?: number; mid?: number }[]
  streetMid?: number
  spreadPct?: number
  summary?: string
}

async function quote() {
  const res = await fetch(ENDPOINT)
  const header = res.headers.get('payment-required')
  console.log(`\n  GET ${ENDPOINT} -> ${res.status}`)
  if (!header) {
    console.log(`  no payment-required header\n`)
    return
  }
  const c = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
    x402Version?: number
    accepts?: { amount?: string; asset?: string; network?: string; extra?: { name?: string } }[]
  }
  console.log(`  challenge is x402 v${c.x402Version ?? '?'}\n`)
  for (const a of c.accepts ?? []) {
    const usd = Number(a.amount ?? 0) / 1e6
    console.log(`  ${usd.toFixed(6).padStart(10)}  ${a.network}  ${a.extra?.name ?? a.asset}`)
  }
  console.log(`\n  ceiling ${(Number(MAX_ATOMIC) / 1e6).toFixed(6)}. Nothing has been paid.\n`)
}

async function main() {
  if (process.argv.includes('--quote')) return quote()

  const key = process.env.AGENT_PRIVATE_KEY as Hex | undefined
  if (!key) throw new Error('AGENT_PRIVATE_KEY is not set. It lives in .env, which is gitignored.')

  const account = privateKeyToAccount(key)
  const signer = toClientEvmSigner(account, createPublicClient({ chain: celo, transport: http(RPC) }))

  console.log(`\n  paying from ${account.address}`)
  console.log(`  reading ${ENDPOINT}`)
  console.log(`  This settles on Celo mainnet and cannot be reversed.`)
  console.log(`  The seller sleeps when idle, so a first call can take 20s or more.\n`)

  const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [
      { network: CELO_V1, client: new ExactEvmSchemeV1(signer), x402Version: 1 },
      { network: CELO_CAIP, client: new ExactEvmScheme(signer), x402Version: 2 },
    ],
    spendControls: {
      maxAmountPerPayment: '$0.05',
      allowedAssets: [
        { network: CELO_V1, asset: USAT_ASSET, maxAmountPerPayment: MAX_ATOMIC.toString() },
        { network: CELO_CAIP, asset: USAT_ASSET, maxAmountPerPayment: MAX_ATOMIC.toString() },
      ],
    },
    paymentRequirementsSelector: (_v, reqs) => {
      const usat = reqs.find((r) => r.asset?.toLowerCase() === USAT_ASSET.toLowerCase())
      if (!usat) throw new Error(`seller did not offer USA₮. Offered: ${reqs.map((r) => r.asset).join(', ')}`)
      return usat
    },
  })

  // Read our own two sources at the same moment, so the comparison is between
  // simultaneous observations rather than between a fresh number and a memory.
  const [res, ticker, mento] = await Promise.all([
    paidFetch(ENDPOINT),
    fetchPair('USDT_NGN'),
    fetchMentoNgn(),
  ])

  const body = await res.text()
  if (!res.ok) {
    // A response carrying a payment receipt was paid for whatever its status.
    const receipt = res.headers.get('x-payment-response')
    console.error(`  seller ${res.status}: ${body.slice(0, 300)}`)
    if (receipt) console.error(`  this call was paid for. Do not retry blindly.\n`)
    process.exit(1)
  }

  const r = JSON.parse(body) as Rates
  const textile = mid(ticker)
  const ngnm = mento?.rate ?? null

  console.log(`  ${r.summary ?? '(no summary)'}\n`)
  console.log(`  off-chain, bought`)
  console.log(`    official      ${r.official?.mid?.toFixed(4) ?? '—'}  (${r.official?.source ?? '?'})`)
  for (const s of r.street ?? []) {
    console.log(`    street        ${s.mid?.toFixed(4) ?? '—'}  (${s.source ?? '?'})`)
  }
  console.log(`    street mid    ${r.streetMid?.toFixed(4) ?? '—'}`)
  console.log(`    premium       ${r.spreadPct?.toFixed(2) ?? '—'}%\n`)

  console.log(`  on-chain, measured`)
  console.log(`    Textile cNGN  ${textile?.toFixed(4) ?? '—'}`)
  console.log(`    Mento NGNm    ${ngnm?.toFixed(4) ?? '—'}`)

  const bps = (a: number, b: number) => ((a - b) / b) * 10_000

  if (textile !== null && ngnm !== null) {
    console.log(`    basis         ${bps(textile, ngnm).toFixed(2)}bp\n`)
  }

  // The actual test. If cNGN sits on the street rate and NGNm sits near official,
  // then the basis this repo has been treating as plumbing is the premium.
  if (textile !== null && r.streetMid) {
    console.log(`  cNGN vs street rate    ${bps(textile, r.streetMid).toFixed(2)}bp`)
  }
  if (textile !== null && r.official?.mid) {
    console.log(`  cNGN vs official rate  ${bps(textile, r.official.mid).toFixed(2)}bp`)
  }
  if (ngnm !== null && r.streetMid) {
    console.log(`  NGNm vs street rate    ${bps(ngnm, r.streetMid).toFixed(2)}bp`)
  }
  if (ngnm !== null && r.official?.mid) {
    console.log(`  NGNm vs official rate  ${bps(ngnm, r.official.mid).toFixed(2)}bp`)
  }
  console.log(`\n  Whichever gap is near zero is the anchor that token tracks.\n`)

  try {
    mkdirSync('.cache', { recursive: true })
    appendFileSync(
      LOG,
      JSON.stringify({ at: new Date().toISOString(), bought: r, textile, ngnm }) + '\n'
    )
    console.log(`  recorded in ${LOG}\n`)
  } catch {
    // Losing the record costs evidence, not correctness.
  }
}

main().catch((e) => {
  console.error(`\n  ${e instanceof Error ? e.message.split('\n')[0] : e}\n`)
  process.exit(1)
})
