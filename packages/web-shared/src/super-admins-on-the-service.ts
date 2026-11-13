/**
 * **A CHANGE OF THE SUPER ADMINS, CARRIED BY THE COMPANY'S SERVICE RATHER THAN BY A FILE.**
 *
 * The super admin who raises a change signs its bytes with the key the chain lists on the account's committee, and the
 * service keeps the change with that signature; each joining key signs it with its own key and the service keeps that
 * too; every super admin's device reads the change from the service, checks it against the chain itself
 * (`governance-from-the-chain.ts`) and posts the update signatures its wallet makes. Nothing here is believed for
 * being on the service: a change read back is checked again like any other.
 */
import { superAdminChangeBytes } from 'midnight-identity/profile/committee-sign';
import { readAccountAddress, readCompanyLabel } from 'midnight-identity/profile/company-label';
import type { SuperAdminChangeOnTheWire } from 'midnight-identity/profile/request';
import { PROPOSAL_FILE_FORMAT, type ProposalFile, type SuperAdminSignature } from './proposal-file.js';
import type { SuperAdminDoors } from './super-admin-change.js';
import { sameCommitteeKey } from '../../../src/midnight/vault-committee.js';

type Key = { readonly tag: string; readonly value: string };

/** A change of the super admins as the service keeps it and hands it back. */
export interface KeptChange {
  readonly chainId: string;
  readonly company: string;
  readonly salt: string;
  readonly change: SuperAdminChangeOnTheWire;
  readonly raisedBy: { readonly key: Key; readonly signature: string };
  readonly joined: ReadonlyArray<{ readonly key: Key; readonly signature: string }>;
}

/** What a device asks of the company's service about a change of the super admins. */
export interface SuperAdminService {
  readonly raise: (body: { company: string; salt: string; change: SuperAdminChangeOnTheWire; raisedBy: { key: Key; signature: string } }) => Promise<unknown>;
  readonly join: (body: { chainId: string; joined: { key: Key; signature: string } }) => Promise<unknown>;
  readonly kept: () => Promise<readonly KeptChange[]>;
  readonly keepSignatures: (body: { to: { committee: readonly Key[]; threshold: number }; signatures: readonly SuperAdminSignature[] }) => Promise<unknown>;
}


/** The refusal a super admin meets when the change it raises takes its own key off. */
export class RaiserLeaves extends Error {
  constructor() {
    super('this change takes your own key off the company\'s contracts, so another super admin raises it. If you are the only one, '
      + 'first raise a change that adds the other key and keeps yours; once it lands, the new super admin raises the change that removes yours. Nothing was raised');
    this.name = 'RaiserLeaves';
  }
}

/** A kept change as the file every device's doors read: the same checks run on it as on any file. */
export const keptChangeFile = (kept: KeptChange, account: string): ProposalFile => ({
  format: PROPOSAL_FILE_FORMAT, company: kept.company, account: account.toLowerCase(), change: kept.change, salt: kept.salt,
  chainId: kept.chainId, summary: '', joined: kept.joined.map((j) => ({ key: { tag: j.key.tag, value: j.key.value }, signature: j.signature })),
});

/**
 * **THE RAISER SIGNS ITS CHANGE AND THE SERVICE KEEPS IT.** The raiser's wallet signs the change's bytes with its key
 * for the company, through the press a key on the new committee signs a change with. A change that takes the raiser's
 * own key off is refused here: that key could not sign it, and another super admin raises it.
 */
export async function keepRaisedChange(doors: SuperAdminDoors, service: SuperAdminService, file: ProposalFile): Promise<void> {
  const change = file.change as SuperAdminChangeOnTheWire;
  const company = readCompanyLabel(file.company);
  const account = readAccountAddress(file.account);
  if (company === null || account === null) throw new Error('the change does not name the company by its label and its account. Nothing was raised');
  const mine = await doors.wallet.key({ company, account });
  if (!change.committee.some((k) => sameCommitteeKey(k, mine))) throw new RaiserLeaves();
  const bytes = superAdminChangeBytes(company, account, file.salt, change);
  const signed = await doors.wallet.signJoin({ company, account, salt: file.salt, change, bytes });
  if (!sameCommitteeKey(signed.signer, mine) || !(await doors.ledger.joinedBy(bytes, mine, signed.signature.toLowerCase()))) {
    throw new Error('the wallet did not sign this change with the key it gives for this company, so nothing was kept. Nothing was raised');
  }
  await service.raise({ company, salt: file.salt, change, raisedBy: { key: { tag: mine.tag, value: mine.value.toLowerCase() }, signature: signed.signature.toLowerCase() } });
}

/** A joining key's signature, made on its device from a kept change, handed to the service to keep with the change. */
export async function keepJoin(service: SuperAdminService, before: ProposalFile, after: ProposalFile, mine: Key): Promise<void> {
  const signed = (after.joined ?? []).find((j) => sameCommitteeKey(j.key, mine));
  if (signed === undefined) throw new Error('your wallet\'s signature is not in the change. Nothing was kept');
  if ((before.joined ?? []).some((j) => sameCommitteeKey(j.key, mine) && j.signature === signed.signature)) return;
  await service.join({ chainId: after.chainId, joined: { key: { tag: signed.key.tag, value: signed.key.value }, signature: signed.signature } });
}

/** The update signatures an approval added, handed to the service so the next super admin's device collects them. */
export async function keepApproval(service: SuperAdminService, before: ProposalFile, after: ProposalFile): Promise<void> {
  const had = new Set((before.signatures ?? []).map((s) => `${s.address}/${s.counter}/${s.index}`));
  const added = (after.signatures ?? []).filter((s) => !had.has(`${s.address}/${s.counter}/${s.index}`));
  if (added.length === 0) return;
  const change = after.change as SuperAdminChangeOnTheWire;
  await service.keepSignatures({ to: { committee: change.committee, threshold: change.threshold }, signatures: added });
}
