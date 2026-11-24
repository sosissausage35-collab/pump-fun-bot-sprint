// Pump.fun Bot Sprint — "Reserve-Gated Breakout" paper bot (fresh build for @sausage-sosis).
//
// The strategy lives in strategy.ts; this file only wires it to the wire protocol
// (vendor/makefun-bot.ts, a byte-identical copy of the kit SDK sdk/ts/makefun-bot.ts).
// Run by the grader as `node /bot/main.ts` (Node 22+ strip-types).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';
import type { Strategy } from './strategy.ts';

/**
 * Fail fast with a clear message if the strategy object is not a usable bot,
 * instead of letting runBot die later on a cryptic TypeError mid-run.
 */
function assertUsableStrategy(strategy: unknown): asserts strategy is Strategy {
  if (
    typeof strategy !== 'object' ||
    strategy === null ||
    typeof (strategy as Strategy).onBatch !== 'function'
  ) {
    throw new Error('strategy must be an object with a callable onBatch(state, batch)');
  }
}

const strategy = createStrategy();
assertUsableStrategy(strategy);
await runBot(strategy);
