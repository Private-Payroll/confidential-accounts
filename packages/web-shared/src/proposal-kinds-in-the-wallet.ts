/*
 * **EVERY KIND OF PROPOSAL THE WALLET ACTS ON, ONCE, AND WHETHER IT IS EVER WITHDRAWN.** The wallet reads this list to
 * refuse a withdrawal before it opens anything, and to refuse a proposal whose sealed record names another kind than
 * the one shown; the page reads the same list to name the kind it asks the wallet about and to offer a withdrawal only
 * where the wallet would send one. Each kind is keyed by the wallet's own name for it; `sealedAs` is the kind the
 * proposal's sealed record names. A kind with `never` is refused with those words; with `unlessOutrun` too, it is
 * refused only while the chain does not hold it as outrun, which the page cannot see, so the page never offers it.
 */
import { ADOPT_VAULT, PAY_KEY, RETIRE_VAULT, VAULT_SECRET } from '../../../src/core/proposal-filing.js';

/** One kind as the wallet names it: the kind its sealed record names, and the words that refuse its withdrawal. */
export interface KindInTheWallet {
  readonly sealedAs?: string;
  readonly never?: string;
  readonly unlessOutrun?: true;
}

export const KINDS_IN_THE_WALLET: Readonly<Record<string, KindInTheWallet>> = Object.freeze({
  'add-signer': { sealedAs: 'add-signer' },
  removal: { sealedAs: 'remove-signer' },
  threshold: { sealedAs: 'set-threshold' },
  'vault-threshold': { sealedAs: 'set-vault-threshold' },
  'spending-policy': { sealedAs: 'set-spending-policy' },
  'policy-bar': { sealedAs: 'set-policy-bar' },
  payroll: { sealedAs: 'payroll' },
  'one-off': { sealedAs: 'transfer' },
  'adopt-vault': { sealedAs: ADOPT_VAULT, never: 'never-adopt-vault' },
  'vault-secret': { sealedAs: VAULT_SECRET, never: 'never-vault-secret' },
  'retire-vault': { sealedAs: RETIRE_VAULT },
  'pay-key': { sealedAs: PAY_KEY, never: 'never-pay-key', unlessOutrun: true },
  recovery: { never: 'never-recovery' },
});

/** The kind named by the wallet, or null for a name it does not act on. */
export const kindInTheWallet = (named: string): KindInTheWallet | null =>
  (Object.prototype.hasOwnProperty.call(KINDS_IN_THE_WALLET, named) ? KINDS_IN_THE_WALLET[named]! : null);

/** Whether the wallet refuses this kind's withdrawal whatever the chain holds. */
export const neverWithdrawn = (k: KindInTheWallet): boolean => k.never !== undefined && k.unlessOutrun !== true;

const listed = Object.entries(KINDS_IN_THE_WALLET);

/** The wallet's name for each kind of proposal, by the kind its sealed record names. */
export const WALLET_KIND: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  listed.flatMap(([name, k]) => (k.sealedAs === undefined ? [] : [[k.sealedAs, name] as const])),
));

/** The kinds, as their sealed records name them, that a page never offers to withdraw. */
export const NEVER_WITHDRAWN: ReadonlySet<string> = new Set(listed.flatMap(([, k]) => (k.sealedAs !== undefined && k.never !== undefined ? [k.sealedAs] : [])));
