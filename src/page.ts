/**
 * The board.
 *
 * The demo link is the first thing a judge opens, and it used to return raw
 * JSON — a wall of brackets that takes twenty seconds to resolve into "this
 * agent is refusing four corridors and quoting one". The data was already
 * right; it did not look like a decision being made.
 *
 * Monochrome on purpose. There is exactly one thing worth highlighting on
 * this page — which pits are in play — so colour is spent entirely on that
 * and nowhere else. Everything that does not help a reader answer "what is it
 * doing, and why" has been left out.
 */
import type { Decision } from './handler.js'
import type { BasisStats } from './basis.js'
import { PURCHASES, AGENT_WALLET } from './purchases.js'

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const bps = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`

/** Full names: "wars" reads like a typo, and cNGN means nothing to most readers. */
const LABELS: Record<string, string> = {
  cngn: 'Nigerian naira',
  idrx: 'Indonesian rupiah',
  wbrl: 'Brazilian real',
  wars: 'Argentine peso',
  usdc: 'USD Coin',
}

function row(id: string, d: Decision, i: number): string {
  const r = d.reading
  return `
    <li class="${d.quoting ? 'live' : 'down'}" style="--i:${i}">
      <span class="pit" aria-hidden="true"></span>
      <span class="name">${esc(id.toUpperCase())}<em>${esc(LABELS[id] ?? '')}</em></span>
      <span class="net">${bps(r?.netEdgeBps)}<small>bp net</small></span>
      <span class="why">${esc(d.why)}</span>
    </li>`
}

export function page(decisions: Map<string, Decision>, basis: BasisStats, at: string): string {
  const entries = [...decisions.entries()]
  const quoting = entries.filter(([, d]) => d.quoting).length
  const ngn = decisions.get('cngn')
  const basisBps = ngn?.reading?.crossCheck?.basisBps

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ayo</title>
<meta name="description" content="A price feed that decides which Textile FX corridor on Celo is worth quoting, and turns the rest off.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%230C1B14'/%3E%3Ccircle cx='50' cy='50' r='22' fill='none' stroke='%232C4A3B' stroke-width='6'/%3E%3Ccircle cx='50' cy='50' r='8' fill='%23CFFF5E'/%3E%3C/svg%3E">
<style>
  :root {
    /* The logo's palette. Lime is spent on one thing only - which pits are in
       play - because that is the single fact this page exists to convey. */
    --bg:#0C1B14; --ink:#EDF5EF; --dim:#7E9A88; --faint:#24392E; --line:#1B2E24;
    --live:#CFFF5E;
    --serif:"Instrument Serif", ui-serif, Georgia, serif;
    --mono:"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing:border-box; }
  html { -webkit-font-smoothing:antialiased; }
  body {
    margin:0; padding:clamp(2rem,6vw,5rem) 1.25rem 5rem;
    background:var(--bg); color:var(--ink);
    font-family:var(--mono); font-size:14px; line-height:1.65;
    animation:fade .7s ease both;
  }
  @keyframes fade { from{opacity:0} to{opacity:1} }
  main { max-width:780px; margin:0 auto; }

  h1 {
    font-family:var(--serif); font-weight:400; font-size:clamp(3rem,10vw,4.5rem);
    line-height:1; margin:0; letter-spacing:-.01em;
  }
  .sub { font-family:var(--serif); font-style:italic; font-size:1.35rem; color:var(--dim); margin:.2rem 0 0; }
  .lede { color:var(--dim); margin:1.75rem 0 0; max-width:54ch; }

  .meta {
    display:flex; gap:2.5rem; flex-wrap:wrap;
    margin:3rem 0 2rem; padding-top:1.5rem; border-top:1px solid var(--line);
  }
  .meta div { display:flex; flex-direction:column; gap:.15rem; }
  .meta b { font-weight:500; font-size:1.05rem; font-variant-numeric:tabular-nums; }
  .meta span { color:var(--dim); font-size:.7rem; letter-spacing:.14em; text-transform:uppercase; }

  ul { list-style:none; margin:0; padding:0; }
  li {
    display:grid; grid-template-columns:auto 1fr auto; gap:.85rem 1rem; align-items:baseline;
    padding:1.15rem 0; border-bottom:1px solid var(--line);
    animation:rise .5s ease both; animation-delay:calc(var(--i) * 60ms);
  }
  @keyframes rise { from{opacity:0; transform:translateY(6px)} to{opacity:1; transform:none} }

  .pit {
    width:11px; height:11px; border-radius:50%;
    border:1.5px solid var(--faint); align-self:center;
  }
  .live .pit {
    border-color:var(--live); background:var(--live);
    animation:breathe 2.6s ease-in-out infinite;
  }
  @keyframes breathe { 0%,100%{opacity:1} 50%{opacity:.45} }

  .name { font-weight:500; letter-spacing:.04em; }
  .name em { display:block; font-style:normal; font-weight:400; color:var(--dim); font-size:.8rem; letter-spacing:0; }
  .net { font-variant-numeric:tabular-nums; text-align:right; color:var(--dim); }
  .net small { display:block; font-size:.62rem; letter-spacing:.12em; text-transform:uppercase; }
  .live .net { color:var(--live); }
  .why { grid-column:2 / -1; color:var(--dim); font-size:.82rem; }
  .down { color:var(--dim); }
  .down .name { color:var(--dim); }

  .bought-h {
    font-family:var(--serif); font-weight:400; font-size:1.6rem;
    margin:3.5rem 0 .6rem; padding-top:1.75rem; border-top:1px solid var(--line);
  }
  .bought-lede { color:var(--dim); font-size:.85rem; margin:0 0 1.5rem; max-width:58ch; }
  .bought-lede em { color:var(--ink); font-style:italic; }
  ul.bought { list-style:none; padding:0; margin:0; }
  ul.bought li { padding:1.15rem 0; border-bottom:1px solid var(--line); }
  .bought-top { display:flex; justify-content:space-between; gap:1rem; align-items:baseline; }
  .bought-top b { font-size:.95rem; }
  .bought-top .amt { font-family:var(--mono); font-size:.85rem; color:var(--live); white-space:nowrap; }
  ul.bought .why { color:var(--dim); font-size:.82rem; margin:.5rem 0 .6rem; max-width:62ch; }
  ul.bought .prov { font-family:var(--mono); font-size:.7rem; color:var(--faint); margin:0; line-height:1.7; }
  ul.bought .prov a { color:var(--dim); }
  ul.bought .prov .ok { color:var(--dim); }
  ul.bought .prov .bad { color:#D98A6A; }
  @media (max-width:520px) {
    .bought-top { flex-direction:column; gap:.2rem; }
    ul.bought .prov { word-break:break-all; }
  }

  footer { margin-top:3rem; color:var(--dim); font-size:.8rem; max-width:56ch; }
  footer p { margin:0 0 .9rem; }
  a { color:var(--ink); text-decoration:none; border-bottom:1px solid var(--faint); }
  a:hover { border-color:var(--ink); }
  @media (max-width:520px) { .meta { gap:1.5rem; } li { grid-template-columns:auto 1fr; } .net { grid-column:2; text-align:left; } }
</style>
</head>
<body>
<main>
  <h1>Ayo</h1>
  <p class="sub">the game of pits and seeds</p>

  <p class="lede">
    A price feed for Textile FX fillers on Celo. It prices five corridors, costs each at the
    size actually traded, and tells Stitch which are worth quoting — by serving a fresh price,
    or an honestly stale one for those that are not.
  </p>

  <section class="meta">
    <div><b>${quoting} of ${entries.length}</b><span>quoting</span></div>
    <div><b>${basisBps === null || basisBps === undefined ? '—' : basisBps.toFixed(0) + 'bp'}</b><span>naira basis</span></div>
    <div><b>${basis.n}${basis.warmedUp ? '' : '/120'}</b><span>${basis.seeded ? 'local samples · seeded' : 'basis samples'}</span></div>
    <div><b>${esc(at.slice(11, 19))}</b><span>as of · utc</span></div>
  </section>

  <ul>${entries.map(([id, d], i) => row(id, d, i)).join('')}</ul>

  <h2 class="bought-h">What this agent pays for</h2>
  <p class="bought-lede">
    Services it does not own, over x402 on Celo mainnet, from
    <a href="https://celoscan.io/address/${AGENT_WALLET}">${AGENT_WALLET.slice(0, 6)}…${AGENT_WALLET.slice(-4)}</a>.
    Every hash below settles on Celoscan. x402 pays as an EIP-3009 authorisation, so the
    transaction's sender is the facilitator that broadcast it — the payer is in the
    <em>Transfer</em> log.
  </p>
  <ul class="bought">
    ${PURCHASES.map(
      (p) => `<li>
      <div class="bought-top">
        <b>${esc(p.service)}</b>
        <span class="amt">${esc(p.amount)}</span>
      </div>
      <p class="why">${esc(p.why)}</p>
      <p class="prov">
        ${esc(p.endpoint)}<br>
        <a href="https://celoscan.io/tx/${esc(p.tx)}">${esc(p.tx.slice(0, 18))}…</a>
        · <span class="${p.outcome === 'delivered' ? 'ok' : 'bad'}">${esc(p.outcome)}</span>
        · ${esc(p.at)}
      </p>
    </li>`
    ).join('')}
  </ul>

  <footer>
    <p>
      Gas is charged as basis points of the clip, not a flat fee — half a cent is 2bp on a $25
      fill and 5bp on a $10 one, more than most of these corridors pay. A corridor quotes only
      when it clears that, the 1bp protocol fee, and the share of spread a filler can capture.
    </p>
    <p>
      The naira is cross-checked against Mento's separate NGNm market on the same chain. They
      are different tokens at a persistent spread, so the gap itself says nothing — only its
      drift from its own mean does, and that mean is not trusted before 120 samples.
    </p>
    <p>
      <a href="/debug">JSON</a> · <a href="https://github.com/olanrewajuakeem/ayo">source</a>
    </p>
  </footer>
</main>
<script>setTimeout(() => location.reload(), 20000)</script>
</body>
</html>`
}
