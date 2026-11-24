// Pump.fun Bot Sprint — "Reserve-Gated Breakout" strategy (fresh build for @sausage-sosis).
//
// Entry (fast breakout): buy a curve early in its run — real SOL reserve
// 1.25-5 SOL, >=3 trades, buyers >=50% of all volume and >=60% of the last
// 10 trades, price 1.03-1.50x launch while within 3% of its peak (still
// rising, not a spike, not rolling over). One buy per mint, sized to ~80% of
// the per-order size cap, clamped to 0.012-0.10 SOL.
// Exits (fast, because the dev tape shows a coin's peak is usually gone
// within ~60 slots and the drift after any rise is down): +10% take-profit,
// -3% stop-loss, or a 240-slot time stop. No trailing stop.
// Max 5 positions, no re-entry, deterministic.
//
import type { Batch, Fill, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

/** The slice of bot state the strategy reads: satisfied by the SDK BotState. */
export interface StrategyState {
  hello: { caps: { max_open_positions: number; max_orders_per_batch: number } };
  positions: Map<Pubkey, { token_amount: bigint }>;
  curves: Map<
    Pubkey,
    {
      virtual_token_reserves: bigint;
      virtual_quote_reserves: bigint;
      real_quote_reserves: bigint;
      complete: boolean;
    }
  >;
  pending: Map<string, { order: { side: string; mint: Pubkey } }>;
  maxBuyLamports(mint: Pubkey): bigint;
  freeCashLamports(): bigint;
  txFeeLamports(): bigint;
  committedPositionCount(): number;
}

export interface Strategy {
  onBatch(state: StrategyState, batch: Batch): OrderInput[];
}

// ---- tunables (defaults = v2: enter the move early, exit fast) ----
export interface Params {
  minRealSol: number;
  maxRealSol: number;
  minTrades: number;
  minBuyShare: number; // cumulative buyers' share of volume
  minRecentBuyShare: number; // buyers' share over the last 10 trades
  minRise: number; // price vs launch price, lower bound
  maxRise: number; // price vs launch price, upper bound
  minOfPeak: number; // price now vs its own peak since launch
  stakeMaxLamports: bigint;
  stakeMinLamports: bigint;
  stakeFractionOfCapBps: number;
  takeProfit: number;
  trailArm: number;
  trailLock: number;
  trailPeakFraction: number;
  stopLoss: number;
  maxHoldSlots: number;
  // bottom-fishing entry (v4): buy a deep pullback after sellers dry up
  useDip: boolean; // when true, require the dip filters below as well
  dipLo: number; // price now vs peak since launch, lower bound
  dipHi: number; // price now vs peak since launch, upper bound
  minPeakRise: number; // peak since launch vs launch price (it ran up first)
  maxSellShare: number; // sellers' share of SOL over the last 20 trades
  firmFactor: number; // price now vs price 10 trades ago (firming, not falling)
}

export const DEFAULT_PARAMS: Params = {
  // v2 (fast breakout): enter early in a run — real reserve 1.25-5 SOL, >=3
  // trades, buyers >=50% of all volume and >=60% of the last 10 trades,
  // price 1.03-1.50x launch while within 3% of its peak — then exit fast:
  // +10% take-profit, -3% stop-loss, 240-slot time stop, no trailing stop.
  // On the dev tape every slower/wider variant loses more: peaks are brief
  // and coins decay, so the bot banks small quick wins and cuts losers fast.
  // Strength-chasing with big targets, buy-every-crossing with wide trails,
  // and bottom-fishing all lose more (bottom-fishing's apparent edge was an
  // intra-slot artifact — the bot only ever sees batch-end prices).
  minRealSol: 1.25,
  maxRealSol: 5.0,
  minTrades: 3,
  minBuyShare: 0.5,
  minRecentBuyShare: 0.6,
  minRise: 1.03,
  maxRise: 1.5,
  minOfPeak: 0.97,
  stakeMaxLamports: 100_000_000n,
  stakeMinLamports: 12_000_000n,
  stakeFractionOfCapBps: 8000,
  takeProfit: 1.1,
  trailArm: 99.0,
  trailLock: 0,
  trailPeakFraction: 0.85,
  stopLoss: 0.97,
  maxHoldSlots: 240,
  useDip: false,
  dipLo: 0.5,
  dipHi: 0.8,
  minPeakRise: 1.3,
  maxSellShare: 0.25,
  firmFactor: 0.98,
};

const SLIPPAGE_BPS = 1000; // 10%: wide enough to survive 2-slot latency, tight enough to refuse a dump

// ---- per-mint flow state, built from the event stream ----
interface Flow {
  firstPrice: number; // launch price (CreateEvent reserves, else first trade)
  peak: number; // highest price seen since launch
  lastPrice: number;
  trades: number;
  buySol: bigint;
  sellSol: bigint;
  firstSlot: number;
  entered: boolean; // a buy of ours filled on this mint (never re-enter)
  recent: { buy: boolean; sol: bigint }[]; // last 10 trades, oldest first
  recentBuySol: bigint;
  recentSellSol: bigint;
  win20: { buy: boolean; sol: bigint }[]; // last 20 trades, oldest first
  winBuySol: bigint;
  winSellSol: bigint;
  priceHist: number[]; // last 11 trade prices, oldest first
}

// ---- per-position state, built from our own fills ----
interface Held {
  entryPrice: number; // SOL per token, from the buy fill (fees included)
  peak: number; // highest price seen since entry
  entrySlot: number; // slot the buy filled at
  armed: boolean; // trailing stop armed
}


function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n || vq <= 0n) return 0;
  return Number(vq) / Number(vt);
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const p = params;
  // Per-instance state: a fresh strategy object starts with a blank tape.
  const flows = new Map<Pubkey, Flow>();
  const held = new Map<Pubkey, Held>();

  function flowFor(mint: Pubkey): Flow {
    let f = flows.get(mint);
    if (f === undefined) {
      f = {
        firstPrice: 0,
        peak: 0,
        lastPrice: 0,
        trades: 0,
        buySol: 0n,
        sellSol: 0n,
        firstSlot: 0,
        entered: false,
        recent: [],
        recentBuySol: 0n,
        recentSellSol: 0n,
        win20: [],
        winBuySol: 0n,
        winSellSol: 0n,
        priceHist: [],
      };
      flows.set(mint, f);
    }
    return f;
  }

  function noteFill(fill: Fill): void {
    try {
      if (fill.status !== 'filled') return;
      if (fill.side === 'buy') {
        const tokens = BigInt(fill.token_amount);
        const quote = BigInt(fill.quote_lamports);
        if (tokens <= 0n || quote <= 0n) return;
        const entryPrice = Number(quote) / Number(tokens);
        if (!Number.isFinite(entryPrice) || entryPrice <= 0) return;
        held.set(fill.mint, { entryPrice, peak: entryPrice, entrySlot: fill.slot, armed: false });
        flowFor(fill.mint).entered = true;
      } else {
        held.delete(fill.mint);
      }
    } catch (err) {
      console.error(`fill handling failed for ${fill.mint}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function onBatch(state: StrategyState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  try {
    // 1. Fold this batch's fills into position state.
    for (const fill of batch.fills) noteFill(fill);

    // 2. Fold this batch's events into per-mint flow state.
    for (const event of batch.events) {
      try {
        if (event.event === 'CreateEvent') {
          const f = flowFor(event.mint);
          const p = priceOf(BigInt(event.virtual_sol_reserves), BigInt(event.virtual_token_reserves));
          if (p > 0 && f.firstPrice === 0) {
            f.firstPrice = p;
            f.peak = p;
            f.lastPrice = p;
          }
          if (f.firstSlot === 0) f.firstSlot = event.slot;
        } else if (event.event === 'TradeEvent') {
          const f = flowFor(event.mint);
          const p = priceOf(BigInt(event.virtual_quote_reserves), BigInt(event.virtual_token_reserves));
          if (p > 0) {
            if (f.firstPrice === 0) {
              f.firstPrice = p;
              f.peak = p;
            }
            f.lastPrice = p;
            if (p > f.peak) f.peak = p;
          }
          f.trades += 1;
          const amount = BigInt(event.sol_amount);
          if (event.is_buy) f.buySol += amount;
          else f.sellSol += amount;
          f.recent.push({ buy: event.is_buy, sol: amount });
          if (event.is_buy) f.recentBuySol += amount;
          else f.recentSellSol += amount;
          if (f.recent.length > 10) {
            const old = f.recent.shift()!;
            if (old.buy) f.recentBuySol -= old.sol;
            else f.recentSellSol -= old.sol;
          }
          f.win20.push({ buy: event.is_buy, sol: amount });
          if (event.is_buy) f.winBuySol += amount;
          else f.winSellSol += amount;
          if (f.win20.length > 20) {
            const old20 = f.win20.shift()!;
            if (old20.buy) f.winBuySol -= old20.sol;
            else f.winSellSol -= old20.sol;
          }
          if (p > 0) {
            f.priceHist.push(p);
            if (f.priceHist.length > 11) f.priceHist.shift();
          }
          if (f.firstSlot === 0) f.firstSlot = event.slot;
        }
        // CompleteEvent: the harness closes any position itself; nothing to track.
      } catch (err) {
        console.error(`event handling failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 3. Reconcile: drop held records for positions the account no longer shows
    // (harness closes on complete/flatten), and adopt any position we hold without
    // a record (e.g. a fill arrived in an unexpected shape) at the current mark.
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }
    for (const [mint, pos] of state.positions) {
      if (!held.has(mint)) {
        const curve = state.curves.get(mint);
        const mark = curve !== undefined ? priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves) : 0;
        if (mark > 0) {
          held.set(mint, { entryPrice: mark, peak: mark, entrySlot: batch.slot, armed: false });
        }
      }
    }

    const maxOrders = state.hello.caps.max_orders_per_batch;
    const txFee = state.txFeeLamports();

    // 4. Exits first: every held position is checked against all four exit rules.
    const pendingSell = new Set<Pubkey>();
    const pendingBuy = new Set<Pubkey>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
      else pendingBuy.add(p.order.mint);
    }
    for (const [mint, h] of [...held.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (orders.length >= maxOrders) break;
      if (pendingSell.has(mint)) continue;
      const pos = state.positions.get(mint);
      if (pos === undefined || pos.token_amount <= 0n) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;
      if (price > h.peak) h.peak = price;
      if (price >= h.entryPrice * p.trailArm) h.armed = true;

      let exit = false;
      if (price >= h.entryPrice * p.takeProfit) exit = true;
      else if (price <= h.entryPrice * p.stopLoss) exit = true;
      else if (h.armed && price <= Math.max(h.entryPrice * p.trailLock, h.peak * p.trailPeakFraction)) exit = true;
      else if (batch.slot - h.entrySlot >= p.maxHoldSlots) exit = true;

      if (exit) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SLIPPAGE_BPS });
        pendingSell.add(mint);
      }
    }

    // 5. Entries: scan qualifying mints in sorted order for determinism.
    const maxPositions = state.hello.caps.max_open_positions;
    if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length < maxPositions) {
      const candidates: Pubkey[] = [];
      for (const [mint, f] of flows) {
        if (f.entered || state.positions.has(mint) || pendingBuy.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (f.trades < p.minTrades) continue;
        if (f.firstPrice <= 0 || f.lastPrice <= 0) continue;
        const realSol = Number(curve.real_quote_reserves) / 1e9;
        if (realSol < p.minRealSol || realSol > p.maxRealSol) continue;
        const total = f.buySol + f.sellSol;
        if (total <= 0n) continue;
        const buyShare = Number(f.buySol) / Number(total);
        if (buyShare < p.minBuyShare) continue;
        const recentTotal = f.recentBuySol + f.recentSellSol;
        if (recentTotal > 0n && Number(f.recentBuySol) / Number(recentTotal) < p.minRecentBuyShare) continue;
        const rise = f.lastPrice / f.firstPrice;
        if (rise < p.minRise || rise > p.maxRise) continue;
        if (f.lastPrice < f.peak * p.minOfPeak) continue;
        // Bottom-fishing (only when useDip): it ran up first, then pulled
        // back deep, sellers dried up over the last 20 trades, and the price
        // stopped falling.
        if (p.useDip) {
          if (f.peak / f.firstPrice < p.minPeakRise) continue;
          const dip = f.lastPrice / f.peak;
          if (dip < p.dipLo || dip > p.dipHi) continue;
          const winTotal = f.winBuySol + f.winSellSol;
          if (winTotal > 0n && Number(f.winSellSol) / Number(winTotal) > p.maxSellShare) continue;
          if (f.priceHist.length >= 11 && f.lastPrice < f.priceHist[0] * p.firmFactor) continue;
        }
        candidates.push(mint);
      }
      candidates.sort();
      for (const mint of candidates) {
        if (orders.length >= maxOrders) break;
        if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= maxPositions) break;
        const cap = state.maxBuyLamports(mint);
        if (cap <= 0n) continue;
        let stake = (cap * BigInt(p.stakeFractionOfCapBps)) / 10000n;
        if (stake > p.stakeMaxLamports) stake = p.stakeMaxLamports;
        if (stake < p.stakeMinLamports) continue;
        // Keep enough cash for this buy plus the tx fees of the buy and its eventual sell.
        if (stake + txFee * 2n > state.freeCashLamports()) continue;
        orders.push({ side: 'buy', mint, quote_lamports: stake, max_slippage_bps: SLIPPAGE_BPS });
      }
    }
  } catch (err) {
    // Never crash the run: log and answer with whatever orders were built so far.
    console.error(`onBatch failed at seq ${batch.seq}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return orders;
}
  return { onBatch };
}
