/**
 * Send one attributed transaction from the agent wallet.
 *
 * Why this file exists, and why it is checked in rather than run once by hand:
 *
 * Stitch signs and sends the approvals and fills, and it has never heard of
 * Loops or this event's ERC-8021 tag. The submission checklist scanned four
 * transactions from this wallet and found none carrying it — real work, no
 * credit, and no way to add the tag afterwards because the suffix lives in the
 * transaction's calldata and a mined transaction is permanent.
 *
 * So this sends a deliberate one: a zero-value self-transfer whose entire
 * payload is the attribution suffix. It costs a fraction of a cent, it proves
 * this wallet is the one behind the entry, and it is the transaction the
 * checklist is asking for.
 *
 * It does not retroactively credit the fills. Nothing can. What it does is
 * establish the wallet on-chain under the event's tag, which is the part that
 * is still available to us.
 *
 *   npx tsx src/tag.ts            send it
 *   npx tsx src/tag.ts --verify 0x…   check an existing hash instead
 */
import { createWalletClient, createPublicClient, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'
import { verifyTx } from '@celo/attribution-tags'

/** Issued by Loops at enrollment. Never derive one; only this value is credited. */
const TAG = process.env.CELO_ATTRIBUTION_TAG ?? 'celo_fb726b4b2e54'

/**
 * The exact calldata suffix for that tag, as `loops project get` reports it.
 *
 * Using the published bytes rather than re-deriving them: the encoding carries
 * a length prefix and padding that is easy to get subtly wrong, and a subtly
 * wrong suffix is indistinguishable from no suffix at all until the checklist
 * says it found nothing.
 */
const DATA_SUFFIX =
  (process.env.CELO_DATA_SUFFIX as Hex | undefined) ??
  '0x63656c6f5f666237323662346232653534110080218021802180218021802180218021'

const RPC = process.env.CELO_RPC_URL ?? 'https://forno.celo.org'

const publicClient = createPublicClient({ chain: celo, transport: http(RPC) })

async function verify(hash: Hex) {
  const result = await verifyTx({ client: publicClient, hash })
  const codes = result?.codes ?? []
  console.log(`\n  ${hash}`)
  console.log(`  codes: ${codes.length ? codes.join(', ') : '(none — this transaction carries no tag)'}`)
  console.log(codes.includes(TAG) ? `  ✓ carries ${TAG}\n` : `  ✗ does not carry ${TAG}\n`)
  return codes.includes(TAG)
}

async function main() {
  const verifyAt = process.argv.indexOf('--verify')
  if (verifyAt !== -1) {
    const hash = process.argv[verifyAt + 1] as Hex | undefined
    if (!hash) throw new Error('--verify needs a transaction hash')
    await verify(hash)
    return
  }

  const key = process.env.AGENT_PRIVATE_KEY as Hex | undefined
  if (!key) throw new Error('AGENT_PRIVATE_KEY is not set. Put it in .env — which is gitignored.')

  const account = privateKeyToAccount(key)
  const wallet = createWalletClient({ account, chain: celo, transport: http(RPC) })

  console.log(`\n  from ${account.address}`)
  console.log(`  tag  ${TAG}`)

  // Zero value, to itself. The only thing of substance is the calldata, which
  // is the suffix and nothing else — the cheapest possible way to put this
  // wallet on-chain under this event's tag.
  const hash = await wallet.sendTransaction({
    to: account.address,
    value: 0n,
    data: DATA_SUFFIX,
  })

  console.log(`  sent ${hash}`)
  console.log(`  waiting for it to be mined…`)

  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  console.log(`  mined in block ${receipt.blockNumber}, status ${receipt.status}`)

  // Check the first tagged transaction, not the last: if the wiring is wrong,
  // this is the cheapest moment to find out.
  await verify(hash)
  console.log(`  Paste that hash into the Celo checklist on the Loops submit page.\n`)
}

main().catch((e) => {
  console.error(`\n  ${e instanceof Error ? e.message : e}\n`)
  process.exit(1)
})
