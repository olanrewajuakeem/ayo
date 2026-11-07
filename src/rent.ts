/**
 * Rent an hour of compute to warm up the basis calibration, paid by the agent.
 *
 * Ayo has one limitation it cannot fix with better code, and the README says so
 * plainly: the deployed copy has no disk. Vercel gives every request a fresh
 * filesystem, so `.cache/basis.jsonl` never survives, and `basis.ts` refuses to
 * report a mean before WARMUP_SAMPLES observations — deliberately, because an
 * untrusted mean is worse than none. The consequence is that the hosted feed can
 * never finish warming up. It stands down on the naira forever, correctly and
 * uselessly.
 *
 * Locally it does warm up, and then the laptop's DNS drops and takes the run
 * with it. That has happened three times.
 *
 * What the agent actually needs is a machine that stays up for an hour and keeps
 * a file. That is a purchase, not a refactor — so it buys one, for 1.7 cents, and
 * runs exactly the calibration it cannot run anywhere else.
 *
 * The arithmetic is a coincidence worth noticing. basis.ts:29 puts WARMUP_SAMPLES
 * at "about an hour" of 30-second samples. The gateway's lease is 3600 seconds.
 * One lease is one warmup, almost to the second — so the unit this service sells
 * is the unit this agent needs to buy.
 *
 * It pays over x402 straight from the tagged wallet rather than through the `buy`
 * CLI. Not because the CLI cannot: 0.8.4 added `setup --import`, which adopts an
 * already-declared wallet from `BUY_IMPORT_KEY`. Because paying in-process keeps
 * the parts that matter explicit and reviewable — the spend ceiling, the token
 * selection, the refusal to fall back to a token this wallet does not hold — and
 * copies no key into an OS keychain to get there.
 *
 * What is not optional is where it settles from. A paid call that leaves some
 * other address is not a paid call this agent can claim.
 *
 *   npx tsx --env-file=.env src/rent.ts --quote      ask the price, pay nothing
 *   npx tsx --env-file=.env src/rent.ts              buy the hour and run it
 *   npx tsx --env-file=.env src/rent.ts --poll URL   collect a lease already paid for
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createPublicClient, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'
import { ExactEvmScheme, toClientEvmSigner } from '@x402/evm'
import { ExactEvmSchemeV1 } from '@x402/evm/v1'
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch'

/**
 * The gateway moved. It was documented at `/gcloud/vm`, and that path — along
 * with `/gcloud/catalog`, which is free and side-effect free — now returns 404
 * while the host's root still serves 200. The live routes are under `/google/`.
 * Pinned here rather than discovered, because a price feed should not depend on
 * guessing a vendor's URL scheme at runtime.
 */
const GATEWAY = process.env.BUY_GATEWAY ?? 'https://usebuy.ai/google/vm'
const RPC = process.env.CELO_RPC_URL ?? 'https://forno.celo.org'

/** USD₮ on Celo. The tagged wallet holds this and no USDC, and the gateway takes either. */
const USDT_ASSET = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e'

/**
 * Celo in CAIP-2, which is the whole reason this file is on x402 v2.
 *
 * The v1 client (`x402-fetch`, which tops out at 1.2.0) validates the network
 * against a hardcoded enum of seventeen names, and Celo is not among them. It
 * rejects the gateway's own challenge — `invalid_enum_value, received 'celo'` —
 * before signing anything, so v1 cannot pay a Celo resource at all. v2 moved to
 * CAIP-2 identifiers, where chain 42220 needs no special casing.
 */
const CELO_CAIP = 'eip155:42220'

/**
 * The same chain under v1's naming, which is what this gateway's challenge uses.
 *
 * The client matches the challenge's `network` string literally and does not
 * translate between the two spellings, so registering only the CAIP-2 form gets
 * the payment refused before signing:
 *
 *   No network/scheme registered for x402 version: 1 ...
 *   "networks":["eip155:42220"]   <- registered
 *   "network":"celo"              <- required
 *
 * The cast is load-bearing and not cosmetic. `Network` is typed
 * `${string}:${string}`, which `celo` does not satisfy — so the one value the
 * runtime needs here is the one value the type rejects. Reported upstream in
 * celo-org/buy-skill#77.
 */
const CELO_V1 = 'celo' as `${string}:${string}`

/**
 * Hard ceiling on the payment, in atomic units of a six-decimal token.
 *
 * e2-micro quotes at 16,753 (US$0.016753). This is roughly double that: enough
 * slack for the catalogue to move, not enough for a fat-fingered machine type to
 * spend the book.
 */
const MAX_ATOMIC = 35_000n

/** Where the paid response is kept. The poll URL is a capability; `.cache/` is gitignored. */
const RECEIPTS = '.cache/leases.jsonl'

/**
 * The calibration run, as Python, because a Debian 12 image has python3 and
 * curl and nothing else — no Node, no toolchain, and installing one would spend
 * lease time on a dependency this job does not need.
 *
 * It reproduces `basis.ts` and the two source modules exactly: USDT_NGN from
 * Textile taken as a mid of bid and ask with 0 meaning "no quote on this side",
 * the Mento naira read through Cowrie, and
 *
 *     basisBps = ((textile - mento) / mento) * 10_000
 *
 * then mean, population stdev and the 95th percentile of |v - mean|. Matching
 * the local maths is the whole point: numbers computed a different way would not
 * be loadable as calibration, they would just be a second opinion.
 *
 * 120 samples at 27 seconds is 54 minutes, which reaches WARMUP_SAMPLES with
 * about five minutes of the lease left for boot and for the result to be
 * retained. A script that is still running when the lease expires has sold the
 * agent nothing.
 */
const CALIBRATE = `
import json, time, urllib.request as u

def get(url, t=15):
    return json.load(u.urlopen(url, timeout=t))

def textile():
    for row in get("https://api.textilecredit.com/tickers"):
        if str(row.get("ticker_id", "")).upper() == "USDT_NGN":
            b = float(row.get("bid") or 0)
            a = float(row.get("ask") or 0)
            # Textile sends 0 for an absent side; a one-sided book has no mid.
            return (b + a) / 2 if (b and a) else None
    return None

def mento():
    try:
        q = get("https://cowrie-seven.vercel.app/quote?from=USD&to=NGN&amount=100")
        r = float(q.get("rate") or 0)
        return r if r > 0 else None
    except Exception:
        # 503 is the documented "oracle quiet" answer, not a fault.
        return None

N, PERIOD = 120, 27
S = []
print("ayo basis calibration: %d samples, %ds apart" % (N, PERIOD), flush=True)

for i in range(N):
    started = time.time()
    try:
        t, m = textile(), mento()
        if t and m:
            bp = ((t - m) / m) * 10000.0
            S.append(bp)
            if len(S) % 10 == 0:
                print("  %3d/%d  textile %.4f  mento %.4f  basis %.2fbp"
                      % (len(S), N, t, m, bp), flush=True)
        else:
            print("  %3d  no sample (textile=%s mento=%s)" % (i + 1, t, m), flush=True)
    except Exception as e:
        print("  %3d  error %s" % (i + 1, e), flush=True)
    left = PERIOD - (time.time() - started)
    if i < N - 1 and left > 0:
        time.sleep(left)

n = len(S)
print("")
print("samples %d" % n)
if n:
    mu = sum(S) / n
    sd = (sum((v - mu) ** 2 for v in S) / n) ** 0.5
    dv = sorted(abs(v - mu) for v in S)
    print("meanBps %.4f" % mu)
    print("stdevBps %.4f" % sd)
    print("p95DeviationBps %.4f" % dv[min(n - 1, int(n * 0.95))])
    print("warmedUp %s" % (n >= 120))
    # Emitted so the local cache can be seeded from the rented run rather than
    # trusting a summary of it.
    print("series " + ",".join("%.4f" % v for v in S))
`.trim()

/**
 * Shipped base64-encoded. The script travels as a JSON string inside a signed
 * payment request, and quoting a hundred lines of Python through that twice over
 * is a way to lose an irreversible payment to a syntax error.
 */
const SCRIPT = [
  `echo ${Buffer.from(CALIBRATE, 'utf8').toString('base64')} | base64 -d > /tmp/c.py`,
  'python3 -u /tmp/c.py',
].join(' && ')

/** Decode the 402 challenge, which lives in a header under x402 v2 and in the body under v1. */
function challenge(res: Response, body: string): unknown {
  const header = res.headers.get('payment-required')
  if (header) {
    try {
      return JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
    } catch {
      // Fall through to the body.
    }
  }
  try {
    return JSON.parse(body)
  } catch {
    return body.slice(0, 400)
  }
}

interface Accepts {
  amount?: string
  maxAmountRequired?: string
  asset?: string
  network?: string
  extra?: { name?: string }
}

/** Ask the price without paying it. An unpaid POST is free and is the authoritative quote. */
async function quote() {
  const res = await fetch(GATEWAY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ script: SCRIPT, machineType: 'e2-micro' }),
  })
  const text = await res.text()

  console.log(`\n  POST ${GATEWAY} -> ${res.status}`)
  console.log(`  script ${Buffer.byteLength(SCRIPT)} bytes of the 4096 allowed`)

  // The payload is checkable for free; the payment that carries it is not. Drop
  // the Python where `python3 -m py_compile` can reach it before buying.
  try {
    mkdirSync('.cache', { recursive: true })
    writeFileSync('.cache/calibrate.py', CALIBRATE + '\n')
    console.log(`  payload written to .cache/calibrate.py\n`)
  } catch {
    console.log('')
  }

  if (res.status !== 402) {
    console.log(`  ${text.slice(0, 400)}\n`)
    return
  }

  const c = challenge(res, text) as { x402Version?: number; accepts?: Accepts[] }
  console.log(`  challenge is x402 v${c.x402Version ?? '?'}\n`)

  for (const a of c.accepts ?? []) {
    const atomic = a.amount ?? a.maxAmountRequired ?? '?'
    const usd = Number(atomic) / 1e6
    const name = a.extra?.name ?? a.asset ?? '?'
    const chosen = a.asset?.toLowerCase() === USDT_ASSET.toLowerCase() ? '  <- will pay with this' : ''
    console.log(`  ${usd.toFixed(6).padStart(10)}  ${(a.network ?? '?').padEnd(14)} ${name}${chosen}`)
    console.log(`  ${' '.repeat(10)}  ${a.asset}`)
  }
  console.log(`\n  ceiling ${(Number(MAX_ATOMIC) / 1e6).toFixed(6)}. Nothing has been paid.\n`)
}

async function poll(url: string) {
  for (let i = 0; i < 300; i++) {
    const res = await fetch(url)
    const body = (await res.json()) as {
      vmStatus?: string
      scriptStatus?: string
      result?: string
    }
    const status = body.scriptStatus ?? body.vmStatus ?? '(starting)'
    const mins = Math.round((i * 15) / 60)
    process.stdout.write(`\r  ${status} · ${mins}m elapsed${' '.repeat(20)}`)

    if (body.scriptStatus === 'done' || body.scriptStatus?.startsWith('failed')) {
      console.log(`\n\n${body.result ?? '(no output)'}\n`)
      return
    }
    if (body.vmStatus === 'DELETED') {
      console.log(`\n  lease ended.${body.result ? '\n\n' + body.result : ' No result retained.'}\n`)
      return
    }
    await new Promise((r) => setTimeout(r, 15_000))
  }
  console.log(`\n  still running. The poll URL stays valid — resume with --poll.\n`)
}

async function main() {
  const pollAt = process.argv.indexOf('--poll')
  if (pollAt !== -1) {
    const url = process.argv[pollAt + 1]
    if (!url) throw new Error('--poll needs the URL from a previous run')
    return poll(url)
  }

  if (process.argv.includes('--quote')) return quote()

  const key = process.env.AGENT_PRIVATE_KEY as Hex | undefined
  if (!key) throw new Error('AGENT_PRIVATE_KEY is not set. It lives in .env, which is gitignored.')

  const account = privateKeyToAccount(key)

  // The payment is a signed EIP-3009 authorisation, not a transaction we send,
  // so a local account is already a complete signer. The public client is only
  // attached so the scheme can do its optional on-chain reads (allowance and
  // nonce checks) rather than assume them.
  const signer = toClientEvmSigner(
    account,
    createPublicClient({ chain: celo, transport: http(RPC) })
  )

  console.log(`\n  paying from ${account.address}`)
  console.log(`  renting e2-micro from ${GATEWAY}`)
  console.log(`  ceiling ${(Number(MAX_ATOMIC) / 1e6).toFixed(6)} USD₮\n`)
  console.log(`  This settles on Celo mainnet and cannot be reversed.`)
  console.log(`  The answer takes about a minute; do not interrupt it.\n`)

  const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
    // Both protocol versions, registered under the CAIP-2 id either way — the
    // library translates to v1's `celo` through its own chain-id map, so the
    // legacy name never appears here.
    //
    // v1 is what this gateway actually answers with today. v2 is where the rest
    // of the ecosystem is going, and the naira oracle already speaks it. A
    // client that implements only one is betting on a migration it does not
    // control, and the cost of covering both is four lines.
    schemes: [
      { network: CELO_V1, client: new ExactEvmSchemeV1(signer), x402Version: 1 },
      { network: CELO_CAIP, client: new ExactEvmScheme(signer), x402Version: 2 },
    ],

    // Two independent ceilings, because the library's defaults do not fit this
    // purchase. Spend controls admit only recognised "default" assets unless
    // told otherwise, and USD₮ on Celo is not one — without the explicit entry
    // the only token this wallet holds would be refused. The atomic cap is the
    // binding one; the dollar cap covers anything the gateway offers that *is*
    // recognised, so no path through here can spend more than five cents.
    spendControls: {
      maxAmountPerPayment: '$0.05',
      // Also network-scoped, and matched against the challenge's spelling — so
      // the same token needs an entry under each name, or the allowance misses
      // whichever version actually arrives and refuses the only funded asset.
      allowedAssets: [
        { network: CELO_V1, asset: USDT_ASSET, maxAmountPerPayment: MAX_ATOMIC.toString() },
        { network: CELO_CAIP, asset: USDT_ASSET, maxAmountPerPayment: MAX_ATOMIC.toString() },
      ],
    },

    // The gateway quotes the same price in USDC, USD₮ and USA₮, and the default
    // selector takes the first. This wallet holds 10.2 USD₮ and nothing else, so
    // the choice is made here: paying is not the place to discover an empty
    // balance.
    paymentRequirementsSelector: (_version, reqs) => {
      const usdt = reqs.find((r) => r.asset?.toLowerCase() === USDT_ASSET.toLowerCase())
      if (!usdt) {
        throw new Error(
          `the gateway did not offer USD₮. Offered: ${reqs.map((r) => r.asset).join(', ')}`
        )
      }
      return usdt
    },
  })

  const res = await paidFetch(GATEWAY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ script: SCRIPT, machineType: 'e2-micro' }),
  })

  const text = await res.text()

  if (!res.ok) {
    // 500 provision_failed and 500 settle_uncertain mean the money may be gone.
    // Retrying either can pay twice, so this says what is known and stops.
    const correlation = res.headers.get('x-correlation-id') ?? '(none)'
    console.error(`\n  gateway ${res.status}. correlation ${correlation}`)
    console.error(`  ${text.slice(0, 500)}\n`)
    if (res.status >= 500) {
      console.error(`  Do not re-run this. The payment may have settled.`)
      console.error(`  Check \`npx @celo/buy@0.8.5 receipts --resolve\` and the wallet on Celoscan.\n`)
    }
    process.exit(1)
  }

  const body = JSON.parse(text) as {
    transaction?: string
    instance?: string
    zone?: string
    expiresAt?: string
    poll?: string
  }

  // Written before anything else can fail. The poll URL is the only way back to
  // a result that has already been paid for, and `buy receipts` does not keep it.
  try {
    mkdirSync('.cache', { recursive: true })
    appendFileSync(RECEIPTS, JSON.stringify({ at: new Date().toISOString(), ...body }) + '\n')
    writeFileSync('.cache/last-lease.txt', `${body.poll ?? ''}\n`)
  } catch {
    console.error(`  (could not write ${RECEIPTS} — copy the poll URL below by hand)`)
  }

  console.log(`  paid     ${body.transaction}`)
  console.log(`  instance ${body.instance} in ${body.zone}`)
  console.log(`  expires  ${body.expiresAt}`)
  console.log(`  poll     ${body.poll}`)
  console.log(`  saved to ${RECEIPTS}\n`)
  console.log(`  Calibrating for ~54 minutes. Safe to stop watching; resume with:`)
  console.log(`    npm run rent -- --poll "${body.poll}"\n`)

  if (body.poll) await poll(body.poll)
}

main().catch((e) => {
  console.error(`\n  ${e instanceof Error ? e.message : e}\n`)
  process.exit(1)
})
