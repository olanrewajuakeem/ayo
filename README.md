<p align="center">
  <img src="assets/logo.svg" width="96" alt="Ayo">
</p>

# Ayo

**A price feed that decides which Textile FX corridor is worth quoting, and turns the rest off.**

Live: [ayo-navy.vercel.app](https://ayo-navy.vercel.app) · Celo mainnet · agent wallet [`0xc3A2…dA0D`](https://celoscan.io/address/0xc3A2AE793B4aCC88620E538201913A7F042edA0D)

---

Textile's filler guide is direct about what decides a filler's results:

> A price feed for the corridor, a simple HTTP endpoint returning the current price. **Compare more than one source. Your quotes are only as good as your feed.**

[Stitch](https://github.com/textile-protocol/textile-stitch), the reference bot every operator starts from, turns that into static configuration: one feed URL, one spread, set once at install. Ayo is the feed instead of the configuration.

## What five days of measurement showed

Every corridor, every thirty seconds, from 27 October to 1 November — **22,880 observations**. `npx tsx src/analyse.ts` reproduces all of this from `.cache/scans.jsonl`.

| corridor | min | median | max | range | two-sided |
|---|---|---|---|---|---|
| cNGN | 0.00bp | 1.73bp | 33.20bp | — | 83.5% |
| IDRX | 0.46bp | 9.15bp | 12.24bp | 27× | 83.5% |
| wBRL | 0.00bp | 4.11bp | 26.26bp | — | 83.0% |
| wARS | 0.12bp | 4.01bp | 15.65bp | **129×** | 80.1% |
| USDC | 2.00bp | 3.00bp | 7.00bp | 4× | **4.3%** |

A corridor whose spread travels 129× in five days does not have "a spread". It has a spread *right now*, and no number you type at install time is right for very long.

### The finding

At a $25 clip, after the 1bp protocol fee and gas:

> **cNGN — the corridor Stitch preloads, and the one most operators pick — was below cost or unquotable 96.6% of the time. Another corridor paid more 79.7% of the time.**

IDRX was net-positive **83.1%** of the time over the same window.

### Gas is a basis-point cost, not a flat one

The line small books miss. Half a cent of gas is nothing in absolute terms and decisive in relative ones:

| clip | gas as bps of notional |
|---|---|
| $10 | 5.0bp |
| $25 | 2.0bp |
| $50 | 1.0bp |
| $100 | 0.5bp |

At a **$10 clip, nothing on the venue cleared its costs 85.5% of the time.** At $25 that falls to 16.9%. So roughly $25 is the floor under what capital can meaningfully play here — a conclusion that only appears if you price gas per clip rather than per fill.

### The capital floor

The question nobody asks until after they have funded a wallet: **how much does a filler need before quoting this venue is possible at all?**

Two constraints have to overlap. To win a request you must quote *inside* the existing market — no wider than half the venue spread from mid. To make money you must quote *wider* than your costs. Gas is fixed in dollars, so as a share of the clip it shrinks as the clip grows, and below some size the two constraints stop overlapping: every price that wins is a loss, and every price that profits is outside the market.

```
gas_bps(clip) + protocol_fee  <  spread / 2
```

Solved against five days of measured spreads:

| corridor | median spread | smallest viable clip |
|---|---|---|
| cNGN | 1.73bp | **impossible** |
| IDRX | 9.15bp | **$14** |
| wBRL | 4.11bp | $47 |
| wARS | 4.01bp | $50 |
| USDC | 3.00bp | $100 |

**cNGN cannot be profitably quoted at any size.** Half its median spread is 0.87bp — less than the 1bp protocol fee alone. No amount of capital fixes that; the corridor every operator is handed by default is, at typical spreads, unquotable by anyone.

This agent ran on a **$12.74** book against IDRX's $14 floor. It was $1.26 short of the cheapest corridor on the venue, and the correct behaviour at that size is the one it implements: stand down, and wait for the 11% of moments when a spread gaps wide enough to pay for a small clip. Patience is not a consolation strategy for a small book — it is the only correct one.

## How it works

Stitch polls an HTTP endpoint for each pool and expects two fields:

```
GET /feed/cngn  →  { "price": 0.00072, "timestamp": 1793209939 }
```

Ayo serves that endpoint. On every poll it:

1. Reads all five corridors from Textile's public tickers feed
2. Computes each one's net edge — venue spread, less the share a filler can realistically capture, less the protocol fee, less gas at the configured clip
3. Cross-checks the naira against an independent source (below)
4. Returns a **fresh timestamp** for corridors worth quoting, and an **honestly stale one** for corridors that are not

That last step is the whole mechanism. Stitch already skips a pool whose feed has gone stale — so staleness becomes a per-corridor on/off switch that needs no restart and no supervision. Configure every corridor once; Ayo decides which are live, minute by minute.

`price` is **stable per soft** (USD₮ per cNGN, ≈0.00072), not the 1383 figure everything upstream reports. Their docs warn that publishing it inverted "makes the bot post wildly mispriced orders", so the inversion happens in exactly one place.

## The naira cross-check

Mento runs a separate naira market on the same chain, in NGNm. It is a **different token** from cNGN, and the two sit at a persistent spread — **418bp** on the first live reading, stable to within a basis point over hours.

Across days it is not stable at all. Here is the calibration and the live reading together, from a run on 4 November:

```
basis 356.2bp   deviation 45.62bp
mean 401.8bp    stdev 13.97bp    p95 deviation 20.45bp    n=1440
```

The mean has walked from 418 to 402, and the current reading sits 45.6bp away from it — past the 40.9bp the measured p95 allows. **So the naira is gated off at that moment, and cNGN is not quoted.** Not because a threshold was typed in, but because this basis has been living within 20bp of its mean for 1,440 observations and is now 45 away.

That is the whole mechanism in one screen. The raw gap carries no information, and neither does a gap measured last week. Only the deviation from a *currently calibrated* mean does — which is why Ayo records every observation, **refuses to trust a mean before 120 samples**, and stands down when the basis leaves the range it has recently kept to. It is the one corridor where a genuinely independent second opinion exists.

## Running it

```sh
npm install
npm run serve     # the feed Stitch polls, on :8787
npm run watch     # scan every 30s, logging to .cache/
npm run feed      # one scan, printed
npx tsx src/analyse.ts   # the measurements above
```

Point Stitch's price feed at `http://localhost:8787/feed/<corridor>` (or the deployed URL) and it prices off Ayo.

`npm run tag` sends one attributed transaction from the agent wallet and verifies the ERC-8021 code landed — needed because Stitch signs its own fills and knows nothing about this event's tag.

## Buying the one thing it cannot code around

Ayo has a limitation no refactor fixes. Vercel hands every request a fresh filesystem, so `.cache/basis.jsonl` never survives, and `basis.ts` refuses to report a mean before 120 samples — deliberately, because an untrusted mean is worse than none. The hosted feed therefore **can never finish warming up**. It stands down on the naira forever, correctly and uselessly. Locally it does warm up, and then the laptop's connection drops and takes the run with it.

What it needs is an hour of a machine that stays up and keeps a file. That is a purchase, not a patch — so it makes one:

```sh
npm run rent -- --quote   # ask the price, pay nothing
npm run rent              # buy the hour, run the calibration
```

The arithmetic is a coincidence worth noticing. `basis.ts` puts the warmup at "about an hour" of 30-second samples. The gateway's lease is 3600 seconds. **One lease is one warmup**, so the unit the service sells is the unit this agent needs to buy — at **$0.016753**, about a sixth of a basis point on a $100 clip.

| | |
|---|---|
| paid | `0xb3cebffdac96c89e3440eb7b7e1960a949a0406952b777ff08459ee3bd09e7ed` |
| amount | 0.016753 USD₮ |
| from | `0xc3A2…dA0D`, the tagged agent wallet |
| for | `e2-micro`, `us-west1-a`, one hour |

**Read that transaction through its `Transfer` log, not its `from` field.** x402 settles as an EIP-3009 authorisation: the agent wallet *signs* the payment, and a facilitator broadcasts it and pays the gas. So the transaction's sender is `0x0d74…fb48`, and the evidence that this agent paid is the ERC-20 transfer of 0.016753 USD₮ out of `0xc3A2…dA0D`. Judging the sender field would attribute every x402 payment on Celo to the facilitators.

### The rented hour returned nothing

It is worth writing down plainly, because the failure was more instructive than the purchase.

The machine was provisioned, ran for the full lease, and returned no output at all. `scriptStatus` never left `null`, the VM was deleted at expiry, and the gateway retains a result only for a script it saw finish. The lease is now gone — the poll URL answers `no such lease`. The payment is real and on-chain; the data it was meant to buy does not exist.

The cause was a design error, not a gateway fault. The calibration script was written to print only at completion, and sized at 54 minutes inside a 3600-second lease. That puts the entire value of the purchase in its final second, so any delay — boot time, one slow HTTP call, the guest agent reporting late — loses all of it. **Against a hard, paid deadline, a job should emit its result incrementally or finish far inside the window.** This did neither.

Two things follow for anyone buying compute this way:

- Treat lease expiry as a deadline that destroys output, not one that merely stops work.
- Prefer many short purchases that each return something over one long purchase that returns everything or nothing.

The seed below is therefore **local data, not bought data** — 1,440 genuine observations from the machine that did the quoting. `src/basis-seed.ts` says so in the file itself. The honest version of this section is that the purchase proved an agent can pay for its own infrastructure, and proved nothing yet about getting value back.

### The seed

`basis.ts` falls back to `src/basis-seed.ts` whenever the local log is short, so the hosted copy starts with a calibration it could never compute itself:

```
n 1440   mean 401.84bp   stdev 13.97bp   p95 deviation 20.45bp
```

It is a **prior, not a pretence**. Live samples outrank it the moment there are 120 of them, `n` keeps reporting what this machine has actually seen rather than the seed's count, and `/debug` reports `seeded` with the date and provenance. A reader is never told this copy has watched for an hour when it has not.

Two findings came out of building it, both filed as [celo-org/buy-skill#77](https://github.com/celo-org/buy-skill/issues/77):

- The documented gateway (`/gcloud/vm`, and the free `/gcloud/catalog`) returns 404; the live routes are under `/google/`.
- A Celo resource **cannot** be paid with the standalone `x402-fetch`, whose network enum has no `celo` entry and whose line ends at 1.2.0. The `@x402/*` 2.x packages work — but this gateway answers v1, so the scheme must be registered as `ExactEvmSchemeV1` under the literal network name `celo`, which the library's own `Network` type forbids. `src/rent.ts` carries that cast and the reason.

## Honest limits

- **Capture share is a model, not a measurement.** Net edge assumes a filler takes half the venue spread. Without fill-level data from the venue there is no way to measure the real figure, and every "net" number here inherits that assumption.
- **The deployed copy has no disk**, so basis calibration accumulates only on the machine actually quoting. `/debug` says so rather than implying a longer record than exists. This is what the rented hour below exists to work around, and renting is a workaround, not a fix.
- **Inventory skew nudges; it does not unwind.** `src/inventory.ts` leans the published price by at most 4bp, which biases flow over many fills but cannot rescue a book that is already fully one-sided — the state this agent actually reached. Getting out of that still costs a market order, and did: about 13¢, roughly 1% of the book.
- **Balances are read, not reconciled.** Skew is computed from on-chain balances on a 30-second cache, so a fill that has been signed but not settled is invisible to it. At this book size that is noise; at scale it would need the filler's own order state.
- **Textile's tickers feed sometimes reports bid above ask.** Treated as a quoting-convention artefact and taken by magnitude; if it ever reflects a genuinely crossed book, that is an opportunity this does not currently take.

## Why it is built this way

Stitch handles RFQ, EIP-712 signing and settlement — proven, audited, and theirs. Ayo supplies the judgment, through the HTTP interface their own docs describe. Not a fork and not a workaround: the extension point they documented, used for the thing they said determines results.

---

*Ayo is a Yoruba board game: two rows of pits, seeds moved between them, and the whole skill is deciding which pit to play from. Cowrie shells were both the currency and the pieces.*
