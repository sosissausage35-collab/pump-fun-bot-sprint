# Pump.fun Bot Sprint — Fast Breakout Bot

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/sosissausage35-collab/pump-fun-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/sosissausage35-collab/pump-fun-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Paper-trading bot for the make.fun competition
`u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed`, built as
`@sausage-sosis`. It trades paper SOL on a replay of pump.fun bonding-curve
events (protocol `agent-fun/replay/v2`) and is ranked on net PnL.

## Strategy

**Entry — buy a run early, once per mint.** A curve qualifies only when all
of these hold at decision time:

- real SOL reserve in the **1.25–5 SOL** band (deep enough to trade, young
  enough to still run);
- at least **3 trades** printed;
- buyers took at least **50%** of all traded SOL, and at least **60%** of
  the last 10 trades' SOL;
- price is **1.03–1.50x** its launch price (confirmed uptrend, not a
  vertical spike);
- price is still within **3% of its own peak** since launch (still rising,
  not rolling over).

**Sizing.** One buy per mint, sized to 80% of the per-order size cap (1% of
real reserves), clamped to **0.012–0.10 SOL**. No re-entry into a mint
already traded; at most **5 open positions**; every order is pre-checked
against free cash (buy + both tx fees), the size cap and the position cap.

**Exits — sell the whole position when any rule fires:**

- take-profit at **+10%** over the fill price;
- stop-loss at **−3%**;
- hard time stop after **240 slots** held.

No trailing stop: on the dev tape the trailing stop mostly converts winners
into small wins and losers into slow bleeds.

**Why this shape.** On the kit's 24 h dev tape, peaks are brief (a coin's
peak is usually gone within ~60 slots) and the drift after any rise is down,
so the bot banks small quick wins and cuts losers fast. Slower/wider
variants were all tested and lose more: strength-chasing with big targets,
buy-every-crossing with wide trailing stops, and bottom-fishing (whose
apparent edge turned out to be an intra-slot artifact — the bot only ever
sees batch-end prices). Local verification (full dev window, process driver):
net PnL −0.284 SOL over 242 round trips, max drawdown 3.13%, guardrails met.
The final window is a fresh 6 h draw, so this is a least-bad, high-turnover
design, not a promise of profit.

## Robustness

- Every event and fill is handled defensively; a malformed event is logged
  to stderr and skipped, and `onBatch` never throws (it answers with the
  orders built so far).
- Positions are reconciled against the harness account every batch, so a
  harness close (complete/flatten) can never leave a phantom position.
- Deterministic: float64 math on the event stream only — no clock, no
  environment, no randomness, no network. Two runs on the same replay emit
  byte-identical action logs (verified: `grade-local` reports "reproduced
  byte for byte").

## Files

- `main.ts` — the bot (entrypoint, run as `node /bot/main.ts`).
- `strategy.ts` — the strategy (entry/exit rules, sizing, risk limits).
- `vendor/makefun-bot.ts` — the kit SDK wire shim, byte-identical to
  `sdk/ts/makefun-bot.ts`.
- `README.md`, `POST.json`, `LICENSE` (MIT).

## Local verification

From the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-directory> --driver process
```

The grader runs the bot twice on the dev window and requires the two
action logs to match byte for byte.
