import type { AddSignerByAddress } from '../../../../src/core/proposal-filing.js';
import type { Proposal, ProposalStatus, Role, SealedProposal } from '../../../../src/core/types.js';
import { READ, type Read } from './reads.js';

/**
 * Where a signer stands, as this device reads it. `accepted`: they took the invitation and the roster holds them pending, so
 * they wait for a signer to finish adding them. A signer who has not `accepted` is seated only when `seatOnChain`: the roster
 * names them active and the account holds their seat on the chain; active with no seat on the chain is neither. `you`: this
 * is the seat whose keys this device holds, told by its seat id and signing key together, never by a name. `entryFiled`: whether the
 * company's directory, as this device read it, holds an entry for their seat; null when it was not read or they have no seat.
 */
export interface SignerStanding {
  id: string;
  name: string;
  accepted: boolean;
  seatOnChain: boolean;
  you: boolean;
  entryFiled: boolean | null;
}

/** What the account's holders carry of the signers' seats, as the person's own wallet read them off the chain. */
export interface ChainSeats {
  readonly seats: readonly string[];
  readonly approvals: number;
  readonly vaultThresholds?: readonly { readonly vault: string; readonly threshold: number }[];
  readonly policyBar?: number | null;
  readonly seatBar: number;
  readonly adoptedVaults: readonly string[];
}

interface RosterSigner {
  readonly id: string;
  readonly name: string;
  readonly status: 'active' | 'pending';
  readonly leafCommitment: string | null;
  readonly signingPublicKey?: string;
}

/**
 * Each signer of the believed roster as accepted (pending) or not, and whether the chain holds their leaf. `here.own` is the
 * seat id and signing key of the seat this device holds for the company: a row is you only when it carries both, so a second
 * row a filer put under the same key is never marked as you. `here.entries` the seats the
 * company's directory holds an entry for, as this device read it, or null when it was not read.
 */
export function signerStandings(
  signers: readonly RosterSigner[], seatsOnChain: readonly string[],
  here: { readonly own?: { readonly signerId: string; readonly signingPublicKey: string } | null; readonly entries?: ReadonlySet<string> | null } = {},
): SignerStanding[] {
  const held = new Set(seatsOnChain.map((s) => s.toLowerCase()));
  const own = here.own == null ? null : { id: here.own.signerId, key: here.own.signingPublicKey.toLowerCase() };
  const entries = here.entries ?? null;
  return signers.map((s) => {
    const leaf = typeof s.leafCommitment === 'string' ? s.leafCommitment.toLowerCase() : null;
    return {
      id: s.id, name: s.name, accepted: s.status === 'pending',
      seatOnChain: leaf !== null && held.has(leaf),
      you: own !== null && s.id === own.id && typeof s.signingPublicKey === 'string' && s.signingPublicKey.toLowerCase() === own.key,
      entryFiled: entries === null || leaf === null ? null : entries.has(leaf),
    };
  });
}

/**
 * The approvals a change of who is seated needs: the account's seat bar as its wallet read and checked it. `vaultsAtThatNumber`
 * lists the adopted vaults whose own threshold is that number; it does not say any of them set it, because a policy band or a
 * change of the bar may have. `raisedAboveTheAccount` says the bar is higher than the account's own threshold.
 */
export interface SignersApprovals {
  readonly count: number;
  readonly raisedAboveTheAccount: boolean;
  readonly vaultsAtThatNumber: readonly string[];
}

/**
 * The count is the seat bar the wallet read (`seatBar`), never the threshold: a change of signers short of it is refused by
 * the account. Unreadable when the bar is missing or is not a whole number of one or more, or is below the threshold.
 */
export function approvalsForSigners(g: Pick<ChainSeats, 'approvals' | 'seatBar' | 'vaultThresholds' | 'adoptedVaults'>): Read<SignersApprovals> {
  const bar = g.seatBar;
  if (!Number.isSafeInteger(bar) || bar < 1 || !Number.isSafeInteger(g.approvals) || bar < g.approvals) return { of: READ.unreadable };
  const adopted = new Set((g.adoptedVaults ?? []).map((v) => v.toLowerCase()));
  const vaults = (g.vaultThresholds ?? []).filter((v) => v.threshold === bar && adopted.has(v.vault.toLowerCase())).map((v) => v.vault);
  return { of: READ.read, value: { count: bar, raisedAboveTheAccount: bar > g.approvals, vaultsAtThatNumber: vaults } };
}

/**
 * A signer invited by their private address, as the company's proposals carry it: the proposal's record id, whom it invites, with
 * which role (the signed terms'), at which address and with which rights, the coin key of that address (null when the proposal
 * carries none, and then no approval of it can be made), where the service says the proposal stands, how many approvals the chain
 * counts (null: nothing a page reads gives the count of one proposal, and the sealed list and the service's number are not it), and
 * the seat the chain says the proposal took, if any. Everything an approval is asked with is here, because the wallet checks it against
 * the proposal itself. Only the chain's word that the proposal took a seat hides Approve; the wallet still refuses an approval the chain
 * does not owe.
 */
export interface SignerInvited {
  readonly proposal: string;
  readonly name: string;
  readonly role: Role;
  readonly address: string;
  readonly scope: string;
  readonly coinKey: string | null;
  readonly status: ProposalStatus;
  readonly approvals: number | null;
  /**
   * The seat the chain says this proposal took, read through the person's own indexer, with the roster's entry waiting at that
   * seat (null when none waits there yet); null when the chain shows no seat taken by it, or could not be read.
   */
  readonly seat: { readonly signer: string | null } | null;
}

/**
 * Each proposal that invites a signer by address and still waits, in the order the service listed them; every other proposal
 * is left out. `here` is what this device read beside them: the seat the chain says each proposal took, by its identity on the
 * chain (`taken`), the believed roster's entries waiting to be admitted (`waiting`) and its active signers (`seated`). An
 * entry counts only at the very seat the chain says the proposal took, so an entry nobody checked, naming the proposal,
 * changes nothing here. An invitation whose seat the chain shows taken and the believed roster holds active is finished, and
 * is left out: the service never marks it so.
 */
export function signersInvitedIn(
  proposals: readonly { readonly rec: SealedProposal; readonly opened: Proposal }[],
  open: (rec: SealedProposal) => AddSignerByAddress | null,
  here: {
    readonly taken: Readonly<Record<string, string | null>>;
    readonly waiting: readonly { readonly id: string; readonly leafCommitment: string | null }[];
    readonly seated?: readonly { readonly leafCommitment: string | null }[];
  } = { taken: {}, waiting: [] },
): SignerInvited[] {
  const low = (x: string): string => x.toLowerCase();
  const taken = new Map(Object.entries(here.taken).map(([k, v]) => [low(k), typeof v === 'string' ? low(v) : null]));
  return proposals.flatMap(({ rec, opened }) => {
    const body = open(rec);
    const invite = body?.invited.terms.invite;
    if (body === null || invite === undefined) return [];
    const leaf = taken.get(low(body.chainId)) ?? null;
    if (leaf !== null && (here.seated ?? []).some((s) => typeof s.leafCommitment === 'string' && low(s.leafCommitment) === leaf)) return [];
    const entry = leaf === null ? undefined : here.waiting.find((w) => typeof w.leafCommitment === 'string' && low(w.leafCommitment) === leaf);
    return [{
      proposal: rec.id, name: body.invited.terms.name, role: body.invited.terms.role, address: invite.address, scope: invite.scope, coinKey: body.coinPublicKey,
      status: opened.status, approvals: null,
      seat: leaf === null ? null : { signer: entry?.id ?? null },
    }];
  });
}
