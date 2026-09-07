import { createContext } from 'react';
import { startBalance } from './balance.js';
import type { BalanceEngine } from './balance.js';
import { startUnshieldedBalance } from './unshielded.js';
import { startDustBalance } from './dust.js';

/**
 * ALL THREE ENGINES, ONE SEAM — the balance is two-sided (shielded
 * and unshielded are different wallets over different keys reading different
 * coins), and the third is DUST, the token fees are paid in, read by
 * its own wallet over its own key. The defaults are the REAL engines — still
 * safe, because nothing invokes an engine until a person presses "Check the
 * balance"; a test that exercises the press provides fakes here.
 */
export interface BalanceEngines {
  readonly shielded: BalanceEngine;
  readonly unshielded: BalanceEngine;
  readonly dust: BalanceEngine;
}

export const BalanceEnginesContext = createContext<BalanceEngines>({
  shielded: startBalance,
  unshielded: startUnshieldedBalance,
  dust: startDustBalance,
});
