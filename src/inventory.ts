/**
 * What the book is actually holding, read from the chain.
 *
 * A filler that gets hit repeatedly on one side ends up holding that side.
 * It happened here: five days of quoting left the wallet 100% in cNGN with
 * no USD₮ to buy with, unable to quote either direction, and unwinding it
 * cost thirteen cents — about 1% of the book — to get back to neutral.
 *
 * A static filler has no defence against that. It quotes the same distance
 * either side of the mid whether it is flat or completely lopsided, so every
 * fill in the same direction makes the next one more dangerous.
 *
 * The defence is old and simple: move your price, not your spread. Long the
 * counter-asset? Publish a slightly lower price. Stitch derives both its bid
 * and its ask from that single number, so both shift down together — it buys
 * less eagerly and sells more eagerly, and the book walks back toward
 * balance on its own.
 *
 * Nothing here is a Stitch feature. It drops out of publishing one number
 * honestly rather than mechanically.
 */
import { createPublicClient, http, erc20Abi, formatUnits, type Address } from 'viem'
import { celo } from 'viem/chains'

const RPC = process.env.CELO_RPC_URL ?? 'https://forno.celo.org'
const WALLET = (process.env.AGENT_WALLET ?? '0xc3A2AE793B4aCC88620E538201913A7F042edA0D') as Address

const client = createPublicClient({ chain: celo, transport: http(RPC) })

/**
 * The USD leg every corridor trades against, and the counter-assets.
 * Decimals differ — cNGN is 6, the wFIAT tokens are 18 — and getting that
 * wrong turns a balanced book into an apparently enormous one.
 */
const USDT: { address: Address; decimals: number } = {
  address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e',
  decimals: 6,
}

const COUNTER: Record<string, { address: Address; decimals: number }> = {
  // IDRX carries **2** decimals, from Stitch's own pool config. Assuming the
  // usual 18 would read a balanced book as lopsided by sixteen orders of
  // magnitude and skew the price to its cap permanently.
  idrx: { address: '0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22', decimals: 2 },
  cngn: { address: '0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A', decimals: 6 },
  wars: { address: '0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d', decimals: 18 },
  wbrl: { address: '0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0', decimals: 18 },
}

export interface Inventory {
  /** USD₮ held, in whole units. */
  usd: number
  /** Counter-asset held, in whole units of that token. */
  counter: number
  /** Counter-asset valued in USD at the current mid. */
  counterUsd: number
  /**
   * Where the book sits, from −1 (everything in the counter-asset) through 0
   * (balanced) to +1 (everything in USD₮).
   */
  balance: number
  at: string
}

let cached: { at: number; byCorridor: Map<string, Inventory> } | null = null
const CACHE_MS = 30_000

/**
 * Read balances for one corridor. Returns null when we hold no token list for
 * it — IDRX's Celo address is not published in Textile's address book, so it
 * is read as "unknown" rather than guessed at.
 */
export async function read(corridorId: string, mid: number | null): Promise<Inventory | null> {
  const counter = COUNTER[corridorId.toLowerCase()]
  if (!counter || mid === null || mid <= 0) return null

  const [usdRaw, counterRaw] = await Promise.all([
    client.readContract({ address: USDT.address, abi: erc20Abi, functionName: 'balanceOf', args: [WALLET] }),
    client.readContract({ address: counter.address, abi: erc20Abi, functionName: 'balanceOf', args: [WALLET] }),
  ])

  const usd = Number(formatUnits(usdRaw, USDT.decimals))
  const held = Number(formatUnits(counterRaw, counter.decimals))
  // `mid` is soft-per-stable (naira per dollar), so dividing converts back.
  const counterUsd = held / mid

  const total = usd + counterUsd
  // A book holding nothing is balanced by definition, not lopsided.
  const balance = total <= 0 ? 0 : (usd - counterUsd) / total

  return { usd, counter: held, counterUsd, balance, at: new Date().toISOString() }
}

export async function readAll(mids: Map<string, number | null>): Promise<Map<string, Inventory>> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.byCorridor
  const out = new Map<string, Inventory>()
  await Promise.all(
    [...mids.entries()].map(async ([id, mid]) => {
      try {
        const inv = await read(id, mid)
        if (inv) out.set(id, inv)
      } catch {
        // A failed balance read means no skew this tick, not no quote. The
        // feed is still correct; it is just not leaning.
      }
    })
  )
  cached = { at: Date.now(), byCorridor: out }
  return out
}

/**
 * How far to shift the published price, in basis points.
 *
 * Signed so that a book long the counter-asset (balance below zero) produces
 * a negative shift: a lower price, which makes Stitch sell the counter-asset
 * more readily and buy it less.
 *
 * Capped, because skew is a nudge and not a liquidation. At full lopsidedness
 * it moves the price by MAX_SKEW_BPS, which is deliberately smaller than the
 * spreads these corridors show — enough to bias the flow over many fills,
 * never enough to quote through fair value and hand someone free money.
 */
export const MAX_SKEW_BPS = 4

/**
 * Below this the book is close enough to balanced that leaning is noise.
 * Without it the price would jitter on every fill.
 */
const DEADBAND = 0.15

export function skewBps(inv: Inventory | undefined): number {
  if (!inv) return 0
  if (Math.abs(inv.balance) < DEADBAND) return 0
  // Rescale so the skew ramps from zero at the deadband to full at the edge,
  // rather than jumping the moment the deadband is crossed.
  const scaled = (Math.abs(inv.balance) - DEADBAND) / (1 - DEADBAND)
  return Math.sign(inv.balance) * scaled * MAX_SKEW_BPS
}
