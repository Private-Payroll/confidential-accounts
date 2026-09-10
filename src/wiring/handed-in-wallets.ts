/**
 * **THE FUNDED PAIR, HANDED TO THE SERVER BY WHOEVER ALREADY HOLDS IT.**
 *
 * The server cannot write to the chain without two wallets: the company's,
 * which balances and signs the parts of a transaction the company owns, and the
 * fee payer's, which pays the fee. **Both can spend**: the company's half signs
 * the company's own coins and the fee payer spends its DUST. **A server does
 * not acquire either by starting up.**
 * Bringing a wallet up means a seed, a proof server, a sync and a wait for DUST,
 * and a web process that did that to itself on boot would be a web process that
 * can spend because it was started.
 *
 * So the server asks this module, once, while it is being evaluated, and this
 * module answers with what it was handed or with `null`.
 *
 * -- WHAT THIS IS NOT --------------------------------------------------------
 *
 * **IT IS NOT A MODE AND IT CANNOT PRODUCE A WALLET.** There is no name to pass,
 * no environment variable, no file it reads and no default. It holds live
 * objects a caller built itself, and the only caller that can build them is one
 * that has already brought two wallets up. A process started the ordinary way
 * reaches this module with nothing handed in and gets `null`, which the supplier
 * answers with a deployment that reads the chain and refuses every write by
 * name.
 *
 * **IT IS NOT CALLED FROM ANYTHING THE SERVER SHIPS.** A test walks every
 * non-test source file under `src/` and refuses any that names the setter
 * other than this one, so the hand-in can only come from a launcher outside the
 * product that brought the wallets up first.
 *
 * -- WHY ORDER MATTERS -------------------------------------------------------
 *
 * **CALLED BEFORE THE SERVER IS IMPORTED.** The server builds its ledger while
 * it is being evaluated, so a pair handed in afterwards arrives after the only
 * read of it and changes nothing. That is the safe direction - a late hand-in
 * leaves a read-only server, never a half-writing one.
 */
import type { FundedParties } from './write-capability-for-deployment.js';

let handed: FundedParties | null = null;

/**
 * Hand the funded pair to this process, before the server is imported.
 *
 * **ONCE.** A second pair would replace the first under a server that has
 * already built its ledger over the first, so the fee payer that pays and the
 * one this process believes it holds would be two different wallets. That is
 * refused rather than resolved.
 */
export function handInFundedParties(parties: FundedParties): void {
  if (!parties || !parties.customer || !parties.sponsor) {
    throw new Error(
      'a funded pair was handed in without both halves. A server holding one wallet can '
      + 'neither balance a company\'s transaction nor pay for it, so nothing is held.');
  }
  if (handed) {
    throw new Error(
      'a funded pair has already been handed to this process. A second one would sit '
      + 'beside a ledger already built over the first, so the wallet that pays and the '
      + 'wallet this process reports would disagree. Nothing was replaced.');
  }
  handed = parties;
}

/** What was handed in, or `null` - which is every process started the ordinary way. */
export function handedInFundedParties(): FundedParties | null {
  return handed;
}
