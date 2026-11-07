/**
 * Acquire the token a seller actually accepts.
 *
 * The naira oracle this agent wants to read prices in USA₮ and nothing else — a
 * wallet holding USDC or USD₮ cannot pay it at all. That is a small, ordinary
 * problem that any agent buying from more than one seller will hit: the token
 * you hold and the token the seller takes are not the same token, and no amount
 * of protocol support fixes it for you.
 *
 * So the agent swaps for what it needs, in the amount it needs, rather than
 * holding a float of every stablecoin on the chain. Uniswap v3 has a USD₮/USA₮
 * pool at the 0.01% tier with real depth; at this size the cost is rounding.
 *
 *   npx tsx --env-file=.env src/swap.ts            quote 0.10, pay nothing
 *   npx tsx --env-file=.env src/swap.ts --send     actually swap
 *   npx tsx --env-file=.env src/swap.ts --send 0.5 a different amount
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseUnits,
  formatUnits,
  erc20Abi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'

const RPC = process.env.CELO_RPC_URL ?? 'https://forno.celo.org'

const ROUTER = '0x5615CDAb10dc425a742d643d949a7F474C01abc4' as Address // Uniswap SwapRouter02
const QUOTER = '0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8' as Address // QuoterV2
const USDT = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e' as Address
const USAT = '0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771' as Address

/** The 0.01% tier. The 0.05% pool for this pair exists and is empty. */
const FEE = 100

/**
 * Tolerance on the quoted output.
 *
 * Both sides are dollar stablecoins in a pool with five figures of depth, so a
 * cent-sized trade should move nothing. 0.5% is loose enough to survive a block
 * or two of someone else's flow and tight enough that a genuinely broken quote
 * reverts instead of executing.
 */
const SLIPPAGE = 0.005

const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160, uint32, uint256)',
])

const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)',
])

async function main() {
  const send = process.argv.includes('--send')
  const amountArg = process.argv[process.argv.indexOf('--send') + 1]
  const human = send && amountArg && !amountArg.startsWith('--') ? amountArg : '0.10'
  const amountIn = parseUnits(human, 6)

  const key = process.env.AGENT_PRIVATE_KEY as Hex | undefined
  if (!key) throw new Error('AGENT_PRIVATE_KEY is not set. It lives in .env, which is gitignored.')
  const account = privateKeyToAccount(key)

  const pub = createPublicClient({ chain: celo, transport: http(RPC) })

  const held = await pub.readContract({
    address: USDT,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  })
  if (held < amountIn) {
    throw new Error(`holding ${formatUnits(held, 6)} USD₮, need ${human}`)
  }

  // Quote first, always. The minimum output is derived from it, so a swap that
  // cannot be quoted is never sent.
  const { result } = await pub.simulateContract({
    address: QUOTER,
    abi: quoterAbi,
    functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: USDT, tokenOut: USAT, amountIn, fee: FEE, sqrtPriceLimitX96: 0n }],
  })
  const quoted = result[0] as bigint
  const minOut = (quoted * BigInt(Math.round((1 - SLIPPAGE) * 10_000))) / 10_000n

  console.log(`\n  ${human} USD₮ -> ${formatUnits(quoted, 6)} USA₮`)
  console.log(`  worst accepted ${formatUnits(minOut, 6)} USA₮ (${(SLIPPAGE * 100).toFixed(1)}% tolerance)`)

  if (!send) {
    console.log(`\n  Quote only. Nothing sent. Re-run with --send to swap.\n`)
    return
  }

  const wallet = createWalletClient({ account, chain: celo, transport: http(RPC) })

  // Approve exactly this swap rather than an unlimited allowance. A standing
  // approval on a router is a permanent claim on the book for no benefit here,
  // since the agent swaps rarely and in tiny size.
  const allowance = await pub.readContract({
    address: USDT,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, ROUTER],
  })

  if (allowance < amountIn) {
    console.log(`\n  approving ${human} USD₮ to the router`)
    const approveHash = await wallet.writeContract({
      address: USDT,
      abi: erc20Abi,
      functionName: 'approve',
      args: [ROUTER, amountIn],
    })
    await pub.waitForTransactionReceipt({ hash: approveHash })
    console.log(`  approved ${approveHash}`)
  }

  console.log(`  swapping`)
  const hash = await wallet.writeContract({
    address: ROUTER,
    abi: routerAbi,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: USDT,
        tokenOut: USAT,
        fee: FEE,
        recipient: account.address,
        amountIn,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0n,
      },
    ],
  })

  const receipt = await pub.waitForTransactionReceipt({ hash })

  // Pin the read to the block that settled the swap. Forno load-balances across
  // nodes, and a read served by one that has not caught up reports the old
  // balance — which looks exactly like a swap that silently delivered nothing.
  const after = await pub.readContract({
    address: USAT,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
    blockNumber: receipt.blockNumber,
  })

  console.log(`\n  ${receipt.status}  ${hash}`)
  console.log(`  now holding ${formatUnits(after, 6)} USA₮\n`)
}

main().catch((e) => {
  console.error(`\n  ${e instanceof Error ? e.message.split('\n')[0] : e}\n`)
  process.exit(1)
})
