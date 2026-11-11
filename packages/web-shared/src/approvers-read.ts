/*
 * Who may approve each vault's runs, made from what a device has read: the roster it believes, each seat's rights as its
 * directory entry holds them, and the seats the chain holds. The wallet reads those at its own doors
 * (apps/wallet/src/actions/approvers-here.ts) and the page at its own (apps/web/src/adapters/approvers-on-page.ts);
 * both make the count here, so the check a change must pass (`seatThresholdRefusal`, `thresholdChangeRefusal`, ...)
 * counts the same company on either.
 */
import type { Hex } from '../../../src/core/crypto.js';
import { approverRosterFrom, type ApproverRoster, type SeatRights, type SeatThresholdChange } from '../../../src/core/vault-approvers.js';
import { NO_VAULT_COUNTED } from '../../../src/core/seat-rights.js';

/** A seat of the directory this device believes, as far as the count reads it. */
interface DirectorySeatRead {
  readonly seat: string;
  readonly retired: unknown;
  readonly rights?: SeatRights | undefined;
}

/** Each seat's rights as the directory this device believes holds them, by its leaf. */
export const rightsBelievedIn = (seats: readonly DirectorySeatRead[]): ReadonlyMap<string, SeatRights> =>
  new Map(seats.filter((x) => x.retired === null && x.rights !== undefined).map((x) => [x.seat.toLowerCase(), x.rights!]));

/** The seats the chain holds and the roster names as active, by their leaves. */
export const activeSeatsOnTheChain = (signers: readonly { status: string; leafCommitment: string | null }[], held: readonly string[]): string[] => {
  const onTheChain = new Set(held.map((x) => x.toLowerCase()));
  return signers.filter((x) => x.status === 'active' && x.leafCommitment !== null && onTheChain.has(x.leafCommitment.toLowerCase()))
    .map((x) => x.leafCommitment!);
};

/**
 * Why no count can be made while the roster names no signer for a seat the chain holds (`notBelieved`), such as one
 * waiting for Finish adding: a count without that seat is not the company's. Null when every seat is named.
 */
export const unnamedSeatsRefusal = (account: { readonly notBelieved: readonly string[] }): string | null => {
  const n = account.notBelieved.length;
  if (n === 0) return null;
  return `the company's roster, as this wallet believes it, names no signer for ${n} seat${n === 1 ? '' : 's'} the `
    + 'company\'s account holds on the network, so it cannot count who approves each vault. Nothing was approved. If a '
    + 'signer is waiting for Finish adding, a signer presses it first; then try again.';
};

/**
 * The change a seat invited with a threshold makes, as `seatThresholdRefusal` counts it: the rights the invited seat is
 * given and the approvals the company needs once it is taken.
 */
export const seatAndThreshold = (rights: SeatRights, threshold: number): SeatThresholdChange => ({ kind: 'seatAndThreshold', rights, threshold });

/** The signers removed or replaced since the open run they outran most was raised, and one run open on the chain. */
interface OutrunRead {
  readonly removals: number;
  readonly run: string | null;
  readonly open?: string | null;
}

/**
 * Each seat the chain holds and the roster names, with the rights its directory entry was believed with: what it may
 * approve is read from its own invitation's role and vaults, checked against its leaf, never assumed. A seat whose
 * entry this device does not believe yet is counted as approving on no vault, which can only refuse more: nothing
 * stops for it, so the company can still remove it.
 *
 * With `outrun.removals`, the signers removed since the open run they outran most was raised are counted against every
 * vault the account holds, naming that run: which vault a run pays from is sealed in its record, so the count can only
 * refuse more, never less. For a removal (`removal`), every vault the account holds is counted as holding an open run
 * while any run is open on the chain, so the one approval more the removal adds to every open run is counted, naming a run.
 */
export const approversFrom = (reads: {
  readonly account: { readonly signers: readonly { status: string; leafCommitment: string | null }[] };
  readonly held: {
    readonly seats: readonly string[]; readonly approvals: number;
    readonly vaultThresholds: ReadonlyArray<{ readonly vault: string; readonly threshold: number }>; readonly adoptedVaults: readonly string[];
  };
  readonly companyWide: string;
  readonly rights: ReadonlyMap<string, SeatRights>;
  readonly outrun?: OutrunRead;
  readonly removal?: boolean;
}): ApproverRoster => {
  const { account, held, companyWide: wide, rights: rightsOf } = reads;
  const outrun: OutrunRead = reads.outrun ?? { removals: 0, run: null };
  const since = outrun.removals;
  const counting = reads.removal === true && (outrun.open ?? null) !== null;
  const leaves = activeSeatsOnTheChain(account.signers, held.seats);
  return approverRosterFrom({
    threshold: held.approvals, vaultThresholds: held.vaultThresholds,
    seated: leaves.map((leaf) => ({ leaf, rights: rightsOf.get(leaf.toLowerCase()) ?? NO_VAULT_COUNTED })),
    adoptedVaults: held.adoptedVaults, companyWide: wide,
    ...(since > 0 || counting ? {
      removals: since, openRuns: new Set([...held.adoptedVaults, wide].map((v) => v.toLowerCase() as Hex)), ...(outrun.run === null ? {} : { outrunBy: outrun.run }),
      ...(counting && since === 0 ? { openRun: outrun.open! } : {}),
    } : {}),
  });
};
