/**
 * A COMPANY'S LABEL, AND THE TWO KINDS OF CONTRACT ADDRESS IT IS NEVER
 * MISTAKEN FOR.
 *
 * ── WHAT THE LABEL IS ────────────────────────────────────────────────────
 *
 * **Every key a signer holds for a company is derived from the company's
 * label**: the committee key, the key that opens the company's records, and
 * everything derived from that one. The label is thirty-two random bytes,
 * drawn once, by the wallet of the person creating the company (its founding
 * signer), before the company's account exists. Every other signer, including
 * one who joins years later, derives their own keys from the same label in
 * their own wallet.
 *
 * **The account's constructor writes the label into the account itself**, as
 * one entry in its shared map of roles, so it survives on the chain for as long
 * as the account does and a wallet can read it back without trusting anybody's
 * service. A later account for the same company carries the same label, so the
 * company's keys survive a new account version.
 *
 * ── WHY NOT THE ACCOUNT'S ADDRESS ────────────────────────────────────────
 *
 * An address exists only after the account is deployed, so a company named by
 * its address cannot have keys before it has an account, and one value was
 * doing two jobs: naming the company and locating a contract. The label names
 * the company. The address locates the account, and is still what every chain
 * read and every vault's pin uses.
 *
 * **The label is not secret.** It is a name, like the address was. What makes
 * a key private is the recovery words it is derived with.
 *
 * ── ONE SPELLING, WHICH NO ADDRESS HAS ───────────────────────────────────
 *
 * `co_` followed by sixty-four lower-case hex characters, and nothing else: not
 * folded, not trimmed. A contract address is sixty-four hex characters with no
 * prefix. **So a label handed to a check that wants an address is refused by
 * its shape, and an address handed to a check that wants a label is refused by
 * its shape**, at the first check it meets rather than at a door further on.
 * The `_` also keeps it from ever reading as a bech32 address, whose separator
 * is `1`.
 *
 * ── THREE TYPES, SO A MIX-UP DOES NOT BUILD ──────────────────────────────
 *
 * `CompanyLabel`, `AccountAddress` and `VaultAddress` are three distinct types.
 * A value of one cannot be passed where another is wanted without going
 * through that type's reader, so passing a vault's address where the account's
 * is wanted, or an address where a label is wanted, is an error when the code
 * is built. An account address and a vault address are both Midnight's bare
 * sixty-four hex characters on the chain; the types are ours and change
 * nothing there.
 *
 * **This file reaches no WebAssembly**, so the page, the service and the
 * wallet all read labels with this one reader and write them with this one
 * writer.
 */

declare const labelBrand: unique symbol;
declare const accountBrand: unique symbol;
declare const vaultBrand: unique symbol;

/** A company's label: `co_` and sixty-four lower-case hex characters. */
export type CompanyLabel = string & { readonly [labelBrand]: true };

/** The address of a company's account contract, in its lower-case spelling. */
export type AccountAddress = string & { readonly [accountBrand]: true };

/** The address of one of a company's vault contracts, in its lower-case spelling. */
export type VaultAddress = string & { readonly [vaultBrand]: true };

/** The prefix every label is written with. */
export const COMPANY_LABEL_PREFIX = 'co_';

const LABEL = /^co_[0-9a-f]{64}$/u;

/*
 * A contract address as Midnight's own validator accepts it: sixty-four hex
 * characters in either case, no prefix. It is folded to lower case on the way
 * in, because hex has one lower-case spelling and two spellings of one address
 * must never become two companies.
 */
const CONTRACT_ADDRESS = /^[0-9a-fA-F]{64}$/u;

const LABEL_BYTES = 32;

/**
 * **WHERE THE LABEL SITS IN THE ACCOUNT**: the key the account's constructor
 * writes it under in its shared map of roles. The contract derives this value
 * itself and never takes it from a caller; it is written here so a wallet can
 * look the label up without loading the contract, and a test beside the
 * contract holds the two equal.
 */
export const COMPANY_LABEL_ENTRY = 'e5c1cb2519bc5f6bc4a0f779d4f851bec45bdc7127d2a5e6292b508674358903';

export class CompanyLabelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanyLabelError';
  }
}

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * THE READER. A label, or `null` for anything else - including a contract
 * address, a label in upper case, and a label with anything around it.
 */
export function readCompanyLabel(value: unknown): CompanyLabel | null {
  if (typeof value !== 'string' || !LABEL.test(value)) return null;
  /* Thirty-two zero bytes are not a label: the account refuses them. */
  if (/^co_0{64}$/u.test(value)) return null;
  return value as CompanyLabel;
}

/** Whether a value is a label, as `readCompanyLabel` reads one. */
export const isCompanyLabel = (value: unknown): value is CompanyLabel => readCompanyLabel(value) !== null;

/**
 * THE WRITER. Thirty-two bytes, spelled as a label. Anything other than
 * thirty-two bytes, or thirty-two zero bytes, is refused.
 */
export function companyLabelOf(bytes: Uint8Array): CompanyLabel {
  if (!(bytes instanceof Uint8Array) || bytes.length !== LABEL_BYTES) {
    throw new CompanyLabelError(`a company label is ${LABEL_BYTES} bytes, and this is not.`);
  }
  if (bytes.every((b) => b === 0)) {
    throw new CompanyLabelError('thirty-two zero bytes are not a company label; the account refuses them.');
  }
  return `${COMPANY_LABEL_PREFIX}${toHex(bytes)}` as CompanyLabel;
}

/** The label's thirty-two bytes: what the account's constructor is given. */
export function companyLabelBytes(label: CompanyLabel): Uint8Array {
  const read = readCompanyLabel(label);
  if (read === null) throw new CompanyLabelError('that is not a company label.');
  const hex = read.slice(COMPANY_LABEL_PREFIX.length);
  return Uint8Array.from(hex.match(/../gu) ?? [], (x) => Number.parseInt(x, 16));
}

/**
 * **THE DRAW.** Thirty-two bytes from the platform's cryptographic generator.
 * Called by the wallet of the person creating a company, once, and by nothing
 * else in the product: a label the page or the service drew would be a label
 * the service could choose.
 */
export function drawCompanyLabel(
  random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): CompanyLabel {
  const bytes = random(LABEL_BYTES);
  return companyLabelOf(bytes);
}

const addressOf = (value: unknown): string | null =>
  typeof value === 'string' && CONTRACT_ADDRESS.test(value) ? value.toLowerCase() : null;

/** An account's address, folded to lower case, or `null` - including for a label. */
export function readAccountAddress(value: unknown): AccountAddress | null {
  return addressOf(value) as AccountAddress | null;
}

/** A vault's address, folded to lower case, or `null` - including for a label. */
export function readVaultAddress(value: unknown): VaultAddress | null {
  return addressOf(value) as VaultAddress | null;
}
