/**
 * WHAT A DEPLOYMENT MUST HOLD BEFORE IT CAN WRITE TO THE CHAIN, IN ONE PLACE,
 * AND THE REFUSAL FOR EACH PIECE IT HAS NOT GOT.
 *
 * Reading a chain needs an indexer. Writing to one needs five further things,
 * and until this file existed they were absent in four different places with
 * four different failures - one a named refusal, one a bare dereference of
 * nothing, one a module that would not load, and one a throw from inside a
 * vendor SDK about a missing argument. **A deployment that cannot write should
 * say which of the five it is short of, once, before anything is staged.**
 *
 * ── WHY IT IS ONE OBJECT AND NOT FIVE PARAMETERS ─────────────────────────
 *
 * Because the honest states are two and not thirty-two. A deployment holding
 * four of the five cannot write; it can only fail later and further in. Making
 * the five arrive together means the boundary above has one question to ask -
 * *have I got this or not* - instead of five, and no path exists on which four
 * of them look like enough.
 *
 * **AND THE ABSENT CASE IS THE ORDINARY ONE, NOT THE ERROR.** A deployment
 * built to watch a chain is a real and useful thing: it reads accounts,
 * balances and rounds, and it has no business holding a funded wallet. So the
 * absence is a value the wiring carries, not an exception it recovers from.
 *
 * ── THE SEAM, AND WHAT IT IS SHAPED FOR ──────────────────────────────────
 *
 * `customer` and `sponsor` are the two halves of paying for a transaction: the
 * customer balances the legs they own and signs; whoever pays the fee balances
 * the fee and submits. They are separate members here for the same reason they
 * are separate objects everywhere else - **they are two parties, and one of
 * them is the only component in the system with spend authority.** Widening
 * this object is how a fee-paying service would be wired in, and it is a change
 * to this file rather than to every write in the product.
 */
import type { MaintenanceAuthorityChoice } from '../midnight/partial-contract.js';
import type { CustomerWallet } from '../midnight/providers.js';
import type { FeeSponsor } from '../midnight/ledger.js';

/**
 * The five, whole. Every field present or the object does not exist - there is
 * no partially write-capable deployment, for the reason a deployment's own
 * facts are all-or-nothing: a partial one reads its missing half from somewhere
 * else.
 */
export interface WriteCapability {
  /**
   * Who may change which proofs the contract accepts, chosen deliberately and
   * never sampled. It is validated at the point of deploying; it is named here
   * because a deployment that has not chosen one cannot open an account, and
   * finding that out at the deploy is finding it out too late to choose.
   */
  readonly maintenanceAuthority: MaintenanceAuthorityChoice;
  /**
   * The compiled contract with its proving and verifier keys.
   *
   * **A WRITE IS A PROOF, AND A PROOF IS AGAINST THIS.** A build that has not
   * got it can still read - reading is a query against a contract somebody else
   * proved - which is exactly why its absence is survivable for a watcher and
   * fatal for a writer.
   */
  readonly compiled: unknown;
  /** Balances the legs the customer owns, and signs them. */
  readonly customer: CustomerWallet;
  /** Balances the fee and submits. The only spend authority in the system. */
  readonly sponsor: FeeSponsor;
  /**
   * Unlocks the private state store at rest.
   *
   * A function rather than a string so the material is fetched when it is
   * needed and is not sitting in a resolved configuration object for the life
   * of the process.
   */
  readonly storagePassword: () => Promise<string>;
}

/** The five, by the name a person would use for each. Order is acquisition order. */
export const WRITE_PARTS = [
  'maintenanceAuthority',
  'circuits',
  'customerWallet',
  'feePayer',
  'privateStateKey',
] as const;

export type WritePart = typeof WRITE_PARTS[number];

/**
 * What each missing piece means, in the product's own terms.
 *
 * **EACH SENTENCE NAMES THE STATE THAT WOULD RESOLVE IT AND NOT A THING TO
 * TYPE**, because the person reading it may be looking at a health route, a
 * server log or a browser console, and the same fact is missing in all three.
 */
const WHAT_IS_MISSING: Record<WritePart, string> = {
  maintenanceAuthority:
    'no maintenance authority has been chosen for this deployment, and one is never '
    + 'sampled: it decides who may change which proofs a contract accepts, which is a '
    + 'decision rather than a setting',
  circuits:
    'the compiled contract this build proves against is not present, so nothing can be '
    + 'proved here even though reading works',
  customerWallet:
    'no wallet is wired to balance the parts of a transaction the company itself owns',
  feePayer:
    'nothing is wired to pay the transaction fee, so there is nothing to pay it with',
  privateStateKey:
    'no key is wired to unlock this deployment\'s private state store, and a write is '
    + 'the only thing that needs it opened',
};

/**
 * **THE RULE, OVER PLAIN BOOLEANS, SO THE REFUSING BRANCH CAN BE READ WITHOUT
 * ARRANGING A WALLET.** A guard whose failure can only be reached by funding
 * something is a guard nobody has ever seen fire.
 *
 * Returns the sentence to refuse with, or `null` when the deployment holds all
 * five.
 */
export function refusalForMissingWrite(
  present: Readonly<Record<WritePart, boolean>>,
): string | null {
  const missing = WRITE_PARTS.filter(p => !present[p]);
  if (missing.length === 0) return null;

  const reasons = missing.map(p => WHAT_IS_MISSING[p]);
  const listed = reasons.length === 1
    ? reasons[0]
    : reasons.slice(0, -1).join('; ') + '; and ' + reasons[reasons.length - 1];

  return `this deployment can read the chain and cannot write to it: ${listed}. `
    + 'Reading an account, its balances and its open rounds works; opening a company, '
    + 'raising, approving, cancelling and changing signers or thresholds do not.';
}

/**
 * The same question asked of a capability rather than of five booleans.
 *
 * **`undefined` IS THE ANSWER FOR A DEPLOYMENT BUILT TO WATCH**, and it is the
 * ordinary case rather than a broken one - so the sentence it produces names
 * all five at once, which is what somebody who has wired none of them needs to
 * read.
 */
export function refusalForCapability(capability: WriteCapability | undefined): string | null {
  if (!capability) {
    return refusalForMissingWrite({
      maintenanceAuthority: false, circuits: false, customerWallet: false,
      feePayer: false, privateStateKey: false,
    });
  }
  /*
   * **THE TWO WITH SPEND AUTHORITY ARE CHECKED FOR WHAT THE WRITE PATH WILL
   * ACTUALLY CALL, NOT FOR BEING PRESENT.**
   *
   * They were checked for truthiness, which an empty object satisfies - so a
   * deployment holding `{}` where the wallet and the fee payer go was judged
   * able to write, and the first thing to notice would have been a
   * dereference of nothing at the moment a transaction was already being paid
   * for. That is the failure this file's own heading says it exists to
   * replace, and for these two members it was forwarding straight into it.
   */
  const has = (o: unknown, ...members: string[]): boolean =>
    !!o && members.every(m => typeof (o as Record<string, unknown>)[m] === 'function');

  return refusalForMissingWrite({
    maintenanceAuthority: !!capability.maintenanceAuthority,
    circuits: capability.compiled !== undefined && capability.compiled !== null,
    customerWallet: has(capability.customer,
      'balanceOwnLegs', 'coinPublicKey', 'encryptionPublicKey'),
    feePayer: has(capability.sponsor, 'addFeeAndFinalise', 'submit', 'capacity'),
    privateStateKey: typeof capability.storagePassword === 'function',
  });
}
