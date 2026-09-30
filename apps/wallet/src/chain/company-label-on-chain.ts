import { ContractState } from '@midnightntwrk/ledger-v9';
import { COMPANY_LABEL_ENTRY, companyLabelOf, readAccountAddress } from 'midnight-identity/profile/company-label';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';

/**
 * **THE WALLET READS A COMPANY'S LABEL OFF ITS ACCOUNT ITSELF.**
 *
 * Every key a signer holds for a company is derived from the company's label,
 * and a page asking for keys or a signature names the label and the account it
 * says carries it. Nothing on the chain stops a second account being deployed
 * with a label somebody learned from the first, so a label and an address
 * named together by a page are a claim. **This is where the claim is checked:
 * over this wallet's own connection to the indexer, not the page's and not the
 * page's service.** The account's constructor wrote the label into its shared
 * map of roles when it was deployed, and that entry is what is read here.
 *
 * A read that fails is never an answer. The screens give nothing and sign
 * nothing for an account until this says the account carries the label asked
 * about.
 *
 * **What the indexer learns** is that this wallet asked about that account's
 * address, as it learns from any read; the label is not sent.
 */

/** Where the account's shared map of roles sits among the fields of its public state. */
export const ROLES_FIELD = 13;

export type LabelOnAccount =
  /** The account exists and carries this label. */
  | { readonly of: 'carries'; readonly label: CompanyLabel }
  /** The indexer knows no contract at that address. */
  | { readonly of: 'no-account' }
  /** A contract is there and carries no label: not a company's account as this product deploys one. */
  | { readonly of: 'no-label' }
  /** The read did not come back, or came back as something that is not a contract's state. */
  | { readonly of: 'unreadable'; readonly why: string };

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../gu) ?? [], (x) => Number.parseInt(x, 16));
const ENTRY = bytesOf(COMPANY_LABEL_ENTRY);

/* A field's bytes as the state holds them may have had trailing zero bytes
 * dropped; thirty-two bytes are put back by padding at the end. */
const as32 = (value: unknown): Uint8Array | null => {
  if (!(value instanceof Uint8Array) || value.length > 32) return null;
  const out = new Uint8Array(32);
  out.set(value);
  return out;
};
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * **THE LABEL AN ACCOUNT'S SERIALISED STATE CARRIES**, or `null` when it
 * carries none. Throws when the bytes are not a contract's state, or not one
 * laid out as a company's account is.
 */
export function labelInAccountState(serialized: Uint8Array): CompanyLabel | null {
  const state = ContractState.deserialize(serialized);
  const fields = state.data.state.asArray();
  if (fields === undefined || fields.length <= ROLES_FIELD) {
    throw new Error('that contract\'s state is not laid out as a company\'s account.');
  }
  const roles = fields[ROLES_FIELD]!.asMap();
  if (roles === undefined) throw new Error('that contract\'s state is not laid out as a company\'s account.');
  for (const key of roles.keys()) {
    const k = as32(key.value[0]);
    if (k === null || !same(k, ENTRY)) continue;
    const cell = roles.get(key);
    /* A value that is not a cell is not how this contract writes its label. */
    const inner = cell === undefined ? undefined : (cell.asCell() as ReturnType<typeof cell.asCell> | undefined);
    if (cell !== undefined && inner === undefined) throw new Error('that contract\'s state is not laid out as a company\'s account.');
    const value = inner === undefined ? null : as32(inner.value[0]);
    if (value === null || value.every((b) => b === 0)) return null;
    return companyLabelOf(value);
  }
  return null;
}

/** What the read goes through: the indexer's own answer for one contract, as hex, or null. */
export type ContractStateHex = (account: AccountAddress) => Promise<string | null>;

const QUERY = 'query ($address: HexEncoded!) { contract(address: $address) { state } }';

/** The read through one indexer: the screens pass the one this wallet reads its own balance from. */
export const fromIndexerAt = (indexerUri: string): ContractStateHex => async (account) => {
  const response = await fetch(indexerUri, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { address: account } }),
  });
  if (!response.ok) throw new Error(`the indexer answered ${response.status}.`);
  const body = await response.json() as { data?: { contract?: { state?: unknown } | null }; errors?: unknown };
  if (body.errors !== undefined) throw new Error('the indexer refused the read.');
  const state = body.data?.contract?.state;
  if (state === undefined || state === null) return null;
  if (typeof state !== 'string' || !/^([0-9a-fA-F]{2})+$/u.test(state)) throw new Error('the indexer answered with something that is not a state.');
  return state;
};

/** Reads the label the account at `account` carries. Never throws: a failed read is `unreadable`. */
export async function labelOnAccount(account: AccountAddress, read: ContractStateHex): Promise<LabelOnAccount> {
  if (readAccountAddress(account) === null) return { of: 'unreadable', why: 'that is not an account\'s address.' };
  let hex: string | null;
  try {
    hex = await read(account);
  } catch (e) {
    return { of: 'unreadable', why: e instanceof Error ? e.message : 'the read did not come back.' };
  }
  if (hex === null) return { of: 'no-account' };
  try {
    const label = labelInAccountState(bytesOf(hex));
    return label === null ? { of: 'no-label' } : { of: 'carries', label };
  } catch (e) {
    return { of: 'unreadable', why: e instanceof Error ? e.message : 'the state did not read.' };
  }
}

/** Whether what was read lets a screen give or sign anything for `label` on that account. */
export const accountCarries = (read: LabelOnAccount, label: CompanyLabel): boolean =>
  read.of === 'carries' && read.label === label;
