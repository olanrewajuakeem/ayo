/**
 * Vercel entry point.
 *
 * Same handler as the local server — the deployed copy exists so the agent's
 * reasoning is inspectable without running anything, which is what a judge
 * (or another filler) actually needs. Stitch itself polls localhost.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handle } from '../src/handler.js'

export default async function (req: IncomingMessage, res: ServerResponse) {
  await handle(req, res)
}
