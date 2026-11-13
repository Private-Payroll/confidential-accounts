/**
 * **WHICH SHAPE EACH CALL OF A VAULT MUST HAVE BEFORE IT IS PAID FOR**, by the kind of call the device names: one table,
 * read by the company's fee payer before it adds a fee and by the person's wallet before it sends a call straight to
 * the chain. Each check refuses, in words naming what it refuses, a transaction that is not exactly that call of this
 * vault under this company's account. A kind that moves no coin at all is also held, on the wallet's side, to owing
 * nothing but its fee.
 */
import { refusalForMerge, refusalForPayout, refusalForPublicPayout, refusalForSecretCopy, refusalForSetNonceSecret } from './vault-submission.js';
import { refusalForForgetUnshielded, refusalForRetire } from './vault-retire-submission.js';

/** One kind of vault call: whether it moves no coin, and its check, which reads the company's account where `account` is set. */
interface VaultCallRule {
  readonly movesNothing: boolean;
  readonly check: (tx: unknown, vault: string, account: string) => string | null;
  readonly account: boolean;
}

const RULES = {
  'vault-retire': { movesNothing: true, account: true, check: (tx, vault, account) => refusalForRetire(tx, { vault, account }) },
  'vault-forget': { movesNothing: true, account: false, check: (tx, vault) => refusalForForgetUnshielded(tx, { vault }) },
  'vault-secret': { movesNothing: true, account: true, check: (tx, vault, account) => refusalForSetNonceSecret(tx, { vault, account }) },
  'vault-copy': { movesNothing: true, account: false, check: (tx, vault) => refusalForSecretCopy(tx, { vault }) },
  payout: { movesNothing: false, account: true, check: (tx, vault, account) => refusalForPayout(tx, { vault, account }) },
  merge: { movesNothing: false, account: false, check: (tx, vault) => refusalForMerge(tx, { vault }) },
  'public-payout': { movesNothing: false, account: true, check: (tx, vault, account) => refusalForPublicPayout(tx, { vault, account }) },
} as const satisfies Record<string, VaultCallRule>;

/** The kinds of call to one of the company's vaults that are paid for. */
export type VaultCallKind = keyof typeof RULES;

/** Whether `kind` names one of the vault calls the table holds. */
export const isVaultCallKind = (kind: string): kind is VaultCallKind => Object.prototype.hasOwnProperty.call(RULES, kind);

/** Whether a kind of vault call moves no coin at all; every other kind moves only the vault's own coins. */
export const movesNothing = (kind: VaultCallKind): boolean => RULES[kind].movesNothing;

/** Why `tx` is not this kind of call of `vault` under the company's `account`, or null when it is. */
export function vaultCallRefusal(kind: VaultCallKind, tx: unknown, at: { readonly vault: string; readonly account: string | undefined }): string | null {
  const rule: VaultCallRule = RULES[kind];
  if (rule.account && at.account === undefined) return 'it names no account for the vault it calls';
  return rule.check(tx, at.vault, at.account ?? '');
}

