/**
 * What this agent has bought, and the proof.
 *
 * Committed rather than read from disk because the hosted copy has none, and
 * because these are historical facts about settled payments — not state. Each
 * entry carries the transaction that settled it, so nothing here has to be
 * taken on trust: the hashes resolve on Celoscan.
 *
 * One thing to know when checking them. x402 settles as an EIP-3009
 * authorisation: this wallet *signs* the payment and a facilitator broadcasts it
 * and pays the gas. So the transaction's `from` is the facilitator, and the
 * payer appears in the ERC-20 Transfer log. Reading the sender field would
 * attribute every x402 payment on Celo to a handful of facilitators.
 */
export interface Purchase {
  /** The service, as its seller names it. */
  service: string
  /** Where the money went, in words. */
  seller: string
  endpoint: string
  amount: string
  /** What the agent needed it for — the reason the money was worth spending. */
  why: string
  /** Settlement transaction. Verifiable on Celoscan. */
  tx: string
  /** Honest outcome, including when the agent got nothing for its money. */
  outcome: 'delivered' | 'paid, nothing returned'
  at: string
}

export const PURCHASES: Purchase[] = [
  {
    service: 'naira-rates/usd-ngn',
    seller: 'third-party seller, paid directly (not via the buy gateway)',
    endpoint: 'https://naira-rate-api.onrender.com/v1/rates',
    amount: '0.01 USA₮',
    why:
      'An independent naira anchor. Both candidate anchors for the cNGN basis — the official rate and the street rate — are off-chain, so no amount of on-chain measurement can tell which one the corridor tracks. Buying them showed cNGN sits 2.32bp from the street rate and 217.93bp from official.',
    tx: '0x48f880506a8b567ff3925f83c3b3b53e1bb5d83a38a7c2b1173ba576307d5596',
    outcome: 'delivered',
    at: '2026-11-07',
  },
  {
    service: 'buy/google-vm · e2-micro, 1h lease',
    seller: 'buy gateway',
    endpoint: 'https://usebuy.ai/google/vm',
    amount: '0.016753 USD₮',
    why:
      'An hour of compute that keeps a file. The basis mean is not trusted before 120 samples and the hosted copy is serverless, so it can never warm up by itself. 120 samples at 30s is an hour; a lease is 3600 seconds.',
    tx: '0xb3cebffdac96c89e3440eb7b7e1960a949a0406952b777ff08459ee3bd09e7ed',
    outcome: 'paid, nothing returned',
    at: '2026-11-04',
  },
  {
    service: 'Uniswap v3 · USD₮ → USA₮',
    seller: 'not a purchase of a service — a swap, listed because it is why the above was payable',
    endpoint: 'pool 0x070D575a713EaF5025462D0865Fb0Dac4B14bC38',
    amount: '0.10 USD₮ → 0.099929 USA₮',
    why:
      'The naira seller accepts USA₮ and nothing else. The token an agent holds and the token a seller takes are not the same token, which is an ordinary problem once it buys from more than one place.',
    tx: '0x88f0420b6d4d8da8d014a2f94655776b6ebb0bfe162cc93b061dae78c5d9cf0a',
    outcome: 'delivered',
    at: '2026-11-07',
  },
]

export const AGENT_WALLET = '0xc3A2AE793B4aCC88620E538201913A7F042edA0D'
