/**
 * **A VAULT'S RETIRE, AS THE COMPANY'S FEE PAYER CHECKS IT BEFORE PAYING.** It pays for one transaction that moves no
 * coin and makes exactly two calls: this vault's `retire`, which refuses while the vault holds any money, and the
 * `retireVault` of this company's account that it asks. A retire of another vault, or one asking another account, is
 * never paid for under this vault's route. Before a retire, a vault that once held a public token and now holds none of
 * it is sent one `forgetUnshielded` call of its own to take that token off its list, which its `retire` refuses while
 * any token is on it; that call is paid for alone, moving no coin.
 */
import { bare } from '../midnight/account-deploy.js';
import { callsMovingNothing } from './vault-submission.js';

/** Why a transaction is not this vault's retire under this company's account, or null when it is. */
export function refusalForRetire(tx: unknown, expect: { readonly vault: string; readonly account: string }): string | null {
  const what = 'this vault being retired';
  const read = callsMovingNothing(tx, what);
  if ('refusal' in read) return read.refusal;
  const wanted = [`${bare(expect.vault)}/retire`, `${bare(expect.account)}/retireVault`].sort().join();
  if (read.calls.length !== 2 || [...read.calls].sort().join() !== wanted) {
    return `this is not ${what}: it must retire this vault and ask this company's account to retire it, and nothing `
      + 'else. Nothing was sent.';
  }
  return null;
}

/** Why a transaction is not exactly one `forgetUnshielded` call to this vault moving no coin, or null when it is. */
export function refusalForForgetUnshielded(tx: unknown, expect: { readonly vault: string }): string | null {
  const what = 'a public token being taken off this vault\'s list';
  const read = callsMovingNothing(tx, what);
  if ('refusal' in read) return read.refusal;
  if (read.calls.length !== 1 || read.calls[0] !== `${bare(expect.vault)}/forgetUnshielded`) {
    return `this is not ${what}: it must make exactly one 'forgetUnshielded' call to this vault, and nothing else. `
      + 'Nothing was sent.';
  }
  return null;
}
