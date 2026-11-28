/**
 * **THE VAULTS A SIGNER'S REMOVAL REACHES, BEYOND THE ONES THE ACCOUNT HOLDS NOW.** A vault the company retired still
 * holds what it held, and it pays out once adopted again, so its private money needs a secret some signer who stays
 * can open, as does any vault whose last secret change is half written, whose payouts wait on copies of that secret
 * only a signer who reads it can write. Two things follow, both read from the chain through this wallet's own indexer and from the company's records
 * this wallet opens: after a removal, a retired vault whose secret is still kept has it changed with the others
 * (`retiredVaultsKeptHere`, retired-vaults-here.ts); and a removal is refused, naming the vault, when it would leave a
 * vault's private money, or the copies a vault's payouts wait on, in the reach of no signer who stays
 * (`refuseAStrandedSecretHere`), judged when the removal is
 * carried out, by records keys, so a seat taken again with a new key counts as a seat that left, and a seat whose own
 * removal is approved counts as leaving.
 */
import type { Hex } from '../../../../src/core/crypto.js';
import type { CompanyReach } from './company-reach.js';
import { retiredVaultsOnChain, secretAtStakeHere, type SecretAtStake } from './retired-vaults-here.js';
import { activeSeatsOnTheChain } from '../../../../packages/web-shared/src/approvers-read.js';
import { leavingBoundariesRead, leavingReadsOf } from './leaving-read-in-the-wallet.js';
import type { StepContext } from './definition.js';
import { RemovalRefused } from './remove-signer.js';
import { vaultDoorsFor, type VaultDoorsReach } from './vault-doors-here.js';

const lower = (x: string): Hex => String(x).toLowerCase() as Hex;

/** What a judgement of a removal reads: each vault reached, what its secret holds at stake, its readers, who stays and who leaves. */
export interface StrandedSecretReads {
  readonly vaults: readonly Hex[];
  /** What the vault's secret holds at stake, from one read of the vault; null when nothing is. */
  readonly atStake: (vault: Hex) => Promise<SecretAtStake | null>;
  /** The records keys the vault's newest secret record is sealed to; null when the company's records hold none. */
  readonly readersOf: (vault: Hex) => Promise<readonly string[] | null>;
  /** The records keys of the signers who stay. */
  readonly staying: readonly string[];
  /** The records key of the signer this removal takes off; null when it is not known, which is judged as a reader. */
  readonly leaver: string | null;
}

/**
 * **THE FIRST VAULT THIS REMOVAL WOULD LEAVE WITH A SECRET NO SIGNER WHO STAYS CAN OPEN**, with what is at stake and
 * why, or null. A vault whose secret holds nothing at stake (`secretAtStakeHere`) is passed; one
 * whose secret record cannot be found is not. A secret no signer who stays reads is this removal's doing only when the
 * signer leaving reads it: when neither does, the removal changes nothing about who can open it, and that vault is passed.
 */
export async function vaultLeftUnopenable(
  reads: StrandedSecretReads
): Promise<{ readonly vault: Hex; readonly stake: SecretAtStake; readonly why: 'no-reader' | 'no-record' } | null> {
  const staying = new Set(reads.staying.map(lower));
  for (const vault of reads.vaults) {
    const stake = await reads.atStake(vault);
    if (stake === null) continue;
    const readers = await reads.readersOf(vault);
    if (readers === null) return { vault, stake, why: 'no-record' };
    const sealedTo = readers.map(lower);
    if (sealedTo.some((k) => staying.has(k))) continue;
    if (reads.leaver === null || sealedTo.includes(lower(reads.leaver))) return { vault, stake, why: 'no-reader' };
  }
  return null;
}

/**
 * The records keys of the signers who stay, and of the one at `leaf`. Who stays is each seat the chain holds now and the
 * company's list names active (`activeSeatsOnTheChain`, as the count of approvers reads it), but the one at `leaf` and
 * every seat whose own removal is approved (`leavingBoundariesRead`, the wallet's one reading of who is leaving), so
 * two removals carried out together each count the other's seat as leaving. A seat the list still names after the
 * chain dropped it is not one who stays. A read of who is leaving that fails throws: it is never taken as nobody leaving.
 */
const whoStaysAndWhoLeaves = async (
  r: CompanyReach,
  leaf: Hex
): Promise<Pick<StrandedSecretReads, 'staying' | 'leaver'>> => {
  const [roster, held, leaving] = await Promise.all([
    r.roster(),
    r.holders(),
    leavingBoundariesRead(leavingReadsOf(r), r.companyKeys)
  ]);
  const seated = new Set(activeSeatsOnTheChain(roster.signers, held.seats).map(lower));
  const approvedToLeave = new Set([...leaving.boundaries.keys()].map(lower));
  const staying = roster.signers
    .filter(
      (s) => s.leafCommitment !== null && seated.has(lower(s.leafCommitment)) && lower(s.leafCommitment) !== lower(leaf)
    )
    .filter((s) => !approvedToLeave.has(lower(s.signingPublicKey)))
    .flatMap((s) => (s.vaultKeys?.recordsKey === undefined ? [] : [lower(s.vaultKeys.recordsKey)]));
  const leaver = roster.signers.find((s) => s.leafCommitment !== null && lower(s.leafCommitment) === lower(leaf))
    ?.vaultKeys?.recordsKey;
  return { staying, leaver: leaver === undefined ? null : lower(leaver) };
};

/**
 * **A REMOVAL THAT WOULD STRAND A VAULT'S PRIVATE MONEY IS REFUSED, NAMING THE VAULT.** Every vault the account holds or
 * retired is read once: one that may hold private money, or whose last secret change is half written, must have its
 * newest secret sealed to a records key of a signer who stays, unless the signer leaving cannot open it either. Refuses, before anything of the carrying out is
 * sent, with what resolves it.
 */
export async function refuseAStrandedSecretHere(
  ctx: StepContext,
  r: CompanyReach,
  reach: VaultDoorsReach,
  leaf: Hex
): Promise<void> {
  const doors = vaultDoorsFor(ctx, r, reach);
  const adopted = (await r.holders()).adoptedVaults.map(lower);
  const vaults = [...adopted, ...(await retiredVaultsOnChain(r))];
  const left = await vaultLeftUnopenable({
    vaults,
    atStake: (vault) => secretAtStakeHere(doors, vault, !adopted.includes(vault)),
    readersOf: async (vault) => {
      const rec = await doors.records('nonce-secret').get(vault);
      return rec === null ? null : rec.wrapped.map((w) => String(w.signerId));
    },
    ...(await whoStaysAndWhoLeaves(r, leaf))
  });
  if (left !== null) throw new RemovalRefused(strandedWords(left));
}

const RAISE_AGAIN =
  'The signer who raised it withdraws it; the signer leaving then takes any action in the company, and their wallet ' +
  'gives a copy of the secret to each seat that lacks one; then the removal is raised again.';

/** Why the removal is refused for `left`, with what resolves it, worded for what is at stake. */
function strandedWords(left: NonNullable<Awaited<ReturnType<typeof vaultLeftUnopenable>>>): string {
  if (left.stake === 'deposits') {
    return left.why === 'no-record'
      ? `the vault ${left.vault} takes deposits and the company's records hold no secret of it this wallet can read, so whether a signer ` +
          'who stays could open what is put into it is not known. Reload and press again.'
      : `removing this signer would leave the vault ${left.vault}, which takes deposits, with a secret sealed to no signer who stays: ` +
          'private money put into it once this signer has left could be paid out by no one, and its secret could not be changed, so ' +
          `this removal cannot be carried out as it stands. ${RAISE_AGAIN}`;
  }
  if (left.stake === 'copies') {
    return left.why === 'no-record'
      ? `the vault ${left.vault} has a change of its secret not yet finished on the network, and the company's records hold no secret of it ` +
          'this wallet can read, so whether a signer who stays could finish it is not known. Reload and press again.'
      : `removing this signer would leave the vault ${left.vault} paying nothing out: a change of its secret is not yet finished on the ` +
          'network, so its payouts wait until a signer who reads the new secret writes its copies, and that secret is sealed to no signer ' +
          `who stays, so once this signer has left no one could write them, and this removal cannot be carried out as it stands. ${RAISE_AGAIN}`;
  }
  return left.why === 'no-record'
    ? `the vault ${left.vault} may hold private money and the company's records hold no secret of it this wallet can read, so whether a ` +
        "signer who stays could still open it is not known. Reload and press again; if it stays, pay the vault's private money out first."
    : `removing this signer would leave the private money in the vault ${left.vault} openable by no signer who stays: its secret is ` +
        'sealed to no signer who stays, so once this signer has left no one could change it or pay it out, and this removal cannot ' +
        `be carried out as it stands. ${RAISE_AGAIN}`;
}
