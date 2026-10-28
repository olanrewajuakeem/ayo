/**
 * The local feed server — what Stitch actually polls while the bot is running.
 *
 * Deliberately thin: all the routing and reasoning lives in handler.ts so the
 * deployed copy and this one cannot drift apart. Stitch reads from here
 * because it is on the same machine, which keeps the hot path off the network
 * entirely.
 */
import { createServer } from 'node:http'
import { handle } from './handler.js'

const PORT = Number(process.env.PORT ?? 8787)

const server = createServer((req, res) => void handle(req, res))

server.listen(PORT, () => {
  console.log(`\n  Ayo feed on http://localhost:${PORT}`)
  console.log(`  Stitch feed_url  →  http://localhost:${PORT}/feed/cngn`)
  console.log(`  Reasoning        →  http://localhost:${PORT}/debug\n`)
})
